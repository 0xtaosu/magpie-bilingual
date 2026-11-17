import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { providerChoices, splitTarget, makeOptions } from "../page/settings.js";
import { configuration } from "../src/config.mjs";

test("settings page is declared with a scoped read permission", async () => {
  const packageInfo = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageInfo.magpie.page.file, "page/index.html");
  assert.equal(packageInfo.magpie.page.icon, "page/icon.svg");
  assert.deepEqual(packageInfo.magpie.permissions, ["providers:list"]);
  assert.ok(packageInfo.files.includes("page"));
});

test("provider choices exclude virtual routing and preserve names", () => {
  assert.deepEqual(providerChoices({ providers: [
    { id: "bilingual", name: "Bilingual" }, { id: "group" },
    { id: "codex", name: "Codex" }, { id: "agy-cli" },
  ] }), [{ id: "codex", name: "Codex" }, { id: "agy-cli", name: "agy-cli" }]);
  assert.deepEqual(splitTarget("codex/gpt-6-sol"), { provider: "codex", model: "gpt-6-sol" });
});

test("visual form saves a native model and translator without dropping other options", async () => {
  const current = {
    gateway: "http://127.0.0.1:3425", cacheTTL: 5000,
    targetModels: { coding: "codex/old", second: "grok/grok-4.7" },
    translator: { baseURL: "https://api.deepseek.com", model: "previous", retries: 2 },
  };
  const result = makeOptions(current, {
    alias: "coding", provider: "codex", model: "gpt-6-sol",
    baseURL: "https://api.deepseek.com/", translatorModel: "deepseek-flash",
    enable: true, inputTranslation: true, outputTranslation: false,
  });
  assert.equal(result.targetModels.coding, "codex/gpt-6-sol");
  assert.equal(result.targetModels.second, "grok/grok-4.7");
  assert.equal(result.translator.model, "deepseek-flash");
  assert.equal(result.translator.retries, 2);
  assert.equal(result.cacheTTL, 5000);
  assert.equal(result.outputTranslation, false);
  assert.deepEqual(result.translator.trustedOrigins, ["https://api.deepseek.com"]);
  await configuration(result);
  assert.equal(current.targetModels.coding, "codex/old");
});

test("changing translation provider replaces the old origin permission", async () => {
  const result = makeOptions({ translator: { trustedOrigins: ["https://old.example"] } }, {
    alias: "coding", provider: "codex", model: "gpt-6-sol",
    baseURL: "https://new.example/v1", translatorModel: "cheap-model",
    enable: true, inputTranslation: true, outputTranslation: true,
  });
  assert.deepEqual(result.translator.trustedOrigins, ["https://new.example"]);
  await configuration({ ...result, gateway: "http://127.0.0.1:3425" });
});

test("visual form blocks invalid routes and insecure translation URLs", () => {
  const input = { alias: "coding", provider: "codex", model: "gpt-6-sol",
    baseURL: "https://api.deepseek.com", translatorModel: "deepseek-flash",
    enable: true, inputTranslation: true, outputTranslation: true };
  for (const change of [
    { alias: "../invalid" }, { provider: "bilingual" }, { provider: "group" },
    { model: "nested/model" }, { baseURL: "http://127.0.0.1:8080" },
    { baseURL: "https://user:password@api.deepseek.com" }, { translatorModel: "" },
  ]) assert.throws(() => makeOptions({}, { ...input, ...change }));
});
