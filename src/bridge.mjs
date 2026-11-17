import { randomUUID } from "node:crypto";
import { configuration } from "./config.mjs";
import { digest, hasChinese, MemoryCache } from "./text.mjs";
import { createTranslator, readLimited } from "./translator.mjs";
import { translateStream } from "./sse.mjs";
import { inspectGateway } from "./probe.mjs";

const failure = (code, status = 400) => Response.json({
  type: "error", error: { type: "invalid_request_error", message: code },
}, { status });

function previewResponse(body) {
  const lines = [`预览：将发送给 ${body.model} 的文本（本次未调用工作模型）`, ""];
  if (body.system !== undefined) {
    lines.push("system:");
    lines.push(...previewText(body.system));
  }
  for (const entry of body.messages) {
    lines.push(`${entry.role}:`);
    lines.push(...previewText(entry.content));
  }
  lines.push("", "注：代码保持原文；图片、工具结果等非文本内容未在此处展示，正常对话中会原样转发。排查完成后，请在插件设置中关闭「仅预览发出的译文」，保存并重新加载插件以恢复正常回复。");
  const text = lines.join("\n");
  const result = {
    id: `msg_preview_${randomUUID()}`, type: "message", role: "assistant", model: body.model,
    content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
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
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

function previewText(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return ["[非文本内容]"];
  return content.map((block) => block.type === "text" && typeof block.text === "string"
    ? block.text : `[${block.type ?? "非文本内容"}，未显示]`);
}

export async function createBridge(options, getKey, { fetcher = fetch, logger = console.warn } = {}) {
  const config = await configuration(options);
  const history = new MemoryCache(config.cacheTTL, config.cacheEntries);
  const active = new Set();
  const metrics = {};
  function report(code, data = {}) {
    metrics[code] = (metrics[code] ?? 0) + 1;
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "number" && Number.isFinite(value)) metrics[key] = (metrics[key] ?? 0) + value;
    }
    if (config.logLevel === "info" || config.logLevel === "error" && /failure|fallback|miss|passthrough/.test(code)) {
      logger(JSON.stringify({ component: "bilingual", code, ...data }));
    }
  }
  const translate = createTranslator(config, getKey, fetcher, report);
  async function bridgeFetch(input, init = {}) {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/v1/messages", "/v1/messages/count_tokens"].includes(path)) return failure("BILINGUAL_UNSUPPORTED_ENDPOINT");
    if (request.headers.has("x-bilingual-depth")) return failure("BILINGUAL_RECURSION_BLOCKED");
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(config.timeoutMs)]);
    const trace = request.headers.get("x-bilingual-trace") || randomUUID();
    if (active.has(trace) || active.size >= 100) return failure("BILINGUAL_RECURSION_OR_CAPACITY");
    active.add(trace);
    const finish = () => {
      active.delete(trace);
      signal.removeEventListener("abort", finish);
    };
    signal.addEventListener("abort", finish, { once: true });
    let streaming = false;
    try {
      const body = JSON.parse(await readLimited(request, config.maxBodyBytes, signal));
      if (!body || typeof body.model !== "string" || !Array.isArray(body.messages)) return failure("BILINGUAL_INVALID_REQUEST");
      const alias = body.model.replace(/^bilingual\//, "");
      const target = Object.hasOwn(config.targetModels, alias) ? config.targetModels[alias] : undefined;
      if (!target) return failure("BILINGUAL_UNKNOWN_MODEL");
      const catalog = await inspectGateway(config.gateway, fetcher, signal);
      if (!catalog.nativeModels.includes(target)) return failure("BILINGUAL_TARGET_NOT_ENABLED");
      if (config.previewInput && path.endsWith("/count_tokens")) {
        return Response.json({ input_tokens: 0 }, { headers: { "cache-control": "no-store" } });
      }
      const sessionId = request.headers.get("x-magpie-session") || body.metadata?.user_id;
      const session = typeof sessionId === "string" && sessionId ? digest(sessionId) : "";
      const restore = (text) => {
        if (!session) { if (hasChinese(text)) report("history_session_missing"); return text; }
        const previous = history.get(`${session}:${digest(text)}`);
        if (previous === undefined && hasChinese(text)) report("history_miss");
        return previous ?? text;
      };
      const transformContent = async (content, transform) => {
        if (typeof content === "string") return transform(content);
        if (!Array.isArray(content)) throw new Error("BILINGUAL_INVALID_CONTENT");
        const result = [];
        for (const block of content) {
          if (!block || typeof block.type !== "string") throw new Error("BILINGUAL_INVALID_CONTENT");
          result.push(block.type === "text" && typeof block.text === "string"
            ? { ...block, text: await transform(block.text) } : block);
        }
        return result;
      };
      if (config.enable) {
        for (const message of body.messages) {
          if (message.role === "user" && config.inputTranslation) {
            message.content = await transformContent(message.content, (text) => translate(text, "en", signal, session));
          } else if (message.role === "assistant") {
            message.content = await transformContent(message.content, restore);
          }
        }
        if (config.translateSystem && config.inputTranslation && body.system !== undefined) {
          body.system = await transformContent(body.system, (text) => translate(text, "en", signal, session));
        }
      }
      body.model = target;
      if (config.previewInput) return previewResponse(body);
      const headers = new Headers({
        authorization: "Bearer magpie-bilingual",
        "content-type": "application/json",
        "anthropic-version": request.headers.get("anthropic-version") || "2023-06-01",
        "x-bilingual-depth": "1", "x-bilingual-trace": trace,
      });
      for (const name of ["anthropic-beta", "x-magpie-session"]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      const response = await fetcher(`${config.gateway}${path}`, {
        method: "POST", headers, body: JSON.stringify(body), signal, redirect: "error",
      });
      const outputHeaders = new Headers(response.headers);
      outputHeaders.delete("content-length");
      outputHeaders.delete("content-encoding");
      const output = async (text) => {
        try {
          const result = await translate(text, "zh", signal, session);
          if (session && result !== text) history.set(`${session}:${digest(result)}`, text);
          return result;
        } catch {
          signal.throwIfAborted();
          if (config.outputFallback === "error") throw new Error("BILINGUAL_OUTPUT_TRANSLATION_FAILED");
          report("translation_fallback");
          const result = `${text}\n\n[翻译暂不可用，以上为原文。]`;
          if (session) history.set(`${session}:${digest(result)}`, text);
          outputHeaders.set("x-bilingual-translation-fallback", "true");
          return result;
        }
      };
      if (!response.ok || !config.enable || !config.outputTranslation || path.endsWith("/count_tokens")) {
        const reader = response.body?.getReader();
        if (!reader) return response;
        const abort = () => { void reader.cancel().catch(() => {}); finish(); };
        const cleanup = () => { signal.removeEventListener("abort", abort); finish(); };
        signal.addEventListener("abort", abort, { once: true });
        streaming = true;
        return new Response(new ReadableStream({
          async pull(streamController) {
            try {
              signal.throwIfAborted();
              const next = await reader.read();
              if (next.done) { cleanup(); streamController.close(); }
              else streamController.enqueue(next.value);
            } catch (error) { cleanup(); streamController.error(error); }
          },
          async cancel(reason) { controller.abort(); cleanup(); await reader.cancel(reason); },
        }), { status: response.status, statusText: response.statusText, headers: outputHeaders });
      }
      if (body.stream) {
        if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
          await response.body?.cancel();
          throw new Error("BILINGUAL_INVALID_SSE_RESPONSE");
        }
        streaming = true;
        return new Response(translateStream(response.body, output, signal, config.maxTextChars, report,
          () => controller.abort(), finish), { status: response.status, headers: outputHeaders });
      }
      const result = JSON.parse(await readLimited(response, config.maxBodyBytes, signal));
      if (result.type !== "message" || result.role !== "assistant" || !Array.isArray(result.content)) {
        throw new Error("BILINGUAL_INVALID_RESPONSE");
      }
      for (const block of result.content) {
        if (block.type === "text" && typeof block.text === "string") {
          if (block.citations?.length) report("citations_passthrough");
          else block.text = await output(block.text);
        }
      }
      outputHeaders.set("content-type", "application/json");
      return new Response(JSON.stringify(result), { status: response.status, headers: outputHeaders });
    } catch (error) {
      report("request_failure");
      controller.abort();
      const code = signal.aborted && request.signal.aborted ? "BILINGUAL_CANCELLED"
        : /^BILINGUAL_[A-Z0-9_]+$/.test(error.message) ? error.message : "BILINGUAL_REQUEST_FAILED";
      return failure(code, 400);
    } finally {
      if (!streaming) finish();
    }
  }
  return { fetch: bridgeFetch, config, metrics };
}
