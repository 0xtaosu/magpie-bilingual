(() => {
function providerChoices(value) {
  const entries = Array.isArray(value) ? value : value?.providers ?? value?.data ?? [];
  return entries.filter((entry) => entry && typeof entry.id === "string"
    && entry.id !== "bilingual" && entry.id !== "group").map(({ id, name }) => ({ id, name: name || id }));
}

function splitTarget(target) {
  const slash = target.indexOf("/");
  return slash > 0 ? { provider: target.slice(0, slash), model: target.slice(slash + 1) }
    : { provider: "", model: "" };
}

function normalizeBaseURL(value) {
  return String(value ?? "").trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "").replace(/\/+$/, "");
}

function resolveModelInput(provider, model, knownProviders = []) {
  const cleanProvider = String(provider ?? "").trim();
  const cleanModel = String(model ?? "").trim();
  const slash = cleanModel.indexOf("/");
  if (slash <= 0 || slash === cleanModel.length - 1) return { provider: cleanProvider, model: cleanModel };
  const prefix = cleanModel.slice(0, slash);
  const rest = cleanModel.slice(slash + 1);
  if (/\s|\//.test(rest)) return { provider: cleanProvider, model: cleanModel };
  if (prefix === cleanProvider || knownProviders.includes(prefix)) {
    return { provider: prefix, model: rest };
  }
  return { provider: cleanProvider, model: cleanModel };
}

function makeOptions(current, form) {
  const alias = form.alias.trim();
  const provider = form.provider.trim();
  const model = form.model.trim();
  const baseURL = normalizeBaseURL(form.baseURL);
  const translatorModel = form.translatorModel.trim();
  if (!/^[A-Za-z0-9][\w.-]*$/.test(alias)) {
    throw new Error("模型别名需以字母或数字开头，仅限字母、数字、点、下划线或短横线。");
  }
  if (!/^[a-zA-Z0-9][\w.-]*$/.test(provider) || ["bilingual", "group"].includes(provider.toLowerCase())) {
    throw new Error("请选择有效的工作模型供应商（不可选择双语翻译代理自身或分组路由）。");
  }
  if (!model) {
    throw new Error("请填写工作模型的模型 ID。");
  }
  if (/^bilingual\//i.test(model)) {
    throw new Error("请填写上游工作模型的 ID，而非 bilingual/ 虚拟别名。");
  }
  if (/\s|\//.test(model)) {
    throw new Error("模型 ID 请勿包含空格或「供应商/」前缀（例如填 gpt-5.4）。");
  }
  let parsed;
  try { parsed = new URL(baseURL); } catch { throw new Error("请填写有效的翻译服务接口地址（以 https:// 开头）。"); }
  if (parsed.protocol !== "https:") {
    throw new Error("出于隐私安全保护，翻译服务接口地址必须使用 https://。");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("接口地址仅填基础路径（如 https://api.deepseek.com），请勿包含账号密码、? 参数或 # 锚点。");
  }
  if (!translatorModel) {
    throw new Error("请填写翻译模型名称（例如 deepseek-chat）。");
  }
  const translator = { ...current.translator, baseURL, model: translatorModel,
    trustedOrigins: [parsed.origin] };
  return {
    ...current,
    targetModels: { ...current.targetModels, [alias]: `${provider}/${model}` },
    translator,
    enable: form.enable,
    previewInput: form.previewInput ?? false,
    inputTranslation: form.inputTranslation,
    outputTranslation: form.outputTranslation,
  };
}


const element = (id) => document.getElementById(id);
const status = (text, error = false, tone = "") => {
  const node = element("status");
  node.textContent = text;
  node.dataset.error = String(error);
  node.dataset.tone = tone;
};

const FIELD_IDS = [
  "alias", "provider", "model", "base-url", "translator-model",
  "enabled", "preview-input", "input-translation", "output-translation",
];

let current = {};
let knownIds = [];
let baseline = "";

function readForm() {
  const resolved = resolveModelInput(element("provider").value, element("model").value, knownIds);
  return {
    alias: element("alias").value.trim(),
    provider: resolved.provider,
    model: resolved.model,
    baseURL: normalizeBaseURL(element("base-url").value),
    translatorModel: element("translator-model").value.trim(),
    enable: element("enabled").checked,
    previewInput: element("preview-input").checked,
    inputTranslation: element("input-translation").checked,
    outputTranslation: element("output-translation").checked,
  };
}

function preview() {
  const { alias, provider, model } = readForm();
  const node = element("route-preview");
  if (alias && provider && model) {
    node.dataset.empty = "false";
    node.textContent = `客户端模型  bilingual/${alias}  →  工作模型  ${provider}/${model}`;
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
  const message = savedOn && checked
    ? "当前处于「仅预览发出的译文」调试模式：对话只会返回译后文本，不会调用工作模型。排查完成后请关闭此项，保存并重新加载插件。"
    : !savedOn && checked
      ? "即将开启「仅预览发出的译文」：保存并重新加载插件后，对话只会返回译后文本，不会调用工作模型。"
      : savedOn && !checked
        ? "已取消「仅预览发出的译文」：请点击「保存设置」并重新加载插件，恢复工作模型正常回复。"
        : "";
  notice.hidden = !message;
  notice.textContent = message;
}

const snapshot = () => JSON.stringify(readForm());

function restingMessage() {
  if (!knownIds.length) return "未检测到可用供应商，请先在「供应商」页添加并启用工作模型。";
  if (!element("model").value.trim() || !element("translator-model").value.trim()) {
    return "首次配置请补全工作模型与翻译模型，并在「供应商 › 双语翻译代理」中填写翻译 API Key。";
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

  for (const id of FIELD_IDS) {
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
      const form = readForm();
      const next = makeOptions(current, form);
      const { alias } = form;
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
        status(`已保存。请在「插件」页重新加载本插件，并在「供应商 › 双语翻译代理」中启用 bilingual/${alias}。`, false, "success");
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

})();
