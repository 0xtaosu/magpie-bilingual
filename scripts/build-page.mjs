import { readFile, writeFile } from "node:fs/promises";

const base = new URL("../page/", import.meta.url);
const settings = await readFile(new URL("settings.js", base), "utf8");
const app = await readFile(new URL("app.js", base), "utf8");
const bundle = `(() => {\n${settings.replace(/^export /gm, "")}\n${app.replace(/^import\s+[\s\S]*?;\n/m, "")}\n})();\n`;
await writeFile(new URL("bundle.js", base), bundle);
