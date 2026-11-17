import { createProbeFetch, discoverGateway, FIXTURE, inspectGateway } from "../src/probe.mjs";

try {
  const gateway = await discoverGateway();
  const state = await inspectGateway(gateway);
  console.log(JSON.stringify({
    version: state.version, modelCount: state.modelCount, nativeModels: state.nativeModels,
    status: state.nativeModels.length ? "TARGET_SELECTION_REQUIRED" : "P0_BLOCKED_NO_NATIVE_MODEL",
  }, null, 2));
  const targetModel = process.argv[2];
  if (!targetModel) {
    process.exitCode = state.nativeModels.length ? 0 : 2;
  } else {
    const probe = createProbeFetch({ gateway, targetModel });
    for (const stream of [false, true]) {
      const response = await probe("https://bilingual.invalid/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "test", max_tokens: 64, stream, messages: [{ role: "user", content: FIXTURE }] }),
      });
      const text = await response.text();
      const markerReceived = stream
        ? text.split(/\r?\n/).filter((line) => line.startsWith("data:"))
          .flatMap((line) => {
            try { const event = JSON.parse(line.slice(5)); return [event.delta?.text || "", event.content_block?.text || ""]; }
            catch { return []; }
          }).join("").includes("BILINGUAL_P0_OK")
        : text.includes("BILINGUAL_P0_OK");
      console.log(JSON.stringify({ stream, status: response.status, markerReceived }));
      if (!response.ok || !markerReceived) process.exitCode = 2;
    }
  }
} catch {
  console.error("P0_GATEWAY_INSPECTION_FAILED");
  process.exitCode = 2;
}
