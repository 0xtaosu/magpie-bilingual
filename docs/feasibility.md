# 技术可行性与阻塞项

更新：2026-11-14。资料来自 MAGPIE 官方公开文档，未在用户的 MAGPIE 实例完成真实插件测试。

## 1. 文档已确认的事实

1. MAGPIE 插件运行于 Bun 宿主；Provider Plugin 的 auth.loader.fetch(input, init) 可以发起网络请求，并返回 Response（含流）。
2. Async Gateway Request Hook 的 onRequest(body, ctx) 可以 await 外部 API、修改请求，但失败或超时默认保留原请求；Hook 顺序位于普通中间件之前。
3. Async onResponse(reply, ctx) 仅异步通知，不能更改返回给 Agent 的回复，也不能阻塞直播流。
4. Gateway Middleware 的 onRequest/onEvent/onResponse 等同步钩子运行在 moejs 中，无法 fetch、没有 Node API。即便写 async，也没有可等待的网络 I/O。
5. MAGPIE Gateway 本地通常为 127.0.0.1:3425（端口可配置），支持 /v1/messages 与 /v1/models；本地调用可使用 magpie-<app-id> 客户端标识。
6. 官方文档说明 Gateway 支持已有订阅账户提供的模型，但没有保证自定义 Provider 内再次回环调用自身 Gateway 的所有并发/流式场景都兼容。

## 2. 初选技术方案（假设，必须 P0 实测）

注册虚拟 bilingual Provider / 模型；通过其 auth.loader.fetch：
- 局部解析 Anthropic 请求，单独调用翻译服务完成中文→英文；
- 调用 MAGPIE 本机 Gateway 的原生 Claude 模型（不能是 bilingual 虚拟模型）；
- 处理返回的 JSON 或 SSE，自然语言文字译成中文，协议元数据直接透传；
- 将 Response 交还给 MAGPIE，最终返回 Claude Code。

该方法 **不需要单独运行代理进程**，但 Provider 插件内有一个“向 MAGPIE Gateway 发 HTTP 请求”的回环步骤。要确保不会造成路由死锁、重复应用全局中间件或重新进入自身 Provider。

## 3. P0 阻塞验证

- [ ] 用户机器上的 MAGPIE 版本和插件接口与文档一致。
- [ ] MAGPIE 实际运行且 /api/hello、/v1/models 可访问。
- [ ] 能从 /v1/models 得到真实原生 Claude 模型 ID。
- [ ] 注册 bilingual 虚拟 Provider 后 auth.loader.fetch 收到预期请求协议。
- [ ] 在该 fetch 中调用原生 Claude 模型能使用已有账号，无需额外 API Key。
- [ ] 请求不会在同一个虚拟 Provider 中无限递归、锁死或失去会话归属。
- [ ] 真实 Claude Code 的 Anthropic SSE 及 tool_use 消息可按规范重写。
- [ ] 输入翻译失败时可由 Provider fetch 在调用 Claude 前返回错误，确保零次上游发送。
- [ ] 图片与 thinking/signature 等内容可以原样回传。
- [ ] 插件关闭时原 Agent 的模型配置与常规路由不被破坏。

## 4. 安全设计检查

- 翻译 API Key 不放进公开 Git、README、package.json 或 MAGPIE 插件公开 Options JSON。
- 不提取 MAGPIE 其他 Provider 的 OAuth/session token；只走受支持的 Gateway。
- 对敏感自然语言的外传应要求用户知情；默认只发有必要的文本。
- 模拟请求和测试数据不得使用用户的真实聊天记录、用户电脑路径和真实 token。
- 回环目标必须是 loopback 且 targetModel 不能为 bilingual/*。

## 5. 不满足 P0 时的处理

不要宣称已实现纯插件双向翻译。先出具具体失败的用例及日志摘要（无私密文本），评估 MAGPIE 是否存在其他公开、可 await 的响应重写插件接口；若不存在，则需要就产品约束做取舍。用户目前要求不改 MAGPIE 源码且不运行独立代理，不能自行改变这些边界。

来源：
- https://usemagpie.ai/docs/plugins
- https://usemagpie.ai/docs/integrate
