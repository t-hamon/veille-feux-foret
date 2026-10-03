// Reports the gzip size of each built asset and fails above the budget, so a
// heavy dependency cannot slip into the bundle unnoticed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const DIST = "dist/assets";
const BUDGET_KB = { js: 250, css: 30 };

let failed = false;
for (const name of readdirSync(DIST).sort()) {
  const ext = name.split(".").pop();
  if (!(ext in BUDGET_KB)) continue;
  const path = join(DIST, name);
  const raw = statSync(path).size;
  const gz = gzipSync(readFileSync(path)).length;
  const over = gz / 1024 > BUDGET_KB[ext];
  if (over) failed = true;
  console.log(
    `${name}: ${(raw / 1024).toFixed(1)} kB, ${(gz / 1024).toFixed(1)} kB gzip` +
      ` (budget ${BUDGET_KB[ext]} kB)${over ? " OVER BUDGET" : ""}`,
  );
}
process.exit(failed ? 1 : 0);
