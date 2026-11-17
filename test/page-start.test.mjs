import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("classic page script initializes providers and saved switches", async () => {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", checked: false, disabled: true, dataset: {}, children: [],
      append(child) { this.children.push(child); },
      replaceChildren() { this.children = []; },
      addEventListener() {},
    });
    return nodes.get(id);
  };
  const bundle = await readFile(new URL("../page/bundle.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../page/index.html", import.meta.url), "utf8");
  assert.ok(html.includes('src="bundle.js" defer'));
  runInNewContext(bundle, {
    document: { getElementById: node, createElement: () => ({}) },
    magpie: {
      ready: Promise.resolve(),
      options: { get: async () => ({ targetModels: { coding: "codex/test" }, enable: true }) },
      read: async () => [{ id: "codex", name: "Codex" }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(node("provider").children[0].textContent, "Codex (codex)");
  assert.equal(node("provider").value, "codex");
  assert.equal(node("provider").disabled, false);
  assert.equal(node("enabled").checked, true);
  assert.equal(node("input-translation").checked, true);
  assert.equal(node("save").disabled, false);
});

test("settings page links master switch, preview notice, route tabs, and dirty save flow", async () => {
  const nodes = new Map();
  const makeElement = () => {
    const listeners = new Map();
    return {
      value: "",
      checked: false,
      disabled: true,
      hidden: false,
      open: false,
      textContent: "",
      dataset: {},
      children: [],
      attributes: {},
      append(child) { this.children.push(child); },
      replaceChildren() { this.children = []; },
      setAttribute(name, val) { this.attributes[name] = val; },
      addEventListener(type, fn) {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      dispatch(type, extra = {}) {
        for (const fn of listeners.get(type) ?? []) fn({ preventDefault() {}, currentTarget: this, ...extra });
      },
      reportValidity() { return true; },
      checkValidity() { return true; },
    };
  };
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, makeElement());
    return nodes.get(id);
  };
  let savedPayload = null;
  const bundle = await readFile(new URL("../page/bundle.js", import.meta.url), "utf8");
  runInNewContext(bundle, {
    URL,
    document: { getElementById: node, createElement: () => makeElement() },
    magpie: {
      ready: Promise.resolve(),
      options: {
        get: async () => ({
          targetModels: { coding: "codex/gpt-5.4", review: "anthropic/claude-sonnet-4-6" },
          translator: { baseURL: "https://api.deepseek.com", model: "deepseek-chat" },
          enable: true,
          previewInput: true,
        }),
        set: async (next) => { savedPayload = next; return next; },
      },
      read: async () => [{ id: "codex", name: "Codex" }, { id: "anthropic", name: "Anthropic" }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(node("advanced").open, true);
  assert.equal(node("preview-notice").hidden, false);
  assert.equal(node("route-tabs").hidden, false);
  assert.equal(node("route-tabs").children.length, 3);
  assert.equal(node("status").textContent, "");

  node("route-tabs").children[2].dispatch("click");
  assert.equal(node("alias").value, "review");
  assert.equal(node("provider").value, "anthropic");
  assert.equal(node("model").value, "claude-sonnet-4-6");

  node("enabled").checked = false;
  node("enabled").dispatch("change");
  assert.equal(node("input-translation").disabled, true);
  assert.equal(node("output-translation").disabled, true);
  assert.equal(node("status").dataset.tone, "dirty");

  node("enabled").checked = true;
  node("input-translation").checked = false;
  node("output-translation").checked = false;
  node("output-translation").dispatch("change");
  assert.equal(node("direction-hint").hidden, false);

  node("model").value = "codex/gpt-5.4-mini";
  node("model").dispatch("change");
  assert.equal(node("provider").value, "codex");
  assert.equal(node("model").value, "gpt-5.4-mini");

  node("preview-input").checked = false;
  node("preview-input").dispatch("change");
  assert.match(node("preview-notice").textContent, /恢复工作模型正常回复/);

  node("settings").dispatch("submit");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(savedPayload.targetModels.review, "codex/gpt-5.4-mini");
  assert.equal(savedPayload.previewInput, false);
  assert.equal(node("preview-notice").hidden, true);
  assert.equal(node("status").dataset.tone, "success");
});
