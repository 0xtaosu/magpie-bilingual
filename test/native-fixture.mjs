export default async function NativeFixture(_input, options) {
  return {
    config: async (config) => {
      config.provider ??= {};
      config.provider["p0-native"] = {
        name: "P0 existing-account relay",
        npm: "@ai-sdk/anthropic",
        api: "https://p0-native.invalid/v1",
        models: { test: { name: "P0 native test", tool_call: true, modalities: { input: ["text", "image"] } } },
      };
    },
    auth: {
      provider: "p0-native",
      methods: [{ type: "api", label: "Synthetic test account" }],
      loader: async () => ({
        baseURL: "https://p0-native.invalid/v1",
        apiKey: "fixture",
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const body = await request.json();
          body.model = options.targetModel;
          return fetch(`${options.gateway}/v1/messages`, {
            method: "POST", signal: request.signal,
            headers: { authorization: "Bearer magpie-bilingual-live-test", "content-type": "application/json", "anthropic-version": "2023-06-01" },
            body: JSON.stringify(body), redirect: "error",
          });
        },
      }),
    },
  };
}
