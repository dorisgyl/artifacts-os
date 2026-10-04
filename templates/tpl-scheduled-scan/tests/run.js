// `npm test`: import every tests/*.test.js and run them. Template code.
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { runAll } from "./harness.js";

const here = dirname(fileURLToPath(import.meta.url));
for (const f of readdirSync(here).filter((f) => f.endsWith(".test.js")).sort()) {
  await import(pathToFileURL(join(here, f)).href);
}
process.exitCode = (await runAll()) ? 1 : 0;
