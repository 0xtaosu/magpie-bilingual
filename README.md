# 双语桥接

MAGPIE 原生双向翻译插件：让你用中文提问、用中文看回复，而底层工作模型全程接收和输出英文。

```text
你（中文提问） ──▶ 翻译服务（译为英文） ──▶ 工作模型（Codex / Claude / Grok 等）
                                                      │
你（中文回复） ◀── 翻译服务（译回中文） ◀──────────────┘
```

- **只译自然语言**：图片、代码块、行内代码、路径、命令、JSON 与工具调用均原样透传或保留。
- **不限工作模型**：支持 MAGPIE 中任意已启用的原生模型（Codex、Claude、Grok 等），协议转换与原账号鉴权由 MAGPIE 负责。
- **零侵入、无额外代理**：不修改 MAGPIE 源码，不读取其他供应商凭据，翻译 API Key 由 MAGPIE 受保护存储统一管理。

---

## 快速开始（5 分钟配置）

### 准备工作
1. 正在运行的 **MAGPIE**（插件直接运行在 MAGPIE 内置环境中，无需额外安装 Node 依赖）。
2. 至少一个已在 MAGPIE 中启用的**工作模型**（例如 `codex/gpt-5.4`）。
3. 一个兼容 OpenAI Chat Completions 协议的**翻译服务 API Key**（例如 DeepSeek）。

### 1. 安装插件
在 MAGPIE 左侧进入 **插件 → 添加插件**，选择本仓库文件夹；或通过命令行添加：

```sh
magpie plugin add /absolute/path/to/magpie-bilingual
```

> macOS 若 `magpie` 未加入 `PATH`，可使用 `/Applications/magpie.app/Contents/MacOS/magpie`。

### 2. 配置工作模型与翻译服务
打开 MAGPIE 左侧 **插件 › 双语桥接**：

1. **工作模型**：选择上游供应商，并填入从 MAGPIE 模型目录复制的**模型 ID**（直接粘贴 `供应商/模型` 会自动拆分识别）。
2. **翻译服务**：填写 HTTPS **接口地址**（默认 `https://api.deepseek.com`，请求会自动拼接 `/chat/completions`）与**翻译模型**（如 `deepseek-chat`）。
3. **翻译规则**：按需开关「启用双语翻译」「中文输入译为英文」「模型回复译回中文」。
4. 点击右下角 **保存设置**，然后到 **插件** 页点击**重新加载**使配置生效。

> 若需配置多个映射，可展开 **高级与调试** 修改「客户端模型别名」并保存，页面顶部会出现路由切换标签，原有别名映射会自动保留。

### 3. 填写翻译 API Key 并启用模型
1. 进入 MAGPIE 左侧 **供应商 › 双语翻译代理**，填入翻译服务的 **API Key**。
2. 在该供应商的模型列表中启用 `coding`（或你自定义的别名）。

### 4. 在客户端中使用
在 Claude Code、T3 Code 或其他支持 Anthropic Messages API 的客户端中，将模型选为 `bilingual/coding` 即可开始对话。

---

## 如何确认发给工作模型的是英文？

插件内置了**仅预览发出的译文（调试模式）**，方便你核对翻译效果与代码保留情况：

1. 打开 **插件 › 双语桥接**，展开底部 **高级与调试**。
2. 勾选 **仅预览发出的译文（调试模式）**，点击 **保存设置** 并在 **插件** 页重新加载插件。
3. 用 `bilingual/coding` 发送一条测试消息，对话会直接返回处理后的英文内容（**不会调用工作模型，也不写入插件日志**）。
4. 确认无误后，记得**取消勾选该开关、保存并重新加载插件**，即可恢复正常对话。

---

## 翻译边界与安全保护

| 内容类型 | 处理方式 | 说明 |
| --- | --- | --- |
| 用户中文自然语言 | 译为英文 | 翻译失败、超时或残留未翻译中文时会**中止请求**，绝不把未译原文发给工作模型 |
| 工作模型英文回复 | 译为简体中文 | 默认若输出翻译失败则**回退显示英文原文并附中文提示**；可设为严格报错 |
| 代码块、行内代码、路径、命令、JSON、URL | 原样保留 | 翻译前用随机占位符保护，还原时校验数量与唯一性（重要源码建议使用 ``` 代码围栏） |
| 图片、工具调用、`thinking`、引用（citations） | 原样透传 | 不经过翻译服务，保持原始结构、签名与 `usage` |
| `system` 提示词 | 默认保留原文 | 避免破坏系统指令；如有需要可通过 `translateSystem: true` 开启 |

其他机制说明：
- **多轮会话缓存**：请求带 `X-Magpie-Session` 或 `metadata.user_id` 时，会在内存中按会话缓存历史译文映射以保持多轮连贯；缓存不落盘，重启插件后清空。
- **临时关闭翻译**：在设置页取消勾选「启用双语翻译」即可暂停翻译，请求会直接透传给所选工作模型。若要彻底停用，请先在客户端切回原生模型，再在 MAGPIE 中禁用或卸载插件。
- **隐私与出站控制**：翻译请求仅允许 HTTPS，且受 `translator.trustedOrigins` 白名单限制（禁止 HTTP 与重定向）；常见密钥格式会自动脱敏，但请勿将真实密钥写入插件 Options 或示例中。

---

## 命令行配置（可选）

如果无法打开可视化设置页，或偏好脚本化部署，可直接编辑插件 Options：

1. 在插件 Options 中配置映射与翻译服务（完整无密钥示例见 [config.example.json](config.example.json)）：

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

   > 使用非 DeepSeek 的翻译服务时，如果服务地址带 `/v1` 请包含在 `baseURL` 中，并在 `translator.trustedOrigins` 中加入其 HTTPS origin。

2. 配置翻译服务 API Key 并启用模型：

   ```sh
   magpie plugin login bilingual
   magpie provider models bilingual +coding
   ```

3. 在 MAGPIE 中重新加载本插件。

---

## 高级配置参考

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `enable` | `true` | 翻译总开关 |
| `inputTranslation` / `outputTranslation` | `true` | 分别控制输入译英、输出译中 |
| `translateSystem` | `false` | 是否翻译 `system` 提示词 |
| `previewInput` | `false` | 调试预览模式：仅回显处理后的请求文本，不调用工作模型 |
| `targetModels` | `{}` | 虚拟别名到原生 `provider/model` 的映射 |
| `gateway` | 自动读取本地端口 | 仅允许回环 IP（如 `http://127.0.0.1:端口`） |
| `timeoutMs` | `120000` | 整个请求（含流与翻译）的总时限 |
| `maxTextChars` | `100000` | 单文本块最大字符数 |
| `maxBodyBytes` | `20971520` | JSON 请求/响应体上限（含图片，约 20 MB） |
| `cacheTTL` / `cacheEntries` | `1800000` / `256` | 会话内存缓存有效期（ms）和最大条数；设为 `0` 可关闭 |
| `outputFallback` | `"english"` | 输出翻译失败策略：`"english"`（回退原文）或 `"error"`（报错） |
| `logLevel` | `"error"` | 日志级别：`"silent"` / `"error"` / `"info"` |
| `translator.baseURL` | `https://api.deepseek.com` | OpenAI-compatible 翻译接口地址 |
| `translator.model` | 无 | 必填，翻译模型名称 |
| `translator.trustedOrigins` | `["https://api.deepseek.com"]` | 允许出站的 HTTPS origin 白名单 |
| `translator.timeoutMs` | `15000` | 单次翻译调用时限 |
| `translator.retries` | `1` | 额外重试次数（上限 `3`；4xx 鉴权/参数错误不重试） |
| `translator.concurrency` | `3` | 每个翻译账号的最大并发数 |
| `translator.chunkChars` | `2000` | 长文本切块大小（自动避开占位符边界） |
| `translator.temperature` | `0` | 翻译采样温度 |
| `translator.pricePerMillion` | `{ input: 0, output: 0 }` | 每百万 token 单价估算（仅用于 `info` 日志统计） |

---

## 本地开发与验证

需要 Node.js 22+（无第三方 npm 依赖）：

```sh
npm run build                              # 重新打包设置页 bundle.js
npm test                                   # 运行离线单测与回归测试
npm run test:host                          # 在隔离 HOME 中验证 MAGPIE 加载插件
npm run test:live -- YOUR_PROVIDER/MODEL   # 运行实时回环验证（会消耗少量额度）
```

> Linux 或自定义安装路径可通过 `MAGPIE_BIN` 指定 MAGPIE 可执行文件。

## 文档与许可

- 当前版本：`0.2.0`（候选实现，具体验证结果与限制见 [P0 验证报告](docs/p0-report.md)）
- [PRD](PRD.md)：原需求及任意原生模型的范围补充
- [可行性与剩余验收](docs/feasibility.md)
- [测试计划](docs/test-plan.md)

本项目尚未选择开源许可证，且 `package.json` 标记为 `"private": true`。
