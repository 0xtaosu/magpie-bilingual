import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const sandbox = await mkdtemp(join(tmpdir(), "bilingual-p0-"));
const binary = process.env.MAGPIE_BIN || "/Applications/magpie.app/Contents/MacOS/magpie";
const env = {
  ...process.env,
  HOME: sandbox,
  XDG_CONFIG_HOME: join(sandbox, ".config"),
  XDG_CACHE_HOME: join(sandbox, ".cache"),
  MAGPIE_ADDR: "127.0.0.1:3499",
};
try {
  for (const args of [["plugin", "add", resolve(".")], ["plugin", "--json"]]) {
    const result = spawnSync(binary, args, { env, encoding: "utf8", timeout: 45000, input: "" });
    if (result.error || result.status !== 0) throw new Error("P0_HOST_COMMAND_FAILED");
    if (args.includes("--json")) {
      const output = JSON.parse(result.stdout);
      if (!output.loaded?.some((plugin) => plugin.provides?.includes("bilingual"))
        || !output.providers?.some((provider) => provider.id === "bilingual" && provider.npm === "@ai-sdk/anthropic")) {
        throw new Error("P0_HOST_PROVIDER_MISSING");
      }
      console.log("P0_HOST_LOAD_OK: isolated MAGPIE discovered bilingual");
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
