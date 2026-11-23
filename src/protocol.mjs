import { randomUUID } from "node:crypto";

const encoder = new TextEncoder();
const frameFor = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

const ALLOWED_BLOCKS = new Set([
  "text", "thinking", "redacted_thinking", "tool_use", "server_tool_use",
  "web_search_tool_result", "web_fetch_tool_result", "code_execution_tool_result",
  "bash_code_execution_tool_result", "text_editor_code_execution_tool_result",
]);

export async function transformContent(content, transform) {
  if (typeof content === "string") return transform(content);
  if (!Array.isArray(content)) throw new Error("BILINGUAL_INVALID_CONTENT");
  const result = [];
  for (const block of content) {
    if (!block || typeof block.type !== "string") throw new Error("BILINGUAL_INVALID_CONTENT");
    result.push(block.type === "text" && typeof block.text === "string"
      ? { ...block, text: await transform(block.text) }
      : block);
  }
  return result;
}

export async function transformRequestBody(body, { enable, inputTranslation, translateSystem, toEnglish, restoreEnglish }) {
  if (!enable) return;
  for (const message of body.messages) {
    if (message.role === "user" && inputTranslation) {
      message.content = await transformContent(message.content, toEnglish);
    } else if (message.role === "assistant") {
      message.content = await transformContent(message.content, restoreEnglish);
    }
  }
  if (translateSystem && inputTranslation && body.system !== undefined) {
    body.system = await transformContent(body.system, toEnglish);
  }
}

function previewText(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return ["[非文本内容]"];
  return content.map((block) => (block.type === "text" && typeof block.text === "string"
    ? block.text
    : `[${block.type ?? "非文本内容"}，未显示]`));
}

export function createPreviewResponse(body) {
  const lines = [`预览：将发送给 ${body.model} 的文本（本次未调用工作模型）`, ""];
  if (body.system !== undefined) {
    lines.push("system:", ...previewText(body.system));
  }
  for (const entry of body.messages) {
    lines.push(`${entry.role}:`, ...previewText(entry.content));
  }
  lines.push(
    "",
    "注：代码保持原文；图片、工具结果等非文本内容未在此处展示，正常对话中会原样转发。排查完成后，请在插件设置中关闭「仅预览发出的译文」，保存并重新加载插件以恢复正常回复。",
  );
  const text = lines.join("\n");
  const result = {
    id: `msg_preview_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: body.model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  if (!body.stream) return Response.json(result, { headers: { "cache-control": "no-store" } });
  const events = [
    { type: "message_start", message: { ...result, content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(frameFor).join(""), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

export async function transformAssistantPayload(result, toChinese, report) {
  if (result?.type !== "message" || result.role !== "assistant" || !Array.isArray(result.content)) {
    throw new Error("BILINGUAL_INVALID_RESPONSE");
  }
  for (const block of result.content) {
    if (block.type === "text" && typeof block.text === "string") {
      if (block.citations?.length) report("citations_passthrough");
      else block.text = await toChinese(block.text);
    }
  }
  return result;
}

export function passthroughResponse(response, headers, signal, cancelUpstream, finish) {
  const reader = response.body?.getReader();
  if (!reader) return response;
  const cleanup = () => {
    signal.removeEventListener("abort", abort);
    finish();
  };
  const abort = () => {
    void reader.cancel().catch(() => {});
    finish();
  };
  signal.addEventListener("abort", abort, { once: true });
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) {
          cleanup();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        cleanup();
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelUpstream();
      cleanup();
      await reader.cancel(reason);
    },
  }), { status: response.status, statusText: response.statusText, headers });
}

async function* readFrames(body, signal, maxFrameBytes) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index + match[0].length);
        buffer = buffer.slice(match.index + match[0].length);
        yield frame;
      }
      if (buffer.length > maxFrameBytes) throw new Error("BILINGUAL_TEXT_TOO_LARGE");
      if (done) break;
    }
    if (buffer.trim()) throw new Error("BILINGUAL_SSE_TRUNCATED");
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function parseFrame(raw) {
  let eventName = "";
  const data = [];
  for (const line of raw.trimEnd().split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") eventName = value;
    else if (field === "data") data.push(value);
    else if (!["id", "retry"].includes(field)) throw new Error("BILINGUAL_SSE_INVALID_FIELD");
  }
  if (!data.length) return { raw };
  const event = JSON.parse(data.join("\n"));
  if (typeof event?.type !== "string" || (eventName && eventName !== event.type)) {
    throw new Error("BILINGUAL_SSE_MISMATCH");
  }
  return { raw, event };
}

async function* transformSSE(body, translate, signal, maxTextChars, report) {
  let started = false;
  let stopped = false;
  let current;
  let lastIndex = -1;

  for await (const raw of readFrames(body, signal, Math.max(maxTextChars * 8, 65536))) {
    const { event } = parseFrame(raw);
    if (!event || event.type === "ping") { yield raw; continue; }
    if (stopped) throw new Error("BILINGUAL_SSE_AFTER_STOP");
    if (event.type === "error") { yield raw; return; }

    if (event.type === "message_start") {
      if (started || event.message?.role !== "assistant" || event.message.content?.length) {
        throw new Error("BILINGUAL_SSE_INVALID_START");
      }
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
      const { type } = event.content_block;
      if (!ALLOWED_BLOCKS.has(type)) throw new Error("BILINGUAL_SSE_UNKNOWN_BLOCK");
      current = {
        index: event.index,
        type,
        start: event,
        text: event.content_block.text ?? "",
        raw: [raw],
        bytes: raw.length,
        passthrough: Boolean(event.content_block.citations?.length),
      };
      if (type !== "text") yield raw;
      else if (typeof current.text !== "string" || current.text.length > maxTextChars) {
        throw new Error("BILINGUAL_TEXT_TOO_LARGE");
      }
      continue;
    }

    if (event.type === "content_block_delta") {
      if (!current || current.index !== event.index) throw new Error("BILINGUAL_SSE_INVALID_INDEX");
      if (current.type !== "text") {
        const allowed = current.type === "thinking"
          ? ["thinking_delta", "signature_delta"]
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
        } else if (event.delta?.type === "citations_delta") {
          current.passthrough = true;
        } else {
          throw new Error("BILINGUAL_SSE_UNKNOWN_DELTA");
        }
        current.bytes += raw.length;
        if (current.text.length > maxTextChars || current.bytes > maxTextChars * 64) {
          throw new Error("BILINGUAL_TEXT_TOO_LARGE");
        }
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
          if (translated) {
            yield frameFor({
              type: "content_block_delta",
              index: current.index,
              delta: { type: "text_delta", text: translated },
            });
          }
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
  const iterator = transformSSE(body, translate, signal, maxTextChars, report);
  let cancelled = false;
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (cancelled) return;
        if (done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(encoder.encode(value));
        }
      } catch (error) {
        if (cancelled) return;
        const code = /^BILINGUAL_[A-Z0-9_]+$/.test(error.message) ? error.message : "BILINGUAL_STREAM_FAILED";
        report("stream_failure", { reason: code });
        cancel();
        finish();
        controller.enqueue(encoder.encode(frameFor({
          type: "error",
          error: { type: "api_error", message: code },
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
