import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const FIXTURE = "请只回复 BILINGUAL_P0_OK";
export const ENGLISH_FIXTURE = "Reply with only BILINGUAL_P0_OK";

export async function discoverGateway() {
  const directory = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  let port = 3425;
  try {
    const settings = JSON.parse(await readFile(join(directory, "magpie/settings.json"), "utf8"));
    port = settings.port ?? port;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("P0_SETTINGS_INVALID");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("P0_PORT_INVALID");
  return `http://127.0.0.1:${port}`;
}

export function validateGateway(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)
    || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("P0_GATEWAY_NOT_LOOPBACK");
  }
  return url.origin;
}

function diagnostic(code, status = 400) {
  return Response.json({ type: "error", error: { type: "invalid_request_error", message: code } }, { status });
}

export async function inspectGateway(gateway, fetcher = fetch, signal = AbortSignal.timeout(5000)) {
  const origin = validateGateway(gateway);
  const hello = await fetcher(`${origin}/api/hello`, { signal, redirect: "error" });
  if (!hello.ok) throw new Error(`P0_HELLO_HTTP_${hello.status}`);
  const identity = await hello.json();
  if (identity.name !== "magpie") throw new Error("P0_NOT_MAGPIE");
  const catalog = await fetcher(`${origin}/v1/models`, {
    headers: { authorization: "Bearer magpie-bilingual-p0" }, signal, redirect: "error",
  });
  if (!catalog.ok) throw new Error(`P0_CATALOG_HTTP_${catalog.status}`);
  const body = await catalog.json();
  if (!Array.isArray(body.data)) throw new Error("P0_CATALOG_INVALID");
  const models = body.data.filter((model) => typeof model.id === "string");
  return {
    version: identity.version,
    modelCount: models.length,
    nativeModels: models.filter((model) => model.id.includes("/")
      && !/^(bilingual|group)\//i.test(model.id)).map((model) => model.id),
    models,
  };
}

export function createProbeFetch({ gateway, targetModel, fetcher = fetch, timeoutMs = 15000 }) {
  const origin = validateGateway(gateway);
  const activeTraces = new Set();
  return async (input, init = {}) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || path !== "/v1/messages") return diagnostic("P0_UNSUPPORTED_ENDPOINT");
    if (request.headers.has("x-bilingual-depth")) return diagnostic("P0_RECURSION_BLOCKED");
    if (typeof targetModel !== "string" || !/^[^/]+\/[^/]+$/.test(targetModel)
      || /^(bilingual|group)\//i.test(targetModel)) {
      return diagnostic("P0_NATIVE_TARGET_REQUIRED");
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
    let body;
    try {
      const raw = await request.text();
      if (raw.length > 1024 * 1024) return diagnostic("P0_REQUEST_TOO_LARGE", 413);
      body = JSON.parse(raw);
    } catch {
      return diagnostic("P0_INVALID_JSON");
    }
    if (!body || !["test", "bilingual/test"].includes(body.model)) return diagnostic("P0_UNKNOWN_MODEL");
    if (!Array.isArray(body.messages) || body.messages.length !== 1
      || body.messages[0].role !== "user" || body.system !== undefined
      || body.tools !== undefined) return diagnostic("P0_FIXED_FIXTURE_ONLY");
    const message = body.messages[0];
    if (message.content === FIXTURE) {
      message.content = ENGLISH_FIXTURE;
    } else if (Array.isArray(message.content)
      && message.content.filter((block) => block?.type === "text").length === 1
      && message.content.every((block) => block?.type === "image"
        || (block?.type === "text" && block.text === FIXTURE))) {
      message.content = message.content.map((block) => block.type === "text"
        ? { ...block, text: ENGLISH_FIXTURE } : block);
    } else {
      return diagnostic("P0_FIXED_FIXTURE_ONLY");
    }
    const trace = request.headers.get("x-bilingual-trace") || randomUUID();
    if (activeTraces.has(trace)) return diagnostic("P0_RECURSION_BLOCKED");
    activeTraces.add(trace);
    try {
      const catalog = await inspectGateway(origin, fetcher, signal);
      if (!catalog.nativeModels.includes(targetModel)) return diagnostic("P0_TARGET_NOT_ENABLED");
      const headers = new Headers({
        "content-type": "application/json",
        authorization: "Bearer magpie-bilingual-p0",
        "anthropic-version": request.headers.get("anthropic-version") || "2023-06-01",
        "x-bilingual-depth": "1",
        "x-bilingual-trace": trace,
      });
      const session = request.headers.get("x-magpie-session");
      if (session) headers.set("x-magpie-session", session);
      const upstream = await fetcher(`${origin}/v1/messages`, {
        method: "POST", headers,
        body: JSON.stringify({ ...body, model: targetModel, max_tokens: 64 }),
        signal, redirect: "error",
      });
      if (!upstream.body) {
        activeTraces.delete(trace);
        return upstream;
      }
      const reader = upstream.body.getReader();
      const cleanup = () => {
        activeTraces.delete(trace);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => { void reader.cancel().catch(() => {}); cleanup(); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) { cleanup(); controller.close(); }
            else controller.enqueue(value);
          } catch (error) {
            cleanup();
            controller.error(error);
          }
        },
        async cancel(reason) { cleanup(); await reader.cancel(reason); },
      });
      return new Response(stream, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
    } catch {
      activeTraces.delete(trace);
      return diagnostic(signal.aborted ? "P0_CANCELLED_OR_TIMEOUT" : "P0_GATEWAY_UNAVAILABLE", 502);
    }
  };
}
