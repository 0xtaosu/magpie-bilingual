const encoder = new TextEncoder();
const frameFor = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

async function* frames(body, signal, limit) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
        const raw = pending.slice(0, match.index + match[0].length);
        pending = pending.slice(raw.length);
        if (raw.length > limit) throw new Error("BILINGUAL_SSE_FRAME_TOO_LARGE");
        const lines = raw.split(/\r\n|\n|\r/);
        const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) { yield { raw }; continue; }
        const event = JSON.parse(data);
        const name = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
        if (!event || typeof event.type !== "string" || name && name !== event.type) throw new Error("BILINGUAL_SSE_INVALID_EVENT");
        yield { raw, event };
      }
      if (pending.length > limit) throw new Error("BILINGUAL_SSE_FRAME_TOO_LARGE");
      if (done) {
        if (pending.trim()) throw new Error("BILINGUAL_SSE_TRUNCATED");
        break;
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function* transform(body, translate, signal, maxTextChars, report) {
  let started = false;
  let stopped = false;
  let current;
  let lastIndex = -1;
  for await (const frame of frames(body, signal, Math.max(maxTextChars * 6, 1024 * 1024))) {
    const { event, raw } = frame;
    if (!event || event.type === "ping") { yield raw; continue; }
    if (stopped) throw new Error("BILINGUAL_SSE_AFTER_STOP");
    if (event.type === "error") { yield raw; return; }
    if (event.type === "message_start") {
      if (started || event.message?.role !== "assistant" || event.message.content?.length) throw new Error("BILINGUAL_SSE_INVALID_START");
      started = true;
      yield raw;
      continue;
    }
    if (!started) throw new Error("BILINGUAL_SSE_MISSING_START");
    if (event.type === "content_block_start") {
      if (current || !Number.isInteger(event.index) || event.index !== lastIndex + 1 || !event.content_block?.type) {
        throw new Error("BILINGUAL_SSE_INVALID_BLOCK");
      }
      lastIndex = event.index;
      const type = event.content_block.type;
      if (!["text", "thinking", "redacted_thinking", "tool_use", "server_tool_use",
        "web_search_tool_result", "web_fetch_tool_result", "code_execution_tool_result",
        "bash_code_execution_tool_result", "text_editor_code_execution_tool_result"].includes(type)) {
        throw new Error("BILINGUAL_SSE_UNKNOWN_BLOCK");
      }
      current = { index: event.index, type, start: event, text: event.content_block.text ?? "",
        raw: [raw], bytes: raw.length, passthrough: Boolean(event.content_block.citations?.length) };
      if (type !== "text") yield raw;
      else if (typeof current.text !== "string" || current.text.length > maxTextChars) throw new Error("BILINGUAL_TEXT_TOO_LARGE");
      continue;
    }
    if (event.type === "content_block_delta") {
      if (!current || current.index !== event.index) throw new Error("BILINGUAL_SSE_INVALID_INDEX");
      if (current.type !== "text") {
        const allowed = current.type === "thinking" ? ["thinking_delta", "signature_delta"]
          : ["tool_use", "server_tool_use"].includes(current.type) ? ["input_json_delta"] : [];
        if (!allowed.includes(event.delta?.type)) throw new Error("BILINGUAL_SSE_UNKNOWN_DELTA");
        yield raw;
      } else {
        if (event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
          if (Object.keys(event).some((key) => !["type", "index", "delta"].includes(key))
            || Object.keys(event.delta).some((key) => !["type", "text"].includes(key))) {
            throw new Error("BILINGUAL_SSE_UNKNOWN_TEXT_FIELDS");
          }
          current.text += event.delta.text;
        }
        else if (event.delta?.type === "citations_delta") current.passthrough = true;
        else throw new Error("BILINGUAL_SSE_UNKNOWN_DELTA");
        current.bytes += raw.length;
        if (current.text.length > maxTextChars || current.bytes > maxTextChars * 64) throw new Error("BILINGUAL_TEXT_TOO_LARGE");
        current.raw.push(raw);
      }
      continue;
    }
    if (event.type === "content_block_stop") {
      if (!current || current.index !== event.index) throw new Error("BILINGUAL_SSE_INVALID_INDEX");
      if (current.type === "text") {
        if (current.passthrough) {
          report("citations_passthrough");
          yield* current.raw;
        } else {
          const translated = await translate(current.text);
          yield frameFor({ ...current.start, content_block: { ...current.start.content_block, text: "" } });
          if (translated) yield frameFor({ type: "content_block_delta", index: current.index, delta: { type: "text_delta", text: translated } });
        }
      }
      current = undefined;
      yield raw;
      continue;
    }
    if (event.type === "message_delta") {
      if (current) throw new Error("BILINGUAL_SSE_UNCLOSED_BLOCK");
      yield raw;
      continue;
    }
    if (event.type === "message_stop") {
      if (current) throw new Error("BILINGUAL_SSE_UNCLOSED_BLOCK");
      stopped = true;
      yield raw;
      continue;
    }
    throw new Error("BILINGUAL_SSE_UNKNOWN_EVENT");
  }
  if (!stopped) throw new Error("BILINGUAL_SSE_TRUNCATED");
}

export function translateStream(body, translate, signal, maxTextChars, report, cancel, finish) {
  const iterator = transform(body, translate, signal, maxTextChars, report);
  let cancelled = false;
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (cancelled) return;
        if (done) { finish(); controller.close(); }
        else controller.enqueue(encoder.encode(value));
      } catch (error) {
        if (cancelled) return;
        const code = /^BILINGUAL_[A-Z0-9_]+$/.test(error.message) ? error.message : "BILINGUAL_STREAM_FAILED";
        report("stream_failure", { reason: code });
        cancel();
        finish();
        controller.enqueue(encoder.encode(frameFor({
          type: "error", error: { type: "api_error", message: code },
        })));
        controller.close();
      }
    },
    async cancel() {
      cancelled = true;
      cancel();
      await iterator.return();
      finish();
    },
  });
}
