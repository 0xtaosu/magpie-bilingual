import { createBridge } from "./src/bridge.mjs";
import { configuration } from "./src/config.mjs";

export default async function BilingualBridge(_input, options = {}) {
  const settings = await configuration(options);
  const models = Object.fromEntries(Object.keys(settings.targetModels).map((alias) => [alias, {
    name: `双语翻译代理 · ${alias}`,
    tool_call: true,
    modalities: { input: ["text", "image"] },
  }]));
  return {
    config: async (config) => {
      config.provider ??= {};
      config.provider.bilingual ??= {
        name: "双语翻译代理",
        npm: "@ai-sdk/anthropic",
        api: "https://bilingual.invalid/v1",
        models,
      };
    },
    auth: {
      provider: "bilingual",
      methods: [{ type: "api", label: "翻译服务 API Key（用于中英互译，自然语言文本将发送至所选翻译接口）" }],
      loader: async (getAuth) => {
        const bridge = await createBridge(options, async () => {
          const auth = await getAuth();
          return auth?.type === "api" ? auth.key : undefined;
        });
        return { baseURL: "https://bilingual.invalid/v1", apiKey: "bilingual-local", fetch: bridge.fetch };
      },
    },
  };
}
