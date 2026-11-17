import { test } from "node:test";
import assert from "node:assert/strict";
import Plugin from "../index.mjs";
import { createProbeFetch, ENGLISH_FIXTURE, FIXTURE, validateGateway } from "../src/probe.mjs";

const targetModel = "anthropic/claude-test";
function harness(response = () => Response.json({ content: [{ type: "text", text: "BILINGUAL_P0_OK" }] })) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/api/hello")) return Response.json({ name: "magpie", version: "test" });
    if (url.endsWith("/v1/models")) return Response.json({ data: [{ id: targetModel }] });
    return response(init);
  };
  return { calls, probe: createProbeFetch({ gateway: "http://127.0.0.1:3425", targetModel, fetcher }) };
}
function request(probe, content = FIXTURE, headers = {}) {
  return probe("https://bilingual.invalid/v1/messages", {
    method: "POST", headers,
    body: JSON.stringify({ model: "test", stream: true, messages: [{ role: "user", content }] }),
  });
}

test("provider declares Anthropic model and isolated fetch", async () => {
  const hooks = await Plugin({}, { gateway: "http://127.0.0.1:3425", targetModels: { test: "codex/gpt-test" } });
  const config = {};
  await hooks.config(config);
  assert.equal(config.provider.bilingual.npm, "@ai-sdk/anthropic");
  assert.ok(config.provider.bilingual.models.test);
  assert.equal(typeof (await hooks.auth.loader()).fetch, "function");
});

test("only literal loopback gateway URLs are accepted", () => {
  for (const address of ["https://example.com", "http://localhost", "http://127.0.0.1@evil.test",
    "http://127.0.0.1/path", "http://127.0.0.1?next=evil", "ftp://127.0.0.1"]) {
    assert.throws(() => validateGateway(address));
  }
  assert.equal(validateGateway("http://[::1]:3425"), "http://[::1]:3425");
});

test("unknown Chinese text is blocked before any gateway calls", async () => {
  const { probe, calls } = harness();
  assert.equal((await request(probe, "修复我的代码")).status, 400);
  assert.equal(calls.length, 0);
});

test("image and cache fields survive while fixture text is replaced", async () => {
  const { probe, calls } = harness();
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } };
  const response = await request(probe, [image, { type: "text", text: FIXTURE, cache_control: { type: "ephemeral" } }],
    { authorization: "Bearer must-not-forward", "x-magpie-session": "synthetic-session" });
  await response.text();
  const forwarded = calls.at(-1);
  const body = JSON.parse(forwarded.init.body);
  assert.deepEqual(body.messages[0].content[0], image);
  assert.equal(body.messages[0].content[1].text, ENGLISH_FIXTURE);
  assert.deepEqual(body.messages[0].content[1].cache_control, { type: "ephemeral" });
  assert.equal(body.model, targetModel);
  assert.equal(forwarded.init.headers.get("authorization"), "Bearer magpie-bilingual-p0");
  assert.equal(forwarded.init.headers.get("x-magpie-session"), "synthetic-session");
  assert.equal(forwarded.init.redirect, "error");
});

test("recursive and unconfigured targets cannot reach network", async () => {
  for (const target of [undefined, "bilingual/test", "group/claude", "gpt-test"]) {
    const probe = createProbeFetch({ gateway: "http://127.0.0.1:3425", targetModel: target,
      fetcher: () => { assert.fail("network must not be called"); } });
    assert.equal((await request(probe)).status, 400);
  }
  const { probe, calls } = harness();
  assert.equal((await request(probe, FIXTURE, { "x-bilingual-depth": "1" })).status, 400);
  assert.equal(calls.length, 0);
});

test("upstream error status and body are preserved", async () => {
  const { probe } = harness(() => new Response('{"error":{"type":"rate_limit_error"}}', { status: 429 }));
  const response = await request(probe);
  assert.equal(response.status, 429);
  assert.equal(await response.text(), '{"error":{"type":"rate_limit_error"}}');
});

test("SSE bytes including tools, signatures and UTF-8 pass through unchanged", async () => {
  const source = 'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"中文"}}\n\n'
    + 'event: content_block_delta\ndata: {"index":1,"delta":{"type":"signature_delta","signature":"opaque"}}\n\n'
    + 'event: content_block_start\ndata: {"index":2,"content_block":{"type":"tool_use","id":"t1","name":"shell","input":{}}}\n\n'
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const bytes = new TextEncoder().encode(source);
  const { probe } = harness(() => new Response(new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } }));
  const response = await request(probe);
  assert.equal(await response.text(), source);
});

test("downstream cancellation releases upstream stream", async () => {
  let cancelled = false;
  const { probe } = harness(() => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  })));
  const response = await request(probe);
  await response.body.cancel();
  assert.equal(cancelled, true);
});

test("missing target in catalog blocks Claude request", async () => {
  let messageCalls = 0;
  const probe = createProbeFetch({ gateway: "http://127.0.0.1:3425", targetModel,
    fetcher: async (url) => {
      if (url.endsWith("/api/hello")) return Response.json({ name: "magpie" });
      if (url.endsWith("/v1/models")) return Response.json({ data: [] });
      messageCalls++;
    },
  });
  assert.equal((await request(probe)).status, 400);
  assert.equal(messageCalls, 0);
});
