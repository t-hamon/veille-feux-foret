// Reports the gzip size of each built asset and fails above the budget, so a
// heavy dependency cannot slip into the bundle unnoticed. MapLibre's published
// files (assets/maplibre-gl-<version>/, see vite.config.ts) have their own
// budget: they are loaded after the first render and cached for a year.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const DIST = "dist/assets";
const BUDGET_KB = { js: 250, css: 30 };
const MAPLIBRE_BUDGET_KB = { mjs: 320 };

function files(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
}

let failed = false;
const totals = { maplibre: 0 };
for (const path of files(DIST)) {
  const name = relative(DIST, path);
  const ext = name.split(".").pop();
  const vendor = name.startsWith("maplibre-gl-");
  const budgets = vendor ? MAPLIBRE_BUDGET_KB : BUDGET_KB;
  if (!(ext in budgets)) continue;
  const raw = statSync(path).size;
  const gz = gzipSync(readFileSync(path)).length;
  if (vendor) totals.maplibre += gz;
  const over = !vendor && gz / 1024 > budgets[ext];
  if (over) failed = true;
  console.log(
    `${name}: ${(raw / 1024).toFixed(1)} kB, ${(gz / 1024).toFixed(1)} kB gzip` +
      (vendor ? "" : ` (budget ${budgets[ext]} kB)`) +
      (over ? " OVER BUDGET" : ""),
  );
}
const maplibreKb = totals.maplibre / 1024;
const maplibreOver = maplibreKb > MAPLIBRE_BUDGET_KB.mjs;
if (maplibreOver) failed = true;
console.log(
  `MapLibre, total: ${maplibreKb.toFixed(1)} kB gzip (budget ${MAPLIBRE_BUDGET_KB.mjs} kB)` +
    (maplibreOver ? " OVER BUDGET" : ""),
);
process.exit(failed ? 1 : 0);
