import { randomBytes, createHash } from "node:crypto";

export const hasChinese = (text) => /\p{Script=Han}/u.test(text);
export const digest = (text) => createHash("sha256").update(text).digest("hex");

export function protect(text) {
  const prefix = `__BP_${randomBytes(8).toString("hex")}_`;
  const values = [];
  const store = (value) => {
    const expanded = value.replace(new RegExp(`${prefix}(\\d+)__`, "g"), (_, index) => values[Number(index)]);
    return `${prefix}${values.push(expanded) - 1}__`;
  };
  let masked = text.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----|<(system-reminder|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g, store);
  masked = masked.replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[ \t]*(?=\n|$)|$)|`+[^`\n]+`+/g, store);
  masked = masked.replace(/(?:^|\n)[ \t]*(?:(?:const|let|var|import|function|class|def|from|return|throw)\s+[^\n]+|[A-Za-z_]\w*\s*=\s*[^\n]+)/g, store);
  masked = masked.replace(/(?:^|\n)(?:[ \t]{4,}\S[^\n]*|[ \t]*(?:(?:if|for|while|switch|catch|with)\s*\([^\n]*|(?:if|for|while|elif|else|try|except|finally)\b[^\n]*:|(?:async\s+)?(?:function|def|class|public|private|protected|interface|struct|enum|fn|func)\b[^\n]*|(?:\/\/|\/\*|\* |# |[{};])[^\n]*|[\w$.]+\s*\([^\n]*))/g, store);
  let previous;
  do {
    previous = masked;
    masked = masked.replace(/\b(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\s*\((?:[^()"'`\n]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)*\)/g, store);
  } while (previous !== masked);
  masked = masked.replace(/\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, store);
  masked = masked.replace(/(?:^|\n)(?:[ \t]*)(?:\$ |> )?(?:npm|pnpm|yarn|bun|git|curl|wget|ssh|sudo|docker|kubectl|node|python3?|pip3?|cd|ls|cat|rm|mkdir|chmod|export)\s+[^\n]+/g, store);
  masked = masked.replace(/\{[^{}]*\}|\[[^\[\]\n]*\]/g, (value) => {
    try { JSON.parse(value); return store(value); } catch { return value; }
  });
  do {
    previous = masked;
    masked = masked.replace(/\{[^{}]*\}|\[[^\[\]\n]*\]/g, (value) => {
      if (!value.includes(prefix)) return value;
      return store(value.replace(new RegExp(`${prefix}(\\d+)__`, "g"), (_, index) => values[Number(index)]));
    });
  } while (previous !== masked);
  masked = masked.replace(/https?:\/\/[^\s<>"'`，。；！？）]+|(?:\/|~\/|[A-Za-z]:\\)[\w./\\@~+\-\p{Script=Han}]+|[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}|(?:sk|ghp|gho|github_pat)-?[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]+|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\$\{[^}]+\}|\$[A-Za-z_]\w*|<[A-Za-z][^>\n]*>|\b[A-Za-z]\w*(?:[._/-][\w.-]+)+\b|\b[a-z]+[A-Z]\w*\b|\b[A-Z][A-Z0-9_]+\b|\b\d+(?:\.\d+)*\b/gu, (value) => value.startsWith(prefix) ? value : store(value));
  const tokens = [...masked.matchAll(new RegExp(`${prefix}\\d+__`, "g"))].map((match) => match[0]);
  return {
    masked,
    plain: masked.replace(new RegExp(`${prefix}\\d+__`, "g"), ""),
    restore(translated) {
      if (typeof translated !== "string" || !translated.trim()) throw new Error("BILINGUAL_EMPTY_TRANSLATION");
      const actual = translated.match(new RegExp(`${prefix}\\d+__`, "g")) ?? [];
      if (actual.length !== tokens.length || tokens.some((token) => actual.filter((found) => found === token).length !== 1)
        || translated.replace(new RegExp(`${prefix}\\d+__`, "g"), "").includes("__BP_")) {
        throw new Error("BILINGUAL_PLACEHOLDER_MISMATCH");
      }
      return translated.replace(new RegExp(`${prefix}(\\d+)__`, "g"), (_, index) => values[Number(index)]);
    },
  };
}

export function splitText(text, limit) {
  const parts = [];
  let remaining = text;
  while (remaining.length > limit) {
    let boundary = remaining.lastIndexOf("\n", limit);
    if (boundary < limit / 2) boundary = remaining.lastIndexOf(" ", limit);
    if (boundary < limit / 2) boundary = limit;
    else boundary += 1;
    const tokenStart = remaining.lastIndexOf("__BP_", boundary);
    if (tokenStart >= 0) {
      const end = remaining.indexOf("__", tokenStart + 5) + 2;
      if (end > boundary) boundary = tokenStart || end;
    }
    if (/[\uD800-\uDBFF]/.test(remaining[boundary - 1])) boundary--;
    parts.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export class MemoryCache {
  constructor(ttl, max) { this.ttl = ttl; this.max = max; this.entries = new Map(); }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) { this.entries.delete(key); return undefined; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key, value) {
    if (!this.max || !this.ttl) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expires: Date.now() + this.ttl });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value);
  }
}
