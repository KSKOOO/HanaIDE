# Provider 兼容层规范

> 本目录是 hana 唯一的 provider-specific payload 兼容层。
> 任何按 provider 走分支的代码都必须遵守本文件规则。

## 核心纪律

1. **唯一对外入口**：所有出站 payload 兼容必须经过 [`core/provider-compat.js`](../provider-compat.js) 的 `normalizeProviderPayload(payload, model, options)`。chat 路径（`engine.js` 注册的 `before_provider_request` 钩子）和 utility 路径（`llm-client.js` 的 `callText`）共享这一个入口。需要在 provider serializer 之前处理的 replay/history 规则走同文件的 `normalizeProviderContextMessages(messages, model, options)`。
2. **通用补丁留主入口**：与 provider 无关的处理（空 tools 数组剥离、按 `compat.thinkingFormat` 剥离不兼容的 `thinking` 字段、移除 SDK 注入的隐式 output cap、孤儿 toolResult 配对兜底、按 `compat.audioTransport` 执行音频 transport pre-pass）写在 `provider-compat.js` 主入口或同目录通用 helper。孤儿 toolResult 兜底逻辑在 [`tool-pairing.js`](tool-pairing.js)（provider-agnostic helper，删除 OpenAI-compatible 序列化 payload 里父 `tool_calls` 已被 SDK 丢弃的 `role:"tool"`，issue #1285），由主入口 `stripOrphanToolMessages` 调用；它不是 provider 子模块（无 `matches`/`apply`），不进 first-match-wins 分发。
3. **Provider-specific 补丁拆子文件**：每个 provider 一个 `core/provider-compat/<name>.js`，互不串扰。
4. **接口契约**：每个子文件 export `matches(model) → boolean`（必须容忍 `model = null/undefined`，不抛错）和 `apply(payload, model, options) → payload`（不可 mutate 输入 payload）。如果该 provider 有 serializer 前的 replay/history 约束，可以额外 export `normalizeContextMessages(messages, model, options) → messages`。
5. **dispatch 单调性**：dispatcher 按数组顺序遍历，第一个 `matches` 返回 true 的子模块负责处理（first-match-wins）。一个 model 只匹配一个子模块。新 provider 默认加在数组末尾；只有当模块的 `matches` 是另一模块的子集（更具体的规则）时才前置，避免被通用规则吞掉。
6. **禁止散落**：调用点（`callText`、`engine.js` 钩子、route handler 等）禁止内联 provider-specific 补丁。一旦发现，迁移到本目录。

## 新增 provider 补丁的步骤

1. 在 `core/provider-compat/` 下新建 `<provider>.js`
2. 文件顶部 JSDoc 注释必须写明：
   - 处理的 provider（`provider` 字段值或 baseUrl 模式）
   - 解决的具体协议问题（链接到官方文档）
   - **删除条件**（即什么情况下整个文件可整块删掉）
3. export `matches(model)` 和 `apply(payload, model, options)`，签名见下文
4. 在 `core/provider-compat.js` 的 `PROVIDER_MODULES` 数组末尾加入 import
5. 在 `tests/provider-compat/<provider>.test.js` 加测试：
   - `matches` 真值表（正例 / 反例 / `model=null`）
   - `apply` 在 `mode: "chat"` 和 `mode: "utility"` 两种上下文的行为
   - 不可变性断言（apply 不 mutate 输入 payload）

## 升级 SDK 时的检查清单

升级 `@mariozechner/pi-coding-agent` 或 `@mariozechner/pi-ai` 后必须执行：

1. 跑 `npm test` 全套，重点关注 `tests/provider-compat.test.js` 和 `tests/provider-compat/*.test.js`
2. 检查每个 `provider-compat/*.js` 顶部的"删除条件"，对照 SDK 升级 changelog 看是否还需要保留
3. 如果某个 provider 子模块的删除条件已满足（SDK 升级后官方一等公民化），删除该文件并从 `PROVIDER_MODULES` 移除 import
4. 如果 SDK 改了 `convertMessages` 后的 assistant payload 形态（尤其是 `message.content` 字符串 / 数组边界，影响 `reasoning-content-replay.js` 的 `extractReasoningFromContent`），更新 extract 逻辑和相关 provider replay 测试

## 接口契约

### `matches(model) → boolean`

```js
/**
 * 判断本模块是否处理这个 model。
 *
 * 实现要求：
 *   - 纯函数，无副作用
 *   - 优先用 provider / baseUrl / quirks / compat.thinkingFormat 等数据声明字段，避免按 model.id 字符串硬匹配
 *   - 必须容忍字段缺失：遇到 model = null/undefined 或目标字段不存在时返回 false，
 *     不抛错（dispatcher 不能因为某个子模块的 matches 崩溃影响其他模块）
 *   - 不可依赖 `this`：dispatcher 通过 `import * as mod` 的 namespace object 调用，
 *     namespace 是 frozen 的且无 `this` 上下文。matches 与 apply 都必须是顶层导出的独立函数
 */
export function matches(model) { ... }
```

### `apply(payload, model, options) → payload`

```js
/**
 * 对 payload 应用本 provider 的全部兼容补丁。
 *
 * 实现要求：
 *   - 不可变契约：返回新对象（或原对象，未修改时）；不直接 mutate 调用方传入的 payload
 *   - 必须能处理 mode: "chat" 和 mode: "utility" 两种调用上下文
 *   - 必须能容忍 model 字段缺失（保守处理，宁可不补也别错补）
 *   - `options` 字段是开放扩展的：dispatcher 把调用方传入的整个 options 透传给所有子模块；子模块按需读取自己关心的字段，未识别的字段必须忽略，不报错
 */
export function apply(payload, model, options) { ... }
```

## Thinking 格式声明

`reasoning` 只表示模型具备思考能力，不表示请求体该使用哪种字段。
请求侧思考控制统一由 `model.compat.thinkingFormat` 表示：

| 值 | 请求体格式 | 例子 |
|---|---|---|
| `anthropic` | `thinking: { type, budget_tokens }` | Anthropic、Kimi Coding、MiniMax Anthropic API |
| `qwen` | `enable_thinking: boolean` | DashScope / SiliconFlow / ModelScope 上的 Qwen-style 模型 |
| `qwen-chat-template` | `chat_template_kwargs: { enable_thinking, preserve_thinking }` | MiMo OpenAI-compatible API, including Xiaomi Token Plan `/v1` endpoints |
| `zhipu` | `thinking: { type, clear_thinking }` | Zhipu / BigModel GLM OpenAI-compatible API |
| `deepseek` | DeepSeek 子模块统一转换 | DeepSeek V4 / reasoner |
| `openrouter` | `reasoning: { effort }`，历史推理细节由 SDK 通过 `reasoning_details` 回放 | OpenRouter-hosted reasoning models, e.g. DeepSeek / MiMo via OpenRouter |
| `kimi` | `thinking: { type, keep? }` + `reasoning_effort`，历史推理用 `reasoning_content` 回放 | Kimi Code `/coding/v1`、Moonshot OpenAI-compatible thinking models |

`compat.reasoningProfile` 表示同一 wire format 内部更细的协议契约，例如
`deepseek-v4-anthropic` 表示 Anthropic Messages 请求体，但思考强度要写入
`output_config.effort`，并且工具调用历史需要在 serializer 前校验 thinking replay。

`core/model-sync.js` 会在投影 `models.json` 时把已知模型能力补成显式
`compat.thinkingFormat` / `compat.reasoningProfile`。`shared/model-capabilities.js`
保留旧 `models.json` 的读时兼容，避免升级后必须重新保存 provider 才恢复思考。

## 新增 FRC / Thinking 模型的维护规则

接入新模型时按下面顺序判断，避免把 provider 契约散到调用点：

1. 先确认模型是否具备 `reasoning` 能力。`reasoning: true` 只打开 UI / 偏好层的思考控制，不决定请求字段。
2. 再确认请求体大类，优先复用已有 `compat.thinkingFormat`：`anthropic`、`qwen`、`deepseek` 等。
3. 如果新模型和现有 format 使用同一种 wire format，但参数名、强度枚举、tool call 历史或 replay 规则不同，新增 `compat.reasoningProfile`。
4. profile 推导优先使用显式 `model.compat.reasoningProfile`；读时兼容可以在 `shared/model-capabilities.js` 基于 provider / baseUrl / api / known model family 推导。
5. profile 的具体行为只写在 `core/provider-compat/<provider>.js`：payload 映射走 `apply()`，serializer 前的历史校验走 `normalizeContextMessages()`。
6. 每个 profile 都要有测试覆盖：model-sync 投影、profile 推导、chat payload、utility payload、历史回放规则。

判断标准：如果换一个同 format 的 provider 之后规则还成立，放进 `thinkingFormat`；如果只对某个 provider 或某个模型族成立，放进 `reasoningProfile`。

## 输出预算策略

`maxOutput` / `model.maxTokens` 在 Hana 数据层表示模型能力上限，不表示每次请求的默认输出长度。
Pi SDK 的 `streamSimple` 会在调用方未传 `maxTokens` 时，把 `min(model.maxTokens, 32000)` 注入请求体。
对 OpenAI-compatible / Gemini / Mistral 这类 output cap 可省略的 provider，这会把 Hana 的模型能力 metadata
误变成本次请求策略，改变供应商默认行为，也可能与 thinking budget 冲突。

通用层通过 `provider-compat/output-budget.js` 处理这件事。该文件内部维护
`OUTPUT_CAP_CAPABILITIES`，集中声明 output cap 是否必填、是否需要保留 SDK
默认值，并通过 `resolveOutputBudgetPolicy()` 把请求来源、provider 能力和
是否可移除隐式 SDK 默认值收敛成一个可测试的策略对象，避免把 provider 规则散落在调用点。

1. chat 请求中，如果 payload 的 output cap 等于 Pi SDK 从 `model.maxTokens` 推导出的隐式默认值，则移除该字段，让供应商默认生效。
2. utility 请求由具体消费任务决定预算。`callText` 不从 `model.maxTokens` 合成默认 output cap；标题、健康检查、记忆摘要等任务需要限制长度时必须显式传 `maxTokens`。
3. Anthropic / Bedrock / `anthropic-messages` 这类协议必填 output cap 的 provider 不移除调用方显式传入的 cap；如果调用方未声明预算，通用层不替它推导。
4. 官方 DeepSeek endpoint 不移除显式 cap，继续交给 `deepseek.js` 统一转换字段并确保 thinking 输出预算合法。
5. 真正的用户级或系统级单次输出上限，调用方必须通过 `options.outputBudgetSource = "user" | "system"` 或等价显式 source 传入，通用层不得静默移除显式意图。
6. chat hook 拿不到 Pi SDK `maxTokens` 的来源，保持 source 为 `unspecified`；兼容层只在字段值等于 Pi SDK 隐式默认时移除，避免误删未来真实的非默认上限。

## 音频输入 transport

Hana 内部用 `{ type: "audio", data, mimeType }` 表示当前轮音频。UI、SessionFile、历史恢复、`@附件`、压缩与缓存逻辑只处理这个内部语义，不按 provider 写分支。

出站请求分两步：

1. `core/provider-media-serializer.js` 在 utility 路径把当前轮 audio block 直接序列化成 Chat Completions 官方 `{ type: "input_audio", input_audio: { data, format } }`，其中 `format` 只允许 `wav` / `mp3`。
2. chat 路径仍经过 Pi SDK，它会把非 text block 统一输出成 `image_url` data URL。`normalizeProviderPayload()` 在 first-match-wins provider 子模块之前，根据 `shared/model-capabilities.js` 的 `resolveModelAudioInputTransport(model)` 执行 audio transport pre-pass。当前 `mimo-input-audio` 与 `openai-input-audio` 都复用 [`input-audio.js`](input-audio.js)，把 Pi SDK 产出的 `data:audio/...` 或旧 canonical audio block 转成同一个 `input_audio` 结构；不支持的音频格式必须显式报错，不允许继续伪装成 `image_url`。

接入未来 DeepSeek 音频时，优先在 known model / provider sync 投影里声明：

```json
{
  "compat": {
    "hanaAudioInput": true,
    "audioTransport": "openai-input-audio"
  }
}
```

如果 DeepSeek 使用不同 wire format，再新增独立 transport 常量和 provider-agnostic helper；不要在 UI、SessionFile、`desktop-session-submit` 或 `session-coordinator` 里写 DeepSeek 分支。

## 已知子模块

| 文件 | 处理 provider | 删除条件 |
|---|---|---|
| [`deepseek.js`](deepseek.js) | DeepSeek 思考模式协议（含 reasoning_content 恢复/校验） | DeepSeek 不再要求回传 reasoning_content；或 pi-ai 直接处理 reasoning_content 字段不再走 thinkingSignature 路标 |
| [`mimo.js`](mimo.js) | MiMo OpenAI-compatible 思考模式协议（chat_template_kwargs + reasoning_content 回放），覆盖官网与 Xiaomi Token Plan `/v1` endpoint | MiMo 不再通过 chat_template_kwargs 控制 thinking；或 pi-ai 原生处理 MiMo replay |
| [`qwen.js`](qwen.js) | Qwen-style 思考模型 `enable_thinking` quirk；DashScope 视频输入复用 `openai-video-url` 转换 | quirks 系统重构 / Qwen-style 协议改成 reasoning_effort；DashScope 和 Pi SDK 原生支持 video_url |
| [`zhipu.js`](zhipu.js) | Zhipu / GLM OpenAI-compatible 思考模式协议（thinking.type、preserved thinking、reasoning_content 回放）与 OpenAI-only 字段清理 | pi-ai 原生处理 GLM thinking 控制、reasoning_content 回放和 Zhipu 不支持的 OpenAI-only 字段 |
| [`input-audio.js`](input-audio.js) | 通用 OpenAI-compatible 音频 transport helper，由主入口按 `audioTransport` 调用，不参与 first-match-wins | Pi SDK / provider serializer 原生按模型 transport 输出正确音频块 |
| [`openai-video-url.js`](openai-video-url.js) | OpenAI-compatible 视频输入 `image_url data:video` → `video_url`，当前用于 Moonshot Kimi 与 DashScope Qwen | Pi SDK 原生按 video MIME 输出 `video_url`；或相关 provider 接受 `image_url data:video` |

子模块的对外 API 仅有 `matches` 和 `apply` 两个 export。其它 export（如 replay helper 的 `extractReasoningFromContent`、`ensureReasoningContentForToolCalls`）属于实现细节、仅供同文件和单元测试访问，**不构成对外契约**。升级 SDK 想删 helper 时不需顾虑外部依赖。

## 历史背景

本架构由 commit `2a9ea17`（README 奠基）至 `0d87520`（llm-client 收口）一系列 commit 引入，根因来自旧 issue #468 中 DeepSeek 思考模式 400 的兼容问题。
