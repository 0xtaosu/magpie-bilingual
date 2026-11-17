import Plugin from "../index.mjs";
import { createBridge } from "../src/bridge.mjs";

export default async function HostFixture(input, options) {
  const hooks = await Plugin(input, options);
  hooks.auth.loader = async () => {
    const bridge = await createBridge(options, async () => "fixture-not-a-secret", {
      fetcher: async (url, init) => {
        if (!url.startsWith("https://translator.example/")) return fetch(url, init);
        const request = JSON.parse(init.body);
        const source = request.messages[1].content;
        const english = request.messages[0].content.includes("to English");
        if (english && !["你好", "请调用工具"].includes(source.trim())) return new Response("", { status: 400 });
        const translated = english
          ? source.trim() === "请调用工具"
            ? "Call the p0_echo tool with value 'Hello friend'. Do not respond with plain text before calling it. After the tool returns, reply with exactly: Hello friend."
            : "Reply with exactly: Hello friend."
          : "你好，朋友。";
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: translated } }] });
      },
    });
    return { baseURL: "https://bilingual.invalid/v1", apiKey: "fixture", fetch: bridge.fetch };
  };
  return hooks;
}
