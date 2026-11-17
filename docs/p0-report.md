# P0 与实现验证报告

日期：2026-11-17。范围依用户补充扩展为任意 MAGPIE 原生模型；图片、代码不翻译。

## 环境与方法

- 本机 MAGPIE `0.1.3960`，Bun 插件宿主；Node.js `26.12.1` 运行离线测试。
- 真实网关可读，目录包含已启用的 Codex 模型；选用 `codex/gpt-6-sol` 做小型合成请求。
- 生产插件仅导出标准 Provider 入口；无需构建、源码修改或独立代理。
- 验证不读取、复制或输出既有订阅凭据。生产配置未被测试脚本修改。

三层验证：

1. 离线测试注入 fetch，用确定性响应验证协议、错误和内容保护，禁止访问外网。
2. 在临时隔离 HOME 中由真实 MAGPIE 加载生产插件。
3. 临时 MAGPIE 中加载生产桥接逻辑和固定翻译替身，回环进入同一个 MAGPIE 实例的测试原生 Provider，再调用既有网关的真实 Codex 账户。测试原生 Provider 仅用于避免复制真实账户到隔离 HOME；正式插件直接指向所选原生模型，不包含这层测试转接。

第三层中的翻译替身只翻译固定合成语句，不能作为翻译服务质量或 DeepSeek 连通性的证据。

## 已完成的证据

| 验证 | 结果 | 范围 |
| --- | --- | --- |
| `npm test` | 42 项通过 | JSON、SSE、保护、失败、缓存、并发和取消 |
| `npm run test:host` | 通过 | MAGPIE 在隔离 HOME 中发现生产 bilingual Provider |
| `npm run probe -- codex/gpt-6-sol` | JSON/SSE 均 HTTP 200，标记匹配 | 原生网关复用既有 Codex 账户 |
| 同实例宿主回环 + 真实 Codex | JSON/SSE 均 HTTP 200，中文结果及结束事件匹配 | 两个 Provider 在同一 Bun 宿主内完成回环，不死锁 |
| 真实 Codex 工具循环 | tool_use 和 tool_result 续接均 HTTP 200 | 工具名称、ID、JSON 参数可读取，结果返回后正常继续 |
| 真实 DeepSeek Flash 双向翻译 | HTTP 200，无翻译回退标记 | 生产插件使用受保护的既有凭据，工作模型 `codex/gpt-6-sol`，翻译模型 `deepseek-flash`；固定中文问题得到中文说明 |

离线覆盖：图片和 tool_result 不进入翻译 API；中文输入的 401/429/500、超时、占位符篡改均阻止目标调用；非流式和分片 UTF-8 SSE 输出；tool_use、thinking、signature、usage、stop_reason 保留；取消传播；跨会话隔离和历史恢复；内存上限；TLS/回环/递归限制；流式截断、未知事件、输出降级。

代码保护覆盖：围栏、行内代码、裸函数调用、多行 JavaScript/Python、嵌套 JSON、命令、路径、标识符和代码中的中文字符串。输出代码块也原样保留。任意语言的无边界代码无法保证自动识别，使用 Markdown 代码围栏可明确保护范围。

## 实现限制及剩余验收

- 真实 `deepseek-flash` 已通过单轮非流式请求；尚未完成批量语义人工评估、真实翻译流式回归或 p95 基准，不能宣称达到 3 秒目标。
- 图片在插件边界按字段值保留，工具与图片的 JSON 序列化空白可能变化；图片 base64/URL/media_type 等值不变化。没有对真实图片进行 OCR，也没有图片翻译功能。
- Claude Code 完整交互式会话、真实压缩/子 Agent、真实多模态模型、账号轮换和全局中间件组合尚待部署环境验收。
- 引用文本保守透传，记录诊断；未知协议扩展明确失败，避免损坏工具协议。
- 内存历史在重启后丢失；会话标识缺失或历史未命中时保留原文并记录诊断。不给出跨重启恢复保证。
- 翻译成功校验检查占位符、空输出、截断和目标语言，不等于语义准确性证明。
- 目标 Provider 必须支持用户实际使用的能力。MAGPIE 接受 Anthropic 请求不代表每个模型都支持图片、thinking、强制工具选择或 token 计数。

当前是可安装测试的候选实现，不是“全部 PRD 发布验收通过”的结论。安装后仍需配置目标模型、翻译模型与受保护的翻译凭据；不需要新增 Claude 账户。

生产配置时发现：插件注册的模型可能默认未对外展示，即使登录成功仍不会出现在 `/v1/models`。执行 `magpie provider models bilingual +coding` 后，真实网关请求通过。安装说明已补充该步骤。

工具测试曾仅发送“回复一句问候”并设置强制工具选择，Codex 返回普通文字；将合成请求明确改为调用工具后，真实工具循环通过。插件保留 `tool_choice`，但不把所有目标模型遵循强制工具选择视为已验证能力。

## 复现

```sh
npm test
npm run test:host
npm run probe -- codex/gpt-6-sol
npm run test:live -- codex/gpt-6-sol
```

上面的模型是本次实测 ID，复现时以本机目录为准。live 脚本会发起真实模型请求并消耗少量额度；测试输入为固定合成文本。脚本清理隔离 HOME 和临时 MAGPIE 进程。

官方接口依据：

- https://usemagpie.ai/docs/plugins
- https://usemagpie.ai/docs/integrate
- https://platform.claude.com/docs/en/build-with-claude/streaming
- https://api-docs.deepseek.com/api/create-chat-completion/
