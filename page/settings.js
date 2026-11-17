export function providerChoices(value) {
  const entries = Array.isArray(value) ? value : value?.providers ?? value?.data ?? [];
  return entries.filter((entry) => entry && typeof entry.id === "string"
    && entry.id !== "bilingual" && entry.id !== "group").map(({ id, name }) => ({ id, name: name || id }));
}

export function splitTarget(target) {
  const slash = target.indexOf("/");
  return slash > 0 ? { provider: target.slice(0, slash), model: target.slice(slash + 1) }
    : { provider: "", model: "" };
}

export function normalizeBaseURL(value) {
  return String(value ?? "").trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "").replace(/\/+$/, "");
}

export function resolveModelInput(provider, model, knownProviders = []) {
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

export function makeOptions(current, form) {
  const alias = form.alias.trim();
  const provider = form.provider.trim();
  const model = form.model.trim();
  const baseURL = normalizeBaseURL(form.baseURL);
  const translatorModel = form.translatorModel.trim();
  if (!/^[A-Za-z0-9][\w.-]*$/.test(alias)) {
    throw new Error("模型别名需以字母或数字开头，仅限字母、数字、点、下划线或短横线。");
  }
  if (!/^[a-zA-Z0-9][\w.-]*$/.test(provider) || ["bilingual", "group"].includes(provider.toLowerCase())) {
    throw new Error("请选择有效的工作模型供应商（不可选择双语桥接自身或分组路由）。");
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
