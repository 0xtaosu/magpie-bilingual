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
