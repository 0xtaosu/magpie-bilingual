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

export function makeOptions(current, form) {
  const alias = form.alias.trim();
  const provider = form.provider.trim();
  const model = form.model.trim();
  const baseURL = form.baseURL.trim().replace(/\/+$/, "");
  const translatorModel = form.translatorModel.trim();
  if (!/^[A-Za-z0-9][\w.-]*$/.test(alias) || !/^[a-zA-Z0-9][\w.-]*$/.test(provider)
    || ["bilingual", "group"].includes(provider.toLowerCase()) || !model || /\s|\//.test(model)) {
    throw new Error("请填写有效的别名、供应商和模型 ID。");
  }
  let parsed;
  try { parsed = new URL(baseURL); } catch { throw new Error("请输入有效的 HTTPS 接口地址。"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || !translatorModel) throw new Error("请填写有效的 HTTPS 地址和翻译模型。");
  const translator = { ...current.translator, baseURL, model: translatorModel,
    trustedOrigins: [parsed.origin] };
  return {
    ...current,
    targetModels: { ...current.targetModels, [alias]: `${provider}/${model}` },
    translator,
    enable: form.enable,
    inputTranslation: form.inputTranslation,
    outputTranslation: form.outputTranslation,
  };
}
