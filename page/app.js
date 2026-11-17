import { makeOptions, normalizeBaseURL, providerChoices, resolveModelInput, splitTarget } from "./settings.js";

const element = (id) => document.getElementById(id);
const status = (text, error = false, tone = "") => {
  const node = element("status");
  node.textContent = text;
  node.dataset.error = String(error);
  node.dataset.tone = tone;
};
let current = {};
let knownIds = [];
let baseline = "";

function preview() {
  const alias = element("alias").value.trim();
  const resolved = resolveModelInput(element("provider").value, element("model").value, knownIds);
  const node = element("route-preview");
  if (alias && resolved.provider && resolved.model) {
    node.dataset.empty = "false";
    node.textContent = `客户端模型  bilingual/${alias}  →  工作模型  ${resolved.provider}/${resolved.model}`;
  } else {
    node.dataset.empty = "true";
    node.textContent = `填写模型 ID 后，可在客户端选用 bilingual/${alias || "coding"}`;
  }
}

function syncSwitches() {
  const on = element("enabled").checked;
  const inputToggle = element("input-translation");
  const outputToggle = element("output-translation");
  inputToggle.disabled = !on;
  outputToggle.disabled = !on;
  element("direction-group").dataset.disabled = String(!on);
  element("direction-hint").hidden = !on || inputToggle.checked || outputToggle.checked;
}

function syncPreviewNotice() {
  const savedOn = current.previewInput === true;
  const checked = element("preview-input").checked;
  const notice = element("preview-notice");
  if (savedOn && checked) {
    notice.hidden = false;
    notice.textContent = "当前处于「仅预览发出的译文」调试模式：对话只会返回译后文本，不会调用工作模型。排查完成后请关闭此项，保存并重新加载插件。";
  } else if (!savedOn && checked) {
    notice.hidden = false;
    notice.textContent = "即将开启「仅预览发出的译文」：保存并重新加载插件后，对话只会返回译后文本，不会调用工作模型。";
  } else if (savedOn && !checked) {
    notice.hidden = false;
    notice.textContent = "已取消「仅预览发出的译文」：请点击「保存设置」并重新加载插件，恢复工作模型正常回复。";
  } else {
    notice.hidden = true;
    notice.textContent = "";
  }
}

function snapshot() {
  const resolved = resolveModelInput(element("provider").value, element("model").value, knownIds);
  return JSON.stringify({
    alias: element("alias").value.trim(),
    provider: resolved.provider,
    model: resolved.model,
    baseURL: normalizeBaseURL(element("base-url").value),
    translatorModel: element("translator-model").value.trim(),
    enable: element("enabled").checked,
    previewInput: element("preview-input").checked,
    inputTranslation: element("input-translation").checked,
    outputTranslation: element("output-translation").checked,
  });
}

function restingMessage() {
  if (!knownIds.length) return "未检测到可用供应商，请先在「供应商」页添加并启用工作模型。";
  if (!element("model").value.trim() || !element("translator-model").value.trim()) {
    return "首次配置请补全工作模型与翻译模型，并在「供应商 › 双语桥接」中填写翻译 API Key。";
  }
  return "";
}

function ensureProviderOption(select, id) {
  if (!id || knownIds.includes(id)) return;
  knownIds.push(id);
  const option = document.createElement("option");
  option.value = id;
  option.textContent = id;
  select.append(option);
}

function applyModelPaste() {
  const select = element("provider");
  const modelInput = element("model");
  const resolved = resolveModelInput(select.value, modelInput.value, knownIds);
  if (resolved.provider !== select.value || resolved.model !== modelInput.value.trim()) {
    select.value = resolved.provider;
    modelInput.value = resolved.model;
  }
}

function renderRouteTabs(select) {
  const entries = Object.entries(current.targetModels ?? {});
  const tabs = element("route-tabs");
  tabs.replaceChildren();
  if (entries.length <= 1) {
    tabs.hidden = true;
    return;
  }
  tabs.hidden = false;
  const label = document.createElement("span");
  label.textContent = "已配置路由：";
  tabs.append(label);
  const activeAlias = element("alias").value.trim();
  for (const [aliasKey, target] of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `bilingual/${aliasKey}`;
    button.setAttribute?.("aria-selected", String(aliasKey === activeAlias));
    button.addEventListener?.("click", () => {
      const parsed = splitTarget(target);
      ensureProviderOption(select, parsed.provider);
      element("alias").value = aliasKey;
      select.value = parsed.provider || knownIds[0] || "";
      element("model").value = parsed.model;
      baseline = snapshot();
      preview();
      renderRouteTabs(select);
      status(restingMessage());
    });
    tabs.append(button);
  }
}

function onFieldInput(select) {
  preview();
  syncSwitches();
  syncPreviewNotice();
  renderRouteTabs(select);
  if (snapshot() !== baseline) status("有未保存的更改", false, "dirty");
  else status(restingMessage());
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
  knownIds = providers.map((entry) => entry.id);
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
  element("preview-input").checked = current.previewInput === true;
  if (current.previewInput === true) element("advanced").open = true;
  element("input-translation").checked = current.inputTranslation !== false;
  element("output-translation").checked = current.outputTranslation !== false;

  const fieldIds = [
    "alias", "provider", "model", "base-url", "translator-model",
    "enabled", "preview-input", "input-translation", "output-translation",
  ];
  for (const id of fieldIds) {
    element(id).addEventListener("input", () => onFieldInput(select));
    element(id).addEventListener("change", () => onFieldInput(select));
  }
  element("model").addEventListener("change", () => {
    applyModelPaste();
    onFieldInput(select);
  });
  element("base-url").addEventListener("change", () => {
    if (element("base-url").value.trim()) element("base-url").value = normalizeBaseURL(element("base-url").value);
    onFieldInput(select);
  });

  preview();
  syncSwitches();
  syncPreviewNotice();
  renderRouteTabs(select);
  baseline = snapshot();
  select.disabled = !providers.length;
  element("save").disabled = !providers.length;
  status(restingMessage());

  element("settings").addEventListener("submit", async (event) => {
    event.preventDefault();
    applyModelPaste();
    if (element("base-url").value.trim()) element("base-url").value = normalizeBaseURL(element("base-url").value);
    const aliasInput = element("alias");
    if (aliasInput.checkValidity && !aliasInput.checkValidity()) element("advanced").open = true;
    if (!event.currentTarget.reportValidity()) return;
    const button = element("save");
    const previousTargets = current.targetModels ?? {};
    const previousPreview = current.previewInput === true;
    button.disabled = true;
    button.dataset.saving = "true";
    button.textContent = "保存中…";
    status("正在保存…");
    try {
      const next = makeOptions(current, {
        alias: element("alias").value, provider: select.value, model: element("model").value,
        baseURL: element("base-url").value, translatorModel: element("translator-model").value,
        enable: element("enabled").checked,
        previewInput: element("preview-input").checked,
        inputTranslation: element("input-translation").checked,
        outputTranslation: element("output-translation").checked,
      });
      const alias = aliasInput.value.trim();
      const isNewAlias = !(alias in previousTargets);
      current = await magpie.options.set(next);
      element("alias").value = alias;
      element("model").value = element("model").value.trim();
      element("base-url").value = current.translator?.baseURL ?? element("base-url").value;
      element("translator-model").value = element("translator-model").value.trim();
      syncPreviewNotice();
      renderRouteTabs(select);
      baseline = snapshot();
      if (isNewAlias) {
        status(`已保存。请在「插件」页重新加载本插件，并在「供应商 › 双语桥接」中启用 bilingual/${alias}。`, false, "success");
      } else if (current.previewInput === true && !previousPreview) {
        status("已保存。请在「插件」页重新加载本插件；之后对话将仅返回译文预览。", false, "success");
      } else if (current.previewInput !== true && previousPreview) {
        status("已保存。请在「插件」页重新加载本插件，恢复工作模型正常回复。", false, "success");
      } else {
        status("已保存。在「插件」页重新加载本插件后生效。", false, "success");
      }
    } catch (error) {
      status(error instanceof Error ? error.message : "保存失败，请重试。", true);
    } finally {
      button.dataset.saving = "false";
      button.textContent = "保存设置";
      button.disabled = false;
    }
  });
  element("alias").addEventListener("invalid", () => {
    element("advanced").open = true;
  });
}

start().catch((error) => status(error instanceof Error ? error.message : "页面加载失败，请在「插件」页重新加载后重试。", true));
