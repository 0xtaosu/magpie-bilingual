import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";
import { discoverGateway, inspectGateway } from "../src/probe.mjs";

const target = process.argv[2];
if (!target) throw new Error("Pass an enabled native model ID as the argument.");
const gateway = await discoverGateway();
const catalog = await inspectGateway(gateway);
if (!catalog.nativeModels.includes(target)) throw new Error("P0_TARGET_NOT_ENABLED");
const socket = createServer();
socket.listen(0, "127.0.0.1");
await once(socket, "listening");
const port = socket.address().port;
await new Promise((resolveClose) => socket.close(resolveClose));
const sandbox = await mkdtemp(join(tmpdir(), "bilingual-live-"));
const configDirectory = join(sandbox, ".config", "magpie");
const binary = process.env.MAGPIE_BIN || "/Applications/magpie.app/Contents/MacOS/magpie";
const env = { ...process.env, HOME: sandbox, XDG_CONFIG_HOME: join(sandbox, ".config"),
  XDG_CACHE_HOME: join(sandbox, ".cache"), MAGPIE_ADDR: `127.0.0.1:${port}` };
let server;
try {
  await mkdir(configDirectory, { recursive: true });
  await writeFile(join(configDirectory, "settings.json"), JSON.stringify({ port }));
  await writeFile(join(configDirectory, "plugins.json"), JSON.stringify({
    plugins: [{
      spec: resolve("test/host-fixture.mjs"),
      options: { gateway: `http://127.0.0.1:${port}`, targetModels: { test: "p0-native/test" },
        translator: { baseURL: "https://translator.example", trustedOrigins: ["https://translator.example"], model: "fixture" } },
    }, { spec: resolve("test/native-fixture.mjs"), options: { gateway, targetModel: target } }],
  }));
  await writeFile(join(configDirectory, "plugin-auth.json"),
    JSON.stringify({ bilingual: { type: "api", key: "fixture-not-a-secret" },
      "p0-native": { type: "api", key: "fixture-not-a-secret" } }), { mode: 0o600 });
  const listing = spawnSync(binary, ["plugin", "--json"], { env, encoding: "utf8", timeout: 45000 });
  if (listing.status !== 0) throw new Error("P0_HOST_LOAD_FAILED");
  const providers = JSON.parse(listing.stdout).providers;
  if (!["bilingual", "p0-native"].every((id) => providers?.some((provider) => provider.id === id && provider.signedIn))) {
    throw new Error("P0_HOST_ACCOUNT_MISSING");
  }
  server = spawn(binary, ["serve"], { env, stdio: "ignore" });
  server.on("error", () => {});
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error("P0_ISOLATED_GATEWAY_EXITED");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/hello`, { signal: AbortSignal.timeout(500) });
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(100);
  }
  if (!ready) throw new Error("P0_ISOLATED_GATEWAY_NOT_READY");
  for (const stream of [false, true]) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer magpie-bilingual-live-test", "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "bilingual/test", max_tokens: 64, stream, messages: [{ role: "user", content: "你好" }] }),
      signal: AbortSignal.timeout(60000),
    });
    const text = await response.text();
    const translated = text.includes("你好，朋友。");
    const complete = !stream || text.includes("message_stop");
    console.log(JSON.stringify({ stage: "isolated-host-to-native-model", stream, status: response.status, translated, complete }));
    if (!response.ok || !translated || !complete) throw new Error("P0_LIVE_ROUNDTRIP_FAILED");
  }
  const tools = [{ name: "p0_echo", description: "Echo a short value for a synthetic integration test.",
    input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }];
  const toolResponse = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { authorization: "Bearer magpie-bilingual-live-test", "content-type": "application/json" },
    body: JSON.stringify({ model: "bilingual/test", max_tokens: 128, stream: true,
      tools, tool_choice: { type: "tool", name: "p0_echo" }, messages: [{ role: "user", content: "请调用工具" }] }),
    signal: AbortSignal.timeout(60000),
  });
  const toolRaw = await toolResponse.text();
  const events = toolRaw.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
  const tool = events.find((event) => event.content_block?.type === "tool_use")?.content_block;
  const partial = events.filter((event) => event.delta?.type === "input_json_delta").map((event) => event.delta.partial_json).join("");
  const input = partial ? JSON.parse(partial) : tool?.input;
  const toolValid = toolResponse.ok && tool?.name === "p0_echo" && typeof tool.id === "string"
    && typeof input?.value === "string" && events.some((event) => event.delta?.stop_reason === "tool_use");
  console.log(JSON.stringify({ stage: "isolated-host-tool-use", status: toolResponse.status, toolValid }));
  if (!toolValid) {
    console.log(JSON.stringify({ events: events.map((event) => ({
      type: event.type, blockType: event.content_block?.type, deltaType: event.delta?.type,
      stopReason: event.delta?.stop_reason, errorType: event.error?.type,
      errorCode: event.error?.message?.startsWith("BILINGUAL_") ? event.error.message : undefined,
    })) }));
    throw new Error("P0_LIVE_TOOL_FAILED");
  }
  const continuation = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { authorization: "Bearer magpie-bilingual-live-test", "content-type": "application/json" },
    body: JSON.stringify({ model: "bilingual/test", max_tokens: 64, tools,
      messages: [{ role: "user", content: "请调用工具" },
        { role: "assistant", content: [{ ...tool, input }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: "Synthetic test succeeded." }] }] }),
    signal: AbortSignal.timeout(60000),
  });
  const continuationBody = await continuation.json();
  const loopComplete = continuation.ok && continuationBody.content?.some((block) => block.text === "你好，朋友。");
  console.log(JSON.stringify({ stage: "isolated-host-tool-result", status: continuation.status, loopComplete }));
  if (!loopComplete) throw new Error("P0_LIVE_TOOL_RESULT_FAILED");
} finally {
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await Promise.race([exited, delay(2000)]);
    if (server.exitCode === null) { server.kill("SIGKILL"); await exited; }
  }
  await rm(sandbox, { recursive: true, force: true });
}
