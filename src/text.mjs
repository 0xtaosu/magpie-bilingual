import { randomBytes, createHash } from "node:crypto";

export const hasChinese = (text) => /\p{Script=Han}/u.test(text);
export const digest = (text) => createHash("sha256").update(text).digest("hex");

// Sequential protection rules ordered from largest structural blocks to inline technical tokens.
const BLOCK_RULES = [
  // PEM keys and system/command XML tags
  /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----|<(system-reminder|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g,
  // Fenced code blocks and inline backtick code
  /(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[ \t]*(?=\n|$)|$)|`+[^`\n]+`+/g,
  // Declarations and assignments
  /(?:^|\n)[ \t]*(?:(?:const|let|var|import|function|class|def|from|return|throw)\s+[^\n]+|[A-Za-z_]\w*\s*=\s*[^\n]+)/g,
  // Indented code lines, control-flow headers, comments, and call lines
  /(?:^|\n)(?:[ \t]{4,}\S[^\n]*|[ \t]*(?:(?:if|for|while|switch|catch|with)\s*\([^\n]*|(?:if|for|while|elif|else|try|except|finally)\b[^\n]*:|(?:async\s+)?(?:function|def|class|public|private|protected|interface|struct|enum|fn|func)\b[^\n]*|(?:\/\/|\/\*|\* |# |[{};])[^\n]*|[\w$.]+\s*\([^\n]*))/g,
];

const CALL_EXPRESSION_RULE = /\b(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\s*\((?:[^()"'`\n]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)*\)/g;
const SECRET_ASSIGNMENT_RULE = /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const SHELL_COMMAND_RULE = /(?:^|\n)(?:[ \t]*)(?:\$ |> )?(?:npm|pnpm|yarn|bun|git|curl|wget|ssh|sudo|docker|kubectl|node|python3?|pip3?|cd|ls|cat|rm|mkdir|chmod|export)\s+[^\n]+/g;
const JSON_FRAGMENT_RULE = /\{[^{}]*\}|\[[^\[\]\n]*\]/g;
const INLINE_TOKEN_RULE = /https?:\/\/[^\s<>"'`，。；！？）]+|(?:\/|~\/|[A-Za-z]:\\)[\w./\\@~+\-\p{Script=Han}]+|[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}|(?:sk|ghp|gho|github_pat)-?[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]+|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\$\{[^}]+\}|\$[A-Za-z_]\w*|<[A-Za-z][^>\n]*>|\b[A-Za-z]\w*(?:[._/-][\w.-]+)+\b|\b[a-z]+[A-Z]\w*\b|\b[A-Z][A-Z0-9_]+\b|\b\d+(?:\.\d+)*\b/gu;

export function protect(text) {
  const prefix = `__BP_${randomBytes(8).toString("hex")}_`;
  const tokenPattern = new RegExp(`${prefix}(\\d+)__`, "g");
  const values = [];
  const expand = (value) => value.replace(tokenPattern, (_, index) => values[Number(index)]);
  const store = (value) => `${prefix}${values.push(expand(value)) - 1}__`;

  let masked = text;
  for (const rule of BLOCK_RULES) masked = masked.replace(rule, store);

  let previous;
  do {
    previous = masked;
    masked = masked.replace(CALL_EXPRESSION_RULE, store);
  } while (previous !== masked);

  masked = masked
    .replace(SECRET_ASSIGNMENT_RULE, store)
    .replace(SHELL_COMMAND_RULE, store)
    .replace(JSON_FRAGMENT_RULE, (value) => {
      try { JSON.parse(value); return store(value); } catch { return value; }
    });

  do {
    previous = masked;
    masked = masked.replace(JSON_FRAGMENT_RULE, (value) => (value.includes(prefix) ? store(value) : value));
  } while (previous !== masked);

  masked = masked.replace(INLINE_TOKEN_RULE, (value) => (value.startsWith(prefix) ? value : store(value)));

  const exactTokenPattern = new RegExp(`${prefix}\\d+__`, "g");
  const expectedTokens = [...masked.matchAll(exactTokenPattern)].map((match) => match[0]);

  return {
    masked,
    plain: masked.replace(exactTokenPattern, ""),
    restore(translated) {
      if (typeof translated !== "string" || !translated.trim()) throw new Error("BILINGUAL_EMPTY_TRANSLATION");
      const actualTokens = translated.match(exactTokenPattern) ?? [];
      const hasExactTokens = actualTokens.length === expectedTokens.length
        && expectedTokens.every((token) => actualTokens.filter((found) => found === token).length === 1);
      const hasStrayMarker = translated.replace(exactTokenPattern, "").includes("__BP_");
      if (!hasExactTokens || hasStrayMarker) {
        throw new Error("BILINGUAL_PLACEHOLDER_MISMATCH");
      }
      return expand(translated);
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
