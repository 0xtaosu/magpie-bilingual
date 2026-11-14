# MAGPIE Bilingual Bridge

A proposed **MAGPIE-only plugin** for translating Chinese natural-language requests to English before Claude sees them, and translating Claude's English user-facing replies back to Simplified Chinese.

中文：面向 MAGPIE 和 Claude Code 的双向自然语言翻译插件设计。输入翻译可使用 DeepSeek 或其他 OpenAI-compatible 低成本模型；图片、工具调用、代码和协议字段必须原样保留。

> **Status: PRD / feasibility stage. Not an installable or working plugin yet.**

## Product boundaries

- Plugin only; no MAGPIE source modifications, no standalone proxy service.
- Preserve existing MAGPIE model/account routing if P0 loopback feasibility tests pass.
- Default input translation is fail-closed; output translation can fall back to English.
- Image bytes and structured tool protocol fields are not translated.
- Translation requests send selected natural-language content to a third-party model. Evaluate privacy implications before enabling.

## Documents

- [PRD（中文）](./PRD.md) — scope, architecture, requirements, acceptance criteria and milestones.
- [Technical feasibility and blockers](./docs/feasibility.md) — verified SDK facts vs. hypotheses.
- [Test plan](./docs/test-plan.md) — P0/P1 test matrix.

## Verified API constraints

MAGPIE's async request hook can await external I/O, but its async response hook cannot mutate a live response. The synchronous Gateway Middleware cannot call external APIs. Therefore the full duplex approach is **hypothesized** to use a virtual Provider plugin with an auth.loader.fetch implementation and an internal call to MAGPIE's local gateway; it must be validated before claiming compatibility with existing Claude subscriptions.

References: [Plugin guide](https://usemagpie.ai/docs/plugins), [Gateway integration](https://usemagpie.ai/docs/integrate).

## License

No license has been selected yet. Public GitHub visibility does not itself grant redistribution or modification rights.
