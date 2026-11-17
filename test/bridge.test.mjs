import { test } from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "../src/bridge.mjs";
import { configuration } from "../src/config.mjs";
import { createTranslator } from "../src/translator.mjs";
import { protect, splitText, MemoryCache } from "../src/text.mjs";

const target = "codex/test";
const options = {
  gateway: "http://127.0.0.1:3425",
  targetModels: { test: target },
  translator: { baseURL: "https://translator.example/v1", trustedOrigins: ["https://translator.example"], model: "fixture", retries: 0 },
};
const message = (content = [{ type: "text", text: "Here is the result." }]) => ({
  id: "msg_fixture", type: "message", role: "assistant", model: target,
  content, stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 8 },
});
const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
function streamResponse(events) {
  const bytes = new TextEncoder().encode(events.map(frame).join(""));
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}
const textStream = (text = "Here is the result.") => [
  { type: "message_start", message: { ...message([]), stop_reason: null } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } },
  { type: "message_stop" },
];

async function fixture({ translate, upstream, config = {} } = {}) {
  const calls = { translations: [], upstream: [], logs: [] };
  const bridge = await createBridge({ ...options, ...config }, async () => "synthetic-key", {
    logger: (line) => calls.logs.push(line),
    fetcher: async (url, init) => {
      if (url.endsWith("/api/hello")) return Response.json({ name: "magpie", version: "test" });
      if (url.endsWith("/v1/models")) return Response.json({ data: [{ id: target }] });
      if (url.startsWith("https://translator.example/")) {
        const body = JSON.parse(init.body);
        calls.translations.push(body);
        if (translate) return translate(body, init);
        const english = body.messages[0].content.includes("to English");
        return Response.json({
          choices: [{ finish_reason: "stop", message: { content: english
            ? body.messages[1].content.replace(/请检查|检查/g, "Please inspect").replace(/你好/g, "Hello")
            : body.messages[1].content.replace("Here is the result.", "这是结果。") } }],
          usage: { prompt_tokens: 10, completion_tokens: 7 },
        });
      }
      calls.upstream.push({ body: JSON.parse(init.body), headers: init.headers, signal: init.signal });
      return upstream ? upstream(init) : Response.json(message());
    },
  });
  return {
    ...bridge, calls,
    request: (body = {}, headers = {}, signal) => bridge.fetch("https://bilingual.invalid/v1/messages", {
      method: "POST", headers, signal,
      body: JSON.stringify({ model: "test", max_tokens: 128, messages: [{ role: "user", content: "你好" }], ...body }),
    }),
  };
}

test("JSON roundtrip translates only user and assistant text", async () => {
  const instance = await fixture();
  const image = { type: "image", source: { type: "base64", data: "image-secret", media_type: "image/png" } };
  const toolResult = { type: "tool_result", tool_use_id: "tool-1", content: "不应翻译的日志" };
  const response = await instance.request({
    system: "中文 system 保持不变",
    messages: [{ role: "user", content: [image, { type: "text", text: "请检查 `/tmp/代码.js`", cache_control: { type: "ephemeral" } }, toolResult] }],
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, "这是结果。");
  const forwarded = instance.calls.upstream[0].body;
  assert.equal(forwarded.model, target);
  assert.equal(forwarded.system, "中文 system 保持不变");
  assert.deepEqual(forwarded.messages[0].content[0], image);
  assert.deepEqual(forwarded.messages[0].content[2], toolResult);
  assert.equal(forwarded.messages[0].content[1].text, "Please inspect `/tmp/代码.js`");
  assert.deepEqual(forwarded.messages[0].content[1].cache_control, { type: "ephemeral" });
  assert.ok(!JSON.stringify(instance.calls.translations).includes("image-secret"));
  assert.ok(!JSON.stringify(instance.calls.translations).includes("代码.js"));
  assert.equal(instance.metrics.translation_call, 2);
});

test("preview shows translated text without sending messages or token counts to target", async () => {
  const instance = await fixture({ config: { previewInput: true, logLevel: "info" } });
  const image = { type: "image", source: { type: "base64", data: "image-secret", media_type: "image/png" } };
  const body = { system: "中文 system", messages: [{ role: "user", content: [
    image, { type: "text", text: "你好 `代码`" }, { type: "tool_result", tool_use_id: "tool-1", content: "秘密" },
  ] }] };
  const response = await instance.request(body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = (await response.json()).content[0].text;
  assert.match(text, /Hello `代码`/);
  assert.match(text, /system:\n中文 system/);
  assert.match(text, /\[image，未显示\]/);
  assert.ok(!text.includes("image-secret"));
  assert.ok(!text.includes("秘密"));
  assert.equal(instance.calls.upstream.length, 0);
  assert.ok(!instance.calls.logs.join(" ").includes("Hello"));
  const count = await instance.fetch("https://bilingual.invalid/v1/messages/count_tokens", {
    method: "POST", body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "你好" }] }),
  });
  assert.deepEqual(await count.json(), { input_tokens: 0 });
  assert.equal(instance.calls.translations.length, 1);
  assert.equal(instance.calls.upstream.length, 0);
});

test("streaming preview returns a valid event sequence without target calls", async () => {
  const instance = await fixture({ config: { previewInput: true } });
  const response = await instance.request({ stream: true });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const events = (await response.text()).trim().split("\n\n").map((part) => JSON.parse(part.slice(part.indexOf("data: ") + 6)));
  assert.deepEqual(events.map((event) => event.type), ["message_start", "content_block_start", "content_block_delta",
    "content_block_stop", "message_delta", "message_stop"]);
  assert.match(events[2].delta.text, /Hello/);
  assert.equal(instance.calls.upstream.length, 0);
});

test("preview displays original text when translation is off", async () => {
  const instance = await fixture({ config: { previewInput: true, enable: false } });
  const response = await instance.request();
  assert.match((await response.json()).content[0].text, /user:\n你好/);
  assert.equal(instance.calls.translations.length, 0);
  assert.equal(instance.calls.upstream.length, 0);
});

for (const status of [401, 429, 500]) {
  test(`input HTTP ${status} blocks target model`, async () => {
    const instance = await fixture({ translate: () => new Response("private-error", { status }) });
    const response = await instance.request();
    assert.equal(response.status, 400);
    assert.equal(instance.calls.upstream.length, 0);
    assert.ok(!(await response.text()).includes("private-error"));
  });
}

for (const text of ["", "你好", "lost placeholder", "__BP_corrupted_0__"]) {
  test(`invalid translator result is fail closed: ${text || "empty"}`, async () => {
    const instance = await fixture({ translate: () => Response.json({ choices: [{ message: { content: text } }] }) });
    const response = await instance.request({ messages: [{ role: "user", content: "请检查 `file`" }] });
    assert.equal(response.status, 400);
    assert.equal(instance.calls.upstream.length, 0);
  });
}

test("output fallback is visible and strict output blocks", async () => {
  for (const outputFallback of ["english", "error"]) {
    const instance = await fixture({
      config: { outputFallback },
      translate: () => new Response("private", { status: 401 }),
    });
    const response = await instance.request({ messages: [{ role: "user", content: "Hello" }] });
    if (outputFallback === "english") {
      const body = await response.json();
      assert.match(body.content[0].text, /Here is the result/);
      assert.match(body.content[0].text, /翻译暂不可用/);
      assert.equal(response.headers.get("x-bilingual-translation-fallback"), "true");
    } else assert.equal(response.status, 400);
    assert.equal(instance.calls.upstream.length, 1);
  }
});

test("tools, thinking, signatures, usage and stop_reason remain identical", async () => {
  const original = message([
    { type: "thinking", thinking: "Private English reasoning", signature: "signed" },
    { type: "redacted_thinking", data: "opaque" },
    { type: "text", text: "Here is the result." },
    { type: "tool_use", id: "tool-1", name: "shell", input: { command: "echo 中文" } },
  ]);
  original.stop_reason = "tool_use";
  const instance = await fixture({ upstream: () => Response.json(original) });
  const result = await (await instance.request()).json();
  assert.deepEqual(result, { ...original, content: original.content.map((block) => block.type === "text" ? { ...block, text: "这是结果。" } : block) });
});

test("session-scoped history and cache survive tool loops without role mixing", async () => {
  const instance = await fixture();
  const first = await (await instance.request({}, { "x-magpie-session": "session-one" })).json();
  await instance.request({ messages: [
    { role: "assistant", content: first.content },
    { role: "user", content: "你好" },
  ] }, { "x-magpie-session": "session-one" });
  assert.equal(instance.calls.upstream[1].body.messages[0].content[0].text, "Here is the result.");
  assert.equal(instance.calls.translations.length, 2);
  await instance.request({ messages: [
    { role: "assistant", content: first.content },
    { role: "user", content: "Hello" },
  ] }, { "x-magpie-session": "another-session" });
  assert.equal(instance.calls.upstream[2].body.messages[0].content[0].text, "这是结果。");
  assert.equal(instance.metrics.history_miss, 1);
  assert.ok(!instance.calls.logs.join("").includes("session-one"));
});

test("disabled bridge retains request text and skips translators", async () => {
  const instance = await fixture({ config: { enable: false } });
  const response = await instance.request();
  assert.equal(instance.calls.upstream[0].body.messages[0].content, "你好");
  assert.equal(instance.calls.translations.length, 0);
  assert.equal((await response.json()).content[0].text, "Here is the result.");
});

test("upstream HTTP errors pass through without output translation", async () => {
  const instance = await fixture({ upstream: () => new Response("upstream-error", { status: 429 }) });
  const response = await instance.request({ messages: [{ role: "user", content: "Hello" }] });
  assert.equal(response.status, 429);
  assert.equal(await response.text(), "upstream-error");
  assert.equal(instance.calls.translations.length, 0);
});

test("SSE translates complete blocks and preserves nontext events", async () => {
  const events = textStream();
  events.splice(4, 0,
    { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "reasoning" } },
    { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "opaque" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tool-1", name: "shell", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"cmd":"pwd"}' } },
    { type: "content_block_stop", index: 2 },
    { type: "content_block_start", index: 3, content_block: { type: "text", text: "Here is " } },
    { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "the result." } },
    { type: "content_block_stop", index: 3 });
  const instance = await fixture({ upstream: () => streamResponse(events) });
  const response = await instance.request({ stream: true });
  const raw = await response.text();
  const result = raw.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
  assert.equal(result.at(-1).type, "message_stop");
  assert.deepEqual(result.filter((event) => event.delta?.type === "text_delta").map((event) => event.delta.text), ["这是结果。", "这是结果。"]);
  assert.deepEqual(result.filter((event) => [1, 2].includes(event.index)), events.filter((event) => [1, 2].includes(event.index)));
  assert.deepEqual(result[0], events[0]);
});

test("truncated and unknown SSE fail explicitly without forged message_stop", async () => {
  for (const events of [textStream().slice(0, -1), [...textStream().slice(0, 1), { type: "unknown_event" }]]) {
    const instance = await fixture({ upstream: () => streamResponse(events) });
    const result = await (await instance.request({ stream: true })).text();
    assert.match(result, /BILINGUAL_SSE_(TRUNCATED|UNKNOWN_EVENT)/);
    assert.ok(!result.includes("event: message_stop"));
  }
});

test("SSE upstream error is preserved even during buffered text", async () => {
  const error = { type: "error", error: { type: "overloaded_error", message: "fixture" } };
  const instance = await fixture({ upstream: () => streamResponse([...textStream().slice(0, 3), error]) });
  const result = await (await instance.request({ stream: true })).text();
  assert.ok(result.includes(frame(error)));
  assert.ok(!result.includes("event: message_stop"));
});

test("abort during input translation causes zero target calls", async () => {
  const aborter = new AbortController();
  const instance = await fixture({ translate: async (_body, init) => {
    aborter.abort();
    init.signal.throwIfAborted();
  } });
  const response = await instance.request({}, {}, aborter.signal);
  assert.equal(response.status, 400);
  assert.equal(instance.calls.upstream.length, 0);
});

test("stream reader cancellation reaches the target AbortSignal", async () => {
  const instance = await fixture({ upstream: () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(frame(textStream()[0]))); },
  }), { headers: { "content-type": "text/event-stream" } }) });
  const response = await instance.request({ stream: true });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(instance.calls.upstream[0].signal.aborted, true);
});

test("configuration rejects secrets in options, unsafe origins and recursive routes", async () => {
  for (const invalid of [
    { translator: { apiKey: "not-allowed" } },
    { translator: { baseURL: "http://127.0.0.1" } },
    { translator: { baseURL: "https://evil.example" } },
    { gateway: "http://example.com" },
    { targetModels: { test: "bilingual/test" } },
    { targetModels: { test: "group/auto" } },
    { timeoutMs: -1 },
  ]) await assert.rejects(configuration(invalid));
});

test("text protection preserves paths, nested JSON, commands, secrets and identifiers", () => {
  for (const original of [
    "请检查 /Users/example/代码.js，HTTP 502，变量 fooBar 与 snake_case。",
    '检查 {"outer":{"inner":"中文"},"items":[1,2]}',
    "请运行\nnpm run test -- --watch\n然后继续",
    "代码\n```js\nconst foo = '中文';\n```\n完成",
    "查看 https://example.com/path 和 `inline`，sk-1234567890abcdefghijklmnop",
    "Emoji 🐦 and $PATH and 123e4567-e89b-12d3-a456-426614174000",
  ]) {
    const protectedText = protect(original);
    assert.equal(protectedText.restore(protectedText.masked), original);
    assert.ok(!protectedText.masked.includes("代码.js"));
    assert.ok(!protectedText.masked.includes("sk-1234"));
  }
});

test("placeholder loss or duplication is rejected", () => {
  const protectedText = protect("请检查 `file`");
  assert.throws(() => protectedText.restore("Translation"));
  assert.throws(() => protectedText.restore(protectedText.masked + protectedText.masked));
});

test("chunking preserves placeholders and Unicode", () => {
  const text = protect("你好🐦".repeat(200) + " `file.js` " + "world ".repeat(100)).masked;
  const parts = splitText(text, 100);
  assert.equal(parts.join(""), text);
  assert.ok(parts.every((part) => !/[\uD800-\uDBFF]$/.test(part)));
});

test("bounded memory cache evicts entries and disabled cache stores nothing", () => {
  const cache = new MemoryCache(1000, 1);
  cache.set("a", "first");
  cache.set("b", "second");
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), "second");
  const disabled = new MemoryCache(0, 1);
  disabled.set("secret", "value");
  assert.equal(disabled.get("secret"), undefined);
});

test("translator concurrency bound and usage accounting", async () => {
  const config = await configuration({ ...options, translator: { ...options.translator, concurrency: 2 } });
  let active = 0;
  let maximum = 0;
  const translator = createTranslator(config, async () => "fixture", async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return Response.json({ choices: [{ message: { content: "Hello" } }] });
  });
  await Promise.all(Array.from({ length: 10 }, () => translator("你好", "en", AbortSignal.timeout(1000))));
  assert.equal(maximum, 2);
});

test("translation timeout blocks target and bounded retry recovers from 429", async () => {
  const timed = await fixture({
    config: { translator: { ...options.translator, timeoutMs: 100 } },
    translate: (_body, init) => new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture deadline")), 200);
      init.signal.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
    }),
  });
  assert.equal((await timed.request()).status, 400);
  assert.equal(timed.calls.upstream.length, 0);
  let attempts = 0;
  const recovered = await fixture({
    config: { outputTranslation: false, translator: { ...options.translator, retries: 1 } },
    translate: () => ++attempts === 1 ? new Response("", { status: 429 })
      : Response.json({ choices: [{ message: { content: "Hello" } }] }),
  });
  await (await recovered.request()).text();
  assert.equal(attempts, 2);
  assert.equal(recovered.calls.upstream.length, 1);
});

test("authentication failures are not retried", async () => {
  const instance = await fixture({ config: { translator: { ...options.translator, retries: 3 } },
    translate: () => new Response("", { status: 401 }) });
  await instance.request();
  assert.equal(instance.calls.translations.length, 1);
});

test("long text is chunked and translations preserve chunk separators", async () => {
  const config = await configuration({ ...options, translator: { ...options.translator, chunkChars: 100 } });
  let count = 0;
  const translator = createTranslator(config, async () => "fixture", async (_url, init) => {
    count++;
    const text = JSON.parse(init.body).messages[1].content.replaceAll("你好", "hello");
    return Response.json({ choices: [{ message: { content: text.trim() } }] });
  });
  const result = await translator("你好 ".repeat(200), "en", AbortSignal.timeout(2000));
  assert.ok(count > 1);
  assert.ok(!result.includes("hellohello"));
  assert.equal(result, "hello ".repeat(200));
});

test("unknown models and recursion markers fail before translation", async () => {
  const instance = await fixture();
  assert.equal((await instance.request({ model: "unconfigured" })).status, 400);
  assert.equal((await instance.request({}, { "x-bilingual-depth": "1" })).status, 400);
  assert.equal(instance.calls.translations.length, 0);
  assert.equal(instance.calls.upstream.length, 0);
});

test("system translation is opt in and code-only text does not call translator", async () => {
  const instance = await fixture({ config: { translateSystem: true, outputTranslation: false } });
  await (await instance.request({ system: "你好", messages: [{ role: "user", content: '```js\nconst text = "中文";\n```' }] })).text();
  assert.equal(instance.calls.translations.length, 1);
  assert.equal(instance.calls.upstream[0].body.system, "Hello");
  assert.equal(instance.calls.upstream[0].body.messages[0].content, '```js\nconst text = "中文";\n```');
});

test("SSE fallback is visible and citations are conservatively passed through", async () => {
  const instance = await fixture({
    upstream: () => streamResponse(textStream()),
    translate: () => new Response("", { status: 500 }),
  });
  const text = await (await instance.request({ stream: true, messages: [{ role: "user", content: "Hello" }] })).text();
  assert.match(text, /翻译暂不可用/);
  assert.match(text, /message_stop/);
  const events = textStream();
  events.splice(3, 0, { type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation: { type: "char_location", start_char_index: 0, end_char_index: 4 } } });
  const cited = await fixture({ upstream: () => streamResponse(events) });
  const raw = await (await cited.request({ stream: true, messages: [{ role: "user", content: "Hello" }] })).text();
  assert.equal(raw, events.map(frame).join(""));
  assert.equal(cited.calls.translations.length, 0);
});

test("aborting a queued translation does not leak concurrency capacity", async () => {
  const config = await configuration({ ...options, translator: { ...options.translator, concurrency: 1 } });
  let unblock;
  let count = 0;
  const translator = createTranslator(config, async () => "fixture", async () => {
    if (++count === 1) await new Promise((resolve) => { unblock = resolve; });
    return Response.json({ choices: [{ message: { content: "Hello" } }] });
  });
  const first = translator("你好", "en", AbortSignal.timeout(2000));
  await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const queued = translator("你好", "en", controller.signal);
  controller.abort();
  await assert.rejects(queued);
  unblock();
  await first;
  assert.equal(await translator("你好", "en", AbortSignal.timeout(2000)), "Hello");
});

test("unfenced code and Chinese string literals never reach translation service", async () => {
  for (const source of [
    'const label = "中文";\nif (label) {\n  console.log("错误", label);\n}',
    'def greet(name):\n    print("你好", name)\n    return "完成"',
    'function greet() {\n  return "中文";\n}',
    'console.log("中文")',
    'outer(inner("中文"))',
  ]) {
    const instance = await fixture({ config: { outputTranslation: false } });
    const response = await instance.request({ messages: [{ role: "user", content: source }] });
    await response.text();
    assert.equal(instance.calls.translations.length, 0);
    assert.equal(instance.calls.upstream[0].body.messages[0].content, source);
  }
  const instance = await fixture({ config: { outputTranslation: false } });
  await (await instance.request({ messages: [{ role: "user", content: '请检查 console.log("中文")' }] })).text();
  assert.equal(instance.calls.upstream[0].body.messages[0].content, 'Please inspect console.log("中文")');
  assert.ok(!JSON.stringify(instance.calls.translations).includes("中文"));
  const nested = protect('请检查 outer(inner("中文"))');
  assert.equal(nested.restore(nested.masked), '请检查 outer(inner("中文"))');
  assert.ok(!nested.masked.includes("outer"));
});

test("output code-only blocks pass through byte for byte", async () => {
  const source = '```js\nconsole.log("English and 中文");\n```\n';
  const instance = await fixture({ upstream: () => Response.json(message([{ type: "text", text: source }])) });
  const response = await instance.request({ messages: [{ role: "user", content: "Hello" }] });
  assert.equal((await response.json()).content[0].text, source);
  assert.equal(instance.calls.translations.length, 0);
});
