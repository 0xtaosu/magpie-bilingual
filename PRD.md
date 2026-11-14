# MAGPIE Bilingual Bridge — 产品需求文档（PRD）

> 版本：v0.1.0 ｜ 日期：2026-11-14 ｜ 状态：需求基线（待 P0 技术验证）
> 项目类型：MAGPIE 原生插件 ｜ 目标客户端：Claude Code ｜ 首期协议：Anthropic Messages API
> 产品原则：不修改 MAGPIE 源码；不部署独立 HTTP 代理；不替换现有 Claude 登录方式。

## 0. 一句话概述

通过安装在 MAGPIE 内运行的插件，在 Claude Code 与 Claude 模型之间加入双向语言转换层：中文自然语言输入经 DeepSeek 等低成本翻译模型转换为英文再发给 Claude；Claude 返回的英文、面向用户的自然语言内容翻译成简体中文；图片及所有非自然语言协议/结构化数据无损透传。

**重要约束与可行性结论：** MAGPIE 的异步请求 Hook 可调用外部翻译 API 并修改请求，但其异步 onResponse 仅用于完成通知，不能修改实时回复；同步 Gateway Middleware 无网络 I/O。因此，完整双向翻译的首选技术路线是 **Provider Plugin 的 auth.loader.fetch + MAGPIE 本地 Gateway 回环调用**，但“虚拟 Provider 可复用现有 Claude 账户、同时保持完整流式协议”的具体实现必须先通过 P0 实测，不能视为已经实现。未通过 P0 不得宣布双向功能可交付。

## 1. 背景与问题

用户习惯以简体中文在 Claude Code 中提需求，希望 Claude 实际收到英文自然语言请求，并将 Claude 的英文说明以中文展示。用户要求控制翻译成本，可使用 DeepSeek 及未来更便宜的模型。现有 MAGPIE 承担 Claude 模型/账户路由，不希望改源码、维护独立服务或放弃原有订阅账户。

### 1.1 核心价值
- 语言解耦：用户输入/界面继续中文，Claude 面向用户的自然语言上下文以英文交互。
- 插件化：安装、启用、升级和卸载均由 MAGPIE 管理。
- 低成本：翻译模型可配置，优先选用低延迟、非推理的低价模型。
- 协议安全：代码、命令、工具调用、图片、推理签名和缓存相关字段绝不因翻译而损坏。

### 1.2 明确不承诺
- “Claude 上游请求中 100% 不含中文字符”不作为 MVP 承诺：源代码、文件内容、工具结果、图片中的可见文字可能仍包含中文；这些内容要求透传。MVP 保证的是 **被定义为待翻译的用户自然语言区块进入 Claude 前已英文转换**。
- 不保证英文中转能提高 Claude 的推理或编程质量；需要 A/B 验证。
- 不保证 MAGPIE 会原生开放对已有 Provider fetch 的透明包装接口；需先验证回环方案。

## 2. 目标、指标与优先级

| 编号 | 目标 | MVP 验收口径 | 优先级 |
|---|---|---|---|
| G1 | 输入英文化 | 对启用的目标请求，所有识别为中文自然语言的用户输入区块翻译后才向 Claude 发起上游请求；翻译失败时不透传原文 | P0 |
| G2 | 输出中文化 | Claude 正常英文自然语言回复以简体中文呈现；不得更改工具调用/结构化块 | P0 |
| G3 | 多模态透传 | 图片 URL、base64、media_type、来源字段及顺序逐字节保留 | P0 |
| G4 | 工具调用兼容 | tool_use id/name/input、tool_result、工具选择、顺序、配对关系不破坏 | P0 |
| G5 | 原生安装 | 仅安装 MAGPIE 插件；无独立守护进程；无需修改 MAGPIE 源码 | P0 |
| G6 | 可观测与成本 | 提供调用次数、延迟、翻译 token 与费用估算，不输出隐私原文 | P1 |
| G7 | 性能 | 500 个中文字符内的输入翻译，额外耗时 p95 目标不超过 3 秒（在稳定外网基准下测量，非 SLA） | P1 |

失败条件：不得把失败的中文输入悄悄发送给 Claude；不得用有损翻译代替代码和工具的原始协议内容。

## 3. 目标用户与场景

- 主要用户：将 Claude Code 接入 MAGPIE 的中文开发者。
- 核心场景：中文描述代码排错、重构、读日志、Agent 执行需求；英文 Claude 结果由插件显示为中文。
- 图片场景：用户提供图片并追加中文说明；只翻译中文说明，原始图片块透传。
- 混合场景：中文自然语言夹杂 shell、JSON、路径、模型标识和函数名；仅翻译解释性文本。
- 多轮场景：用户连续提问，模型历史消息、调用结果、翻译缓存不造成语义往返漂移。
- 兼容场景：关闭插件或选择未覆盖的模型后，MAGPIE 与 Claude Code 按原方式运行。

## 4. 产品范围

### 4.1 MVP 包含
1. MAGPIE 插件打包、安装、配置和开启/关闭。
2. 虚拟模型映射：例如 bilingual/claude-sonnet → 原 MAGPIE 已配置的具体 Claude 模型 ID。
3. DeepSeek / OpenAI-compatible 翻译 API（模型名、baseURL、温度、超时、并发、重试均可配置）。
4. 输入自然语言的中文识别与英文翻译；英文原文可直接放行。
5. Claude 输出的面向用户自然语言英文→简体中文翻译。
6. Anthropic Messages API 的请求/响应、SSE、取消与错误透传。
7. 图片与结构化内容无损处理；缓存、失败策略、隐私保护和最小日志。
8. 最小测试集与 P0 可行性验证报告。

### 4.2 MVP 不包含
- 中文 OCR、图片编辑、音视频字幕翻译。
- 翻译工具执行结果、代码文件、JSON/Shell 源文本。
- 任意 Agent/任意协议的通用转发（先覆盖 Claude Code + Anthropic Messages）。
- 在 MAGPIE 之外部署额外 Node/Python 服务。
- 修改 MAGPIE、Claude Code 或现有 Claude Provider 的源码。
- 自动上传仓库中任何密钥、用户对话与真实项目文件。

## 5. 用户操作流程

1. 安装插件并在 MAGPIE 中启用；配置翻译 API Key（仅通过受保护的凭据保存机制），选择翻译模型与目标 Claude 模型。
2. 在 Claude Code 中选择 bilingual 虚拟模型；无须改变用户输入语言。
3. Claude Code 向 MAGPIE 发送请求；插件仅提取应翻译的文本块，调用翻译模型。
4. 输入翻译成功后，插件对原请求做局部替换，保留原消息角色、序列及所有非翻译字段。
5. 插件通过 MAGPIE Gateway 请求原生 Claude 模型；不可回环至同一 bilingual 虚拟模型。
6. 收到 Claude 响应后，对用户可见的普通文本块翻译为中文，并重组正确的 Anthropic 响应/SSE 事件。
7. Claude Code 收到中文说明，工具调用流程保持原样。
8. 如翻译服务不可用：输入阶段阻断，输出阶段提供受控英文原文降级并提示（或按严格模式失败），不能静默成功。

## 6. 功能需求

### FR-01 插件接入与目标路由（P0）
- 采用 MAGPIE 标准插件打包结构：package.json + Provider 插件入口；不改主程序。
- 提供独立命名空间 bilingual/*，与原 Claude 模型 ID 严格区分。
- targetModel 必须匹配 MAGPIE /v1/models 中已启用且支持所需协议的模型。
- 请求递归深度上限为 1；禁止 targetModel 指向 bilingual/*；对网关断线、认证失败、路由 404 返回可诊断错误。
- 只允许向本地回环网关发 Claude 请求（默认 127.0.0.1:3425，实际端口从只读配置发现），避免开放代理/SSRF。
- 不直接读取、复制或导出 Claude 订阅凭据；通过 Gateway 路由复用已有账户能力。

### FR-02 输入内容分类和翻译（P0）
- 只翻译明确识别为自然语言的文本；先处理 Claude Code user role 的 text block。
- system 文本可按单独开关决定是否翻译，默认不改动，以避免破坏 Claude Code 的 Agent 指令；由此不提供“全部文本都是英文”的绝对承诺。
- assistant history：对插件先前翻译过的回复尽可能还原原始英文；未经识别的历史文字不得盲目二次翻译。
- 工具调用及工具结果默认原样透传；附带中文的源文件/日志不变。
- 用占位符保留 fenced code、inline code、JSON 对象、URL、路径、命令、变量名、UUID、占位令牌及其他关键字节串，翻译完成后验证占位符一一对应再还原。
- 模型输出如丢失/篡改占位符、为空、格式错误或明显未翻译，则本次输入失败并停止上游调用；最多进行有界重试。
- 中英文混排时仅翻译自然语言语义，保留代码原样。
- 请求体中包含 image blocks 时，不向翻译服务发送图片二进制或 base64。

### FR-03 输出中文化（P0）
- 只转换 assistant 的可显示 text block，不修改 thinking、redacted_thinking、signature、tool_use、tool_result、usage、stop_reason 和 message id。
- 非流式响应：翻译所有符合规则的 assistant 文本，再返回符合 Anthropic Messages 规范的 JSON。
- 流式响应：逐个完整 text block 缓冲，翻译后生成合法 content_block_delta；按事件索引与边界保持正确顺序；未翻译的工具/思考事件原样转发。
- 默认“块完成后显示”：比逐 token 显示更慢，但能避免不完整句翻译错乱；分句低延迟模式为后续增强。
- 流末尾、取消、错误和 content_block_stop 必须正确处理；输出翻译失败可按配置降级为原英文并标记 translation_fallback=true（本地日志/指标），不应伪称已完成中文翻译。
- 用户可禁用输出翻译，仅启用输入英文化。

### FR-04 多轮一致性（P0）
- 保存每个会话的源文（用户中文）、发给 Claude 的英文、Claude 原始英文响应与最终中文显示的映射摘要。
- 优先用 session + role + content hash 做可复用缓存；默认仅进程内存保存，禁止默认写入明文磁盘。
- 后续请求若重新携带已翻译的 assistant 中文历史，优先按完整匹配恢复英文原文；未命中时保留原文并记录可观测警告，不得冒然替换其他角色的内容。
- 重新启动/内存缓存丢失后必须安全降级；不能假装已保留跨重启历史映射。
- 对 Claude Code 的上下文压缩、子 Agent、工具循环建立回归测试；需要评估原文英语恢复能力。

### FR-05 失败与边界（P0）
- 输入翻译默认 fail-closed：任何翻译超时、鉴权失败、协议校验失败都不得向目标 Claude 发送待翻译的中文自然语言。
- 输出翻译默认 fail-open-to-English：Claude 已成功生成内容时可返回英文，且给出明确提示；严格模式可选择中断。
- 上游 Claude 非 2xx 错误与 SSE error 不应被翻译服务掩盖；保留 HTTP 状态/错误类型供客户端处理。
- 对长文本设置大小上限、翻译切块、总时限及取消传播，防止无限占用资源。
- 如果检测到危险的多路循环路由，立即阻断，输出可定位的错误码。
- 不因 Markdown、Unicode、Emoji、反引号、无效 UTF-8 或连续 SSE 分块破坏消息结构。

### FR-06 配置与管理（P1）
- enable、inputTranslation、outputTranslation、targetModels、translator.baseURL、translator.model、timeoutMs、retries、concurrency、maxTextChars、cacheTTL、outputFallback、logLevel。
- 输入翻译默认为开；输出翻译默认开；targetModels 采用用户显式选择，不自动覆盖其他模型。
- 翻译凭据通过 MAGPIE 受保护的登录/认证数据或操作系统安全机制存放；不能把真实 key 写在 package.json、插件 Options JSON、环境示例或仓库。
- 记录翻译模型响应耗时、tokens、成功率和估计成本；价格仅作为配置项，不硬编码会变动的官方价格。

### FR-07 隐私与安全（P0）
- 明确告知：插件会将选中的用户输入、Claude 输出文本发送给第三方翻译模型；这是额外的外传目的地。
- 不上传图片原始数据；不记录请求/回复的明文文本、API Key、Cookie、认证头。
- 通过内容分类与脱敏占位符减少密钥/隐私泄露；不得声称对自然语言中的所有秘密有百分之百检测能力。
- TLS 请求；默认仅允许可信的翻译 API HTTPS 地址；阻断将翻译 API 指向未明确允许的本地/私网目标。
- 日志保留诊断码、长度、耗时、token 与费用估算；对请求、用户 ID、session ID 进行不可逆摘要处理。
- Git 仓库使用 .gitignore 阻止 .env、credentials、会话文件、日志和真实配置提交。

## 7. 架构（技术假设，P0 必须验证）

**推荐路线：一个 Provider Plugin，使用 MAGPIE 插件宿主 Bun 的 fetch 完成双向翻译，不另起外部服务。**

流程：

    Claude Code (中文)
      ↓ Anthropic Messages
    MAGPIE → bilingual/claude-sonnet （虚拟 Provider）
      ↓ 插件 auth.loader.fetch
    翻译模型（中文→英文）
      ↓ 替换用户自然语言 text blocks
    MAGPIE local Gateway /v1/messages（内部请求，原生 claude/... 模型）
      ↓ MAGPIE 已有 Claude Provider / 用户已有账户
    Claude 生成英文 + 工具/图片协议块
      ↓ 插件读取 JSON / SSE、对 text blocks 调用翻译模型（英文→中文）
    MAGPIE → Claude Code（中文说明 + 原样协议块）

为什么不用“两个 Async Hooks”：Async onRequest 可 await 外部 API，但失败或超时时 MAGPIE 默认保留原始请求（fail-open）；异步 onResponse 无法修改实时响应。同步 Middleware 可修改响应，却无法直接 fetch 翻译模型。想达成两向调用与输入 fail-closed，需要把请求生命期置于可控的 Provider fetch 中，或先提出其他已验证插件接口；不可将普通 Middleware 描述为具备外部网络能力。

### 7.1 回环路由约束
- 内部模型为明确原生 provider/model，不得再指向 bilingual/*。
- 使用 MAGPIE 官方支持的本地 gateway 客户端调用机制；本地 app key 用于请求归类而不是复制订阅 token。
- 内部请求需要传入唯一 trace 标记并遵守会话隔离；应实测是否在网关重复触发全局插件钩子。
- 处理由 MAGPIE 本地 Gateway 产生的模型解析、订阅失败、网关关闭、额度耗尽等错误。
- 限制请求环深度与并发，不能在插件初始化时调用自身造成死锁。
- 明确 P0 检查：回环调用是否能复用已登录的 Claude 订阅账号；若不能，暂停双向方案，不能偷偷要求新 Claude API Key。

### 7.2 SSE 处理器约束
- 解析 SSE frame 而不是直接 string.replace；处理跨 chunk 的 UTF-8 与 data: 行。
- 保留 message_start、message_stop、ping、message_delta、content_block_start/stop、thinking/signature、tool_use 等事件和字段。
- 只在 text_delta 类型且属于 assistant 文本时替换；缓存文本直到对应块完结，再转出新的 delta。
- 正确处理 stop_reason（尤其 tool_use）、用量、错误、AbortSignal 和背压。
- 如未能完整识别当前协议版本，返回可诊断失败，不得生成伪合法流。

### 7.3 成本/性能模型
- 一次完整交互通常增加至少两次翻译请求（输入、输出），超长或分块文本会更多。
- 延迟：T_total ≈ T_in_translate + T_claude + T_out_translate + 解析/缓冲。
- 计费：按翻译模型的输入/输出 token 和实际响应 usage 统计，不把 Claude 的 token 成本与翻译成本混淆。
- 优先使用低价非推理模型，首次默认候选 DeepSeek 的低延迟聊天模型；实际 model ID 和价格按部署当日官方文档/真实可用性确认，不将“Flash”固定为已验证可用模型名。
- 缓存命中不重复请求翻译模型；不得缓存含密钥或超敏感文本的未脱敏明文到磁盘。

## 8. 示例与验收用例

**输入示例：** 帮我检查 /Users/example/project 下的 API 代码，为什么返回 502？
**上游预期：** Inspect the API code under /Users/example/project and determine why it returns HTTP 502.
其中路径和 HTTP 状态码必须原样保留。

**带图示例：** 用户提交 image(base64 bytes) + “请解释图片中的报错”。应仅转换文本为 “Please explain the error shown in the image.”，图片 data/media_type/source 保持与输入完全一致。

**工具例子：** Claude 返回 tool_use(name=functions.shell, input={command:"pwd"})，中间件不得翻译命令或 tool_use 块；英文说明文字可转换成中文。

## 9. 验收标准（Definition of Done）

| ID | 测试 | 通过要求 |
|---|---|---|
| AT-01 | 简体中文单轮请求 | Claude 上游记录中的被翻译文本为英文；没有中文原文绕过 |
| AT-02 | 中文 + 英文 + 路径 + 代码 | 语义正确；路径、代码、数字、URL、变量逐字节保留 |
| AT-03 | 图片 + 中文说明 | 图片 payload 摘要及 MIME/来源字段相同；说明变英文 |
| AT-04 | DeepSeek 401/429/5xx/超时 | 输入失败时 Claude 的请求数为 0，用户得到明确错误 |
| AT-05 | 英文长文本非流式 | 中文显示且 Anthropic JSON schema 校验通过 |
| AT-06 | SSE 多 chunk/多 text blocks | JSON/事件索引/顺序正确，最后完整 message_stop |
| AT-07 | tool_use + tool_result 多轮 | tool id、input、result、stop_reason 无损；工具连续执行成功 |
| AT-08 | 思考块和签名 | thinking/signature/redacted_thinking 原样透传且不参与翻译 |
| AT-09 | 取消操作 | AbortSignal 取消 Claude 与翻译请求，释放流与缓冲 |
| AT-10 | 回环与原账户 | 调用原生 MAGPIE Claude 模型成功；使用既有登录；无递归死锁 |
| AT-11 | 多轮历史 | 已映射的 assistant 中文历史能够恢复英文；缓存未命中时有警告 |
| AT-12 | 未启用模型与插件关闭 | 不拦截、不改变原来的 Claude Code/其他 Agent 行为 |
| AT-13 | 隐私与公开仓库 | 无真实密钥、敏感日志、用户个人路径或会话数据 |
| AT-14 | 中文转英文失败注入 | 明确阻断并记录分类错误，不将原中文发送给 Claude |

P0 Gate 必须通过 AT-01、03、04、06、07、10、14 的最小可运行 Spike 才进入正式开发。

## 10. 分阶段实施

| 阶段 | 产物 | 退出条件 |
|---|---|---|
| P0 接口验证 | 最小虚拟 Provider、内部 Gateway 调用、真实 Claude 账户与流式闭环测试 | AT-10 通过；确认不改 MAGPIE、不运行外部代理的可行性 |
| P1 输入翻译 | DeepSeek 接口、语义切分、占位符、fail-closed、安全配置 | AT-01/02/03/04/14 通过 |
| P2 输出翻译 | JSON/SSE 翻译、工具/思考块透传、AbortSignal | AT-05/06/07/08/09 通过 |
| P3 多轮与质量 | 会话映射、缓存、日志、成本指标与安全回归 | AT-11/12/13 通过，基准报告出炉 |
| P4 发布 | 版本化插件包、安装说明、示例配置和公开发布 | 干净环境安装/卸载成功 |

### 10.1 P0 最小验证步骤
1. 在隔离 HOME 下加载最小 MAGPIE Provider Plugin，注册 bilingual/test 模型。
2. 验证插件 auth.loader.fetch 收到真实 Anthropic Messages 请求体与 SSE。
3. 用官方本地 Gateway 的 /v1/models 获取精确原生 Claude 模型 ID，发起一次内部 /v1/messages 请求。
4. 记录该请求能否使用现有订阅账号、请求是否再次进入插件、是否发生递归。
5. 用模拟翻译函数只改一个 user text，跑一次完整中文→英文→Claude→中文的非流式闭环。
6. 再测试 Claude Code 真实流式 tool_use、image input 和停止取消。
7. 如果不能通过，提交阻塞结论与替代方案评估；禁止将单向 Hook 伪装成完整双向插件。

## 11. 风险、决策与开放问题

| 风险/问题 | 影响 | 缓解与决策 |
|---|---|---|
| MAGPIE 的 Provider fetch 回环原生订阅不可用 | 插件无法完成双向能力 | P0 强制验证；不修改源码、不偷用 token |
| 异步请求 Hook 失败时默认透传原文 | 违反英文上游要求 | 核心路径不依赖该 Hook 做 fail-closed；用 Provider fetch 自己控制是否转发 |
| onResponse 无法异步修改直播流 | 输出无法用 DeepSeek 翻译 | 在插件 fetch 中读完整/分块 SSE 并重建 |
| 翻译改变工具语义/代码 | Agent 执行失败 | 结构化 block 直通、占位符校验与回归 |
| Stream 缓冲导致首字延迟 | 体验下降 | 初版按块翻译、量化时延；后续增量分句 |
| 多轮历史中出现重复翻译 | 语义漂移、费率增加 | 原始英文映射、session 缓存、显式未命中行为 |
| 第三方翻译外传业务数据 | 隐私/合规 | 明示与最小化、脱敏、禁明文日志、翻译服务可换 |
| 公开 GitHub 仓库泄漏密钥 | 严重安全问题 | 空白配置示例、Git ignore、提交前扫描 |

尚待决策：严格模式是否也翻译系统提示词、是否翻译中文工具结果（默认否）；输出翻译失败时英文放行或直接终止；需要支持哪些 Claude 模型映射；未来是否支持其他翻译商。以上不阻塞 P0。

## 12. 文档和资料来源

- MAGPIE 官方插件机制、Provider auth.loader.fetch、Async Gateway Request Hooks、Gateway Middleware：https://usemagpie.ai/docs/plugins
- MAGPIE 本地 Gateway 地址、Anthropic Messages 路径、模型 catalog、客户端身份：https://usemagpie.ai/docs/integrate
- MAGPIE 基础工作流与本地路由：https://usemagpie.ai/docs/start
- DeepSeek API 文档（模型与报价以实时官方版本为准）：https://api-docs.deepseek.com/

> 备注：本 PRD 是需求与技术验证计划，并非已经实现的插件。公开仓库目前仅含文档，所有“可复用原生 Claude 账户”的描述均属于待验证条件。
