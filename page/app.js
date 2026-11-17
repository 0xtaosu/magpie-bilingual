import { makeOptions, providerChoices, splitTarget } from "./settings.js";

const element = (id) => document.getElementById(id);
const status = (text, error = false) => {
  element("status").textContent = text;
  element("status").dataset.error = String(error);
};
let current = {};

function preview() {
  const alias = element("alias").value.trim();
  const provider = element("provider").value;
  const model = element("model").value.trim();
  element("route-preview").textContent = alias && provider && model
    ? `bilingual/${alias}  →  ${provider}/${model}` : "选择工作模型以查看路由。";
}

async function start() {
  await magpie.ready;
  const [options, available] = await Promise.all([
    magpie.options.get(), magpie.read("providers:list"),
  ]);
  current = options && typeof options === "object" ? options : {};
  const targets = current.targetModels ?? {};
  const first = Object.entries(targets)[0] ?? ["coding", ""];
  const { provider, model } = splitTarget(first[1]);
  const select = element("provider");
  select.replaceChildren();
  const providers = providerChoices(available);
  if (provider && !providers.some((entry) => entry.id === provider)) providers.push({ id: provider, name: provider });
  for (const entry of providers) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.name === entry.id ? entry.id : `${entry.name} (${entry.id})`;
    select.append(option);
  }
  if (!providers.length) {
    const option = document.createElement("option");
    option.textContent = "暂无可用供应商";
    option.value = "";
    select.append(option);
  }
  select.value = provider || providers[0]?.id || "";
  element("alias").value = first[0];
  element("model").value = model;
  element("base-url").value = current.translator?.baseURL ?? "https://api.deepseek.com";
  element("translator-model").value = current.translator?.model ?? "";
  element("enabled").checked = current.enable !== false;
  element("input-translation").checked = current.inputTranslation !== false;
  element("output-translation").checked = current.outputTranslation !== false;
  for (const id of ["alias", "provider", "model"]) element(id).addEventListener("input", preview);
  preview();
  select.disabled = !providers.length;
  element("save").disabled = !providers.length;
  status(providers.length ? "" : "未找到供应商，请先在 MAGPIE 中添加并启用工作模型。");

  element("settings").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const button = element("save");
    button.disabled = true;
    status("正在保存…");
    try {
      const next = makeOptions(current, {
        alias: element("alias").value, provider: select.value, model: element("model").value,
        baseURL: element("base-url").value, translatorModel: element("translator-model").value,
        enable: element("enabled").checked,
        inputTranslation: element("input-translation").checked,
        outputTranslation: element("output-translation").checked,
      });
      current = await magpie.options.set(next);
      status("设置已保存。新模型可能还需在供应商的模型列表中启用。");
    } catch (error) {
      status(error instanceof Error ? error.message : "保存失败，请重试。", true);
    } finally {
      button.disabled = false;
    }
  });
  element("alias").addEventListener("invalid", () => {
    element("alias").closest("details").open = true;
  });
}

start().catch((error) => status(error instanceof Error ? error.message : "页面加载失败。", true));
