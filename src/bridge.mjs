import { randomUUID } from "node:crypto";
import { configuration } from "./config.mjs";
import { digest, hasChinese, MemoryCache } from "./text.mjs";
import { createTranslator, readLimited } from "./translator.mjs";
import {
  createPreviewResponse,
  passthroughResponse,
  transformAssistantPayload,
  transformRequestBody,
  translateStream,
} from "./protocol.mjs";

const failure = (code, status = 400) => Response.json({
  type: "error", error: { type: "invalid_request_error", message: code },
}, { status });

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
      if (config.previewInput && path.endsWith("/count_tokens")) {
        return Response.json({ input_tokens: 0 }, { headers: { "cache-control": "no-store" } });
      }
      const sessionId = request.headers.get("x-magpie-session") || body.metadata?.user_id;
      const session = typeof sessionId === "string" && sessionId ? digest(sessionId) : "";
      const restoreEnglish = (text) => {
        if (!session) { if (hasChinese(text)) report("history_session_missing"); return text; }
        const previous = history.get(`${session}:${digest(text)}`);
        if (previous === undefined && hasChinese(text)) report("history_miss");
        return previous ?? text;
      };
      await transformRequestBody(body, {
        enable: config.enable,
        inputTranslation: config.inputTranslation,
        translateSystem: config.translateSystem,
        toEnglish: (text) => translate(text, "en", signal, session),
        restoreEnglish,
      });
      body.model = target;
      if (config.previewInput) return createPreviewResponse(body);
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
      const toChinese = async (text) => {
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
        streaming = Boolean(response.body);
        return passthroughResponse(response, outputHeaders, signal, () => controller.abort(), finish);
      }
      if (body.stream) {
        if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
          await response.body?.cancel();
          throw new Error("BILINGUAL_INVALID_SSE_RESPONSE");
        }
        streaming = true;
        return new Response(translateStream(response.body, toChinese, signal, config.maxTextChars, report,
          () => controller.abort(), finish), { status: response.status, headers: outputHeaders });
      }
      const rawPayload = JSON.parse(await readLimited(response, config.maxBodyBytes, signal));
      const result = await transformAssistantPayload(rawPayload, toChinese, report);
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
