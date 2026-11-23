import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_GATEWAY = "http://127.0.0.1:3425";
const DEFAULT_TRANSLATOR_ORIGIN = "https://api.deepseek.com";
const ALIAS_PATTERN = /^[a-zA-Z0-9][\w.-]*$/;
const TARGET_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const VIRTUAL_PROVIDER_PATTERN = /^(bilingual|group)\//i;

export function validateGateway(url = DEFAULT_GATEWAY) {
  const parsed = new URL(url);
  const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "http:" || !isLoopback || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("BILINGUAL_INVALID_GATEWAY");
  }
  return parsed.origin;
}

export async function discoverGateway() {
  if (process.env.MAGPIE_GATEWAY) return validateGateway(process.env.MAGPIE_GATEWAY);
  try {
    const statePath = join(homedir(), ".local", "state", "magpie", "gateway.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (typeof state.addr === "string" && state.addr) return validateGateway(`http://${state.addr}`);
  } catch {}
  return DEFAULT_GATEWAY;
}

function integer(value, fallback, min, max) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw new Error("BILINGUAL_INVALID_CONFIG");
  return result;
}

export async function configuration(options = {}) {
  const translator = options.translator ?? {};
  if (translator.model !== undefined && (typeof translator.model !== "string" || !translator.model.trim())) {
    throw new Error("BILINGUAL_INVALID_TRANSLATOR_MODEL");
  }
  if ("apiKey" in translator || "key" in translator || "apiKey" in options) {
    throw new Error("BILINGUAL_USE_PROTECTED_AUTH");
  }
  const base = new URL(translator.baseURL ?? DEFAULT_TRANSLATOR_ORIGIN);
  const trustedOrigins = translator.trustedOrigins ?? [DEFAULT_TRANSLATOR_ORIGIN];
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash
    || !Array.isArray(trustedOrigins) || !trustedOrigins.includes(base.origin)) {
    throw new Error("BILINGUAL_UNTRUSTED_TRANSLATOR");
  }

  const targetModels = options.targetModels ?? {};
  if (!targetModels || Array.isArray(targetModels) || typeof targetModels !== "object") {
    throw new Error("BILINGUAL_INVALID_MODELS");
  }
  for (const [alias, target] of Object.entries(targetModels)) {
    if (!ALIAS_PATTERN.test(alias) || typeof target !== "string"
      || !TARGET_PATTERN.test(target) || VIRTUAL_PROVIDER_PATTERN.test(target)) {
      throw new Error("BILINGUAL_INVALID_TARGET");
    }
  }

  for (const key of ["enable", "inputTranslation", "outputTranslation", "translateSystem", "previewInput"]) {
    if (options[key] !== undefined && typeof options[key] !== "boolean") throw new Error("BILINGUAL_INVALID_CONFIG");
  }
  if (!["english", "error"].includes(options.outputFallback ?? "english")) throw new Error("BILINGUAL_INVALID_CONFIG");
  if (!["silent", "error", "info"].includes(options.logLevel ?? "error")) throw new Error("BILINGUAL_INVALID_CONFIG");
  const temperature = translator.temperature ?? 0;
  if (typeof temperature !== "number" || temperature < 0 || temperature > 2) throw new Error("BILINGUAL_INVALID_CONFIG");
  const prices = translator.pricePerMillion ?? { input: 0, output: 0 };
  if (![prices.input, prices.output].every((price) => Number.isFinite(price) && price >= 0)) throw new Error("BILINGUAL_INVALID_CONFIG");
  return {
    enable: options.enable ?? true,
    inputTranslation: options.inputTranslation ?? true,
    outputTranslation: options.outputTranslation ?? true,
    translateSystem: options.translateSystem ?? false,
    previewInput: options.previewInput ?? false,
    targetModels,
    gateway: validateGateway(options.gateway ?? await discoverGateway()),
    timeoutMs: integer(options.timeoutMs, 120000, 100, 600000),
    maxTextChars: integer(options.maxTextChars, 100000, 100, 1000000),
    maxBodyBytes: integer(options.maxBodyBytes, 20 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    cacheTTL: integer(options.cacheTTL, 1800000, 0, 86400000),
    cacheEntries: integer(options.cacheEntries, 256, 0, 10000),
    outputFallback: options.outputFallback ?? "english",
    logLevel: options.logLevel ?? "error",
    translator: {
      baseURL: base.href.replace(/\/$/, ""),
      model: translator.model,
      timeoutMs: integer(translator.timeoutMs, 15000, 100, 120000),
      retries: integer(translator.retries, 1, 0, 3),
      concurrency: integer(translator.concurrency, 3, 1, 16),
      chunkChars: integer(translator.chunkChars, 2000, 100, 8000),
      temperature, prices,
    },
  };
}
