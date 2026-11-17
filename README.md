# 双语桥接

MAGPIE 原生双向翻译 Provider 插件。Claude Code 通过 Anthropic Messages API 使用 `bilingual/*` 模型：中文自然语言先译为英文，目标模型的英文说明再译成简体中文。**图片透传，代码不翻译；只处理自然语言文字。**

目标模型不限于 Claude：支持 MAGPIE 已启用的 Codex、Claude、Grok 等原生 `provider/model`。协议转换和原账户鉴权由 MAGPIE 完成。插件不读取其他 Provider 的订阅凭据、不修改 MAGPIE 源码、不部署独立代理。

版本：`0.2.0`，候选实现。自动回归、隔离宿主加载及真实 Codex 回环已验证；真实 DeepSeek Flash → Codex → DeepSeek Flash 的单轮请求也已通过，翻译质量与性能仍需完整验收。具体证据和限制见 [P0 报告](docs/p0-report.md)。

## 安装与配置

需要正在运行的 MAGPIE、至少一个已启用的原生模型，以及一个 OpenAI-compatible 翻译服务的 API Key。运行插件使用 MAGPIE 自带的 Bun 宿主，无需安装本项目依赖或构建。

### 可视化设置页

打开 MAGPIE 窗口左侧 **插件 › 双语桥接**。页面按「工作模型 → 翻译服务 → 翻译规则」组织常用项，客户端模型别名与译文预览调试位于折叠的「高级与调试」中，并沿用 MAGPIE 原生控件与主题样式。修改设置后点击「保存设置」，并在 **插件** 页重新加载本插件使其生效；新增别名若未出现在模型目录，还需前往 **供应商 › 双语桥接 › 模型** 中启用。首次配置或更换翻译服务后，请在 **供应商 › 双语桥接** 中更新对应的 API Key。

若需核对实际发送给工作模型的英文，展开「高级与调试」勾选「仅预览发出的译文（调试模式）」，保存并重新加载插件后用 `bilingual/别名` 发起测试对话。开启期间插件只会在对话中回显处理后的 user、历史和 system 文本，**不会调用工作模型**；图片和工具结果仅标记为未显示，代码仍保留原文。排查完成后请关闭该开关、保存并重新加载插件，页面顶部也会在预览模式开启期间给出醒目提醒。预览内容仅在当次响应中返回，不写入插件日志或设置（聊天客户端可能自行保存会话记录）。预览仍会调用所配置的翻译服务；若关闭输入翻译或双语翻译总开关，预览会如实显示未翻译原文。预览期间 token 计数请求返回 0，以保证客户端正常展示诊断回复。

页面可读取 MAGPIE 的供应商列表，但官方页面接口暂不提供模型目录读取权限，因此模型 ID 需从 MAGPIE 模型目录复制（直接粘贴 `供应商/模型` 会自动拆分识别）。当已配置多个虚拟别名时，页面顶部会显示路由切换标签，方便随时切换编辑不同别名并保留其余映射。

如果窗口未显示设置页，确认已安装本项目最新版并在 MAGPIE 的 Plugins 页面重新加载插件；下面的命令行配置仍可使用。

### 命令行配置

1. 在 MAGPIE → Plugins → Add a plugin 中选择本项目文件夹，或：

   ```sh
   magpie plugin add /absolute/path/to/magpie-bilingual
   ```

2. 通过模型目录确认精确目标 ID：

   ```sh
   node scripts/probe.mjs
   ```

3. 在插件 Options 中填写下列配置，替换目标模型和翻译模型名。只配置实际想使用的映射，不会自动接管其他模型。

   ```json
   {
     "targetModels": {
       "coding": "codex/REPLACE_WITH_ENABLED_MODEL_ID"
     },
     "translator": {
       "baseURL": "https://api.deepseek.com",
       "model": "REPLACE_WITH_YOUR_TRANSLATION_MODEL"
     }
   }
   ```

   完整无密钥示例见 [config.example.json](config.example.json)。不预设可能过期的模型 ID 或价格。`baseURL` 后直接追加 `/chat/completions`；供应商使用 `/v1` 时把它包含在 `baseURL` 中。其他供应商还需在 `translator.trustedOrigins` 中显式允许其 HTTPS origin。

4. 从 bilingual Provider 的登录入口输入**翻译服务** API Key，或运行 `magpie plugin login bilingual`。凭据由 MAGPIE 的受保护认证存储管理；不要把 key 填进 Options、源码或配置示例。启用翻译意味着所选输入/输出文本会发送给该翻译服务。
5. 重新加载插件，并在 bilingual Provider 的模型列表中启用 `coding`。如果网关目录仍未显示它，可执行：

   ```sh
   magpie provider models bilingual +coding
   ```

6. 在 Claude Code/MAGPIE 中选择 `bilingual/coding`。API 仍是 Anthropic Messages，后端可以是 Codex。

macOS 若 `magpie` 未加入 PATH，可使用 `/Applications/magpie.app/Contents/MacOS/magpie`。插件默认只读发现 `settings.json` 的网关端口，也可显式设置 `gateway: "http://127.0.0.1:端口"`；只接受 IP 字面量回环地址。

## 行为

- 输入：仅处理 user 文本块；保留图片、工具结果、角色、缓存字段和工具定义。system 默认保留；assistant 历史只进行会话内精确匹配恢复，不盲目反译。
- 代码：代码围栏、行内代码、常见源码行、函数调用、JSON、命令、路径、URL、数字和标识符用随机占位符保护；还原前验证数量与唯一性。无法可靠识别所有语言的裸代码，重要源码请使用代码围栏以明确边界。
- 失败：输入翻译失败、超时、占位符丢失或仍含待翻译中文时阻断，目标模型调用数为零。输出默认回退原文并添加中文提示；`outputFallback: "error"` 可严格失败。
- 流式：按完整 text block 缓冲后显示；thinking、签名、工具 JSON、usage 和 stop_reason 保留。未知事件、非法索引或截断流以诊断错误终止，不伪造成功结束。
- 多轮：有 `X-Magpie-Session` 或 `metadata.user_id` 时，按会话摘要与完整文本摘要缓存；无会话标识则不共享缓存。重启后映射丢失，未命中保留历史原文并记录诊断。
- 引用：包含 citation 的文本块保守透传，避免翻译破坏引用定位，并记录 `citations_passthrough`；这类文本暂不保证中文化。
- `enable: false` 时，虚拟模型仍按映射转发但不翻译。彻底移除虚拟模型请在 MAGPIE 关闭或卸载插件；先让客户端选回原生模型。
- `/v1/messages/count_tokens` 使用相同输入转换后交由原生目标处理；可用性取决于该目标 Provider。

## 配置参考

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `enable` | `true` | 是否翻译 |
| `inputTranslation` / `outputTranslation` | `true` | 两个方向独立开关 |
| `translateSystem` | `false` | 显式允许翻译 system |
| `previewInput` | `false` | 将处理后的文本显示在聊天中，并跳过本次工作模型调用；诊断后关闭 |
| `targetModels` | `{}` | 虚拟别名 → 原生模型 ID，必须显式配置 |
| `gateway` | 只读发现端口 | 只允许回环 IP，不接受远端或重定向 |
| `timeoutMs` | `120000` | 整个请求（含流与翻译）的总时限 |
| `maxTextChars` | `100000` | 单文本块上限 |
| `maxBodyBytes` | `20971520` | JSON 请求/响应体上限，含图片 |
| `cacheTTL` / `cacheEntries` | `1800000` / `256` | 内存缓存有效期（ms）和条数；设 0 可关闭 |
| `outputFallback` | `"english"` | `"english"` 或 `"error"` |
| `logLevel` | `"error"` | `"silent"` / `"error"` / `"info"` |
| `translator.baseURL` | DeepSeek HTTPS origin | OpenAI-compatible 接口 |
| `translator.model` | 无 | 必填，部署时确认可用模型 |
| `translator.trustedOrigins` | DeepSeek origin | 显式信任列表 |
| `translator.timeoutMs` | `15000` | 单次翻译调用时限 |
| `translator.retries` | `1` | 额外重试数，最大 3；不可重试 4xx 不重试 |
| `translator.concurrency` | `3` | 每个翻译账号并发数，等待队列有界 |
| `translator.chunkChars` | `2000` | 脱敏文本切块大小，不切断占位符 |
| `translator.temperature` | `0` | 翻译采样温度 |
| `translator.pricePerMillion` | input/output 均为 0 | 每百万 token 单价；未填不代表服务免费 |

info 日志包含翻译调用、成功/失败、缓存命中、耗时、输入/输出 token 和估算费用事件，只统计翻译 API，不记录对话正文和认证信息。流式回退通过可见提示和 `translation_fallback` 日志标识；非流式还带 `x-bilingual-translation-fallback: true`。

内存缓存不写磁盘，但短暂持有译文和还原映射；`logLevel: "silent"` 可关闭本插件日志。上游 MAGPIE 的日志策略由其设置控制。HTTPS 信任名单是出站授权边界：显式加入某个 origin 即允许访问该 origin，包括它解析到的私网目标。插件禁用 HTTP 翻译端点和重定向。常见密钥模式会脱敏，但不能保证识别自然语言中的所有秘密。

## 验证

Node.js 22+，无 npm 依赖：

```sh
npm test
npm run test:host
npm run probe -- YOUR_PROVIDER/YOUR_MODEL
npm run test:live -- YOUR_PROVIDER/YOUR_MODEL
```

- `test`：离线协议、失败、代码保护、隐私与缓存回归。
- `test:host`：临时隔离 HOME 中检查 MAGPIE 加载生产插件，完成后清理。
- `probe` 无参数只读检查模型；带模型参数会通过现有账户发出两个小型合成请求。
- `test:live`：临时 MAGPIE 实例中加载翻译测试替身和原生模型测试转接 Provider，验证同实例回环，再通过既有网关使用目标账户。会消耗少量目标模型额度，不上传真实项目文本，不复制订阅凭据；结束后清理临时实例。

Linux/其他安装位置通过 `MAGPIE_BIN` 指定 MAGPIE 可执行文件。脚本从项目根目录执行。翻译替身只处理合成文本，不能用于真实翻译；生产入口从不加载测试替身。

## 文档与许可

- [PRD](PRD.md)：原需求及任意原生模型的范围补充。
- [可行性与剩余验收](docs/feasibility.md)
- [P0 验证报告](docs/p0-report.md)
- [测试计划](docs/test-plan.md)

尚未选择许可证；包标记为 private 防止误发布。公开仓库可见性不自动授予再分发许可。
