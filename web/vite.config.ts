import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// The policy is sent as an HTTP header by Cloudflare (public/_headers, which
// adds frame-ancestors) and repeated here in a meta tag, so that it also applies
// wherever the build is served without those headers. It is only added to the
// production build: the dev server injects styles inline.
// - worker-src: MapLibre's worker is a file of this site (see src/map.ts).
// - img-src blob: MapLibre decodes some tile images through a blob URL when the
//   browser lacks createImageBitmap.
// - connect-src: the two base map servers, nothing else (src/basemaps.ts).
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https://data.geopf.fr https://tiles.openfreemap.org",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function contentSecurityPolicy(): Plugin {
  return {
    name: "content-security-policy",
    apply: "build",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY },
          injectTo: "head-prepend",
        },
      ];
    },
  };
}

// MapLibre ships as three ES modules: the library, its worker, and a large
// module they both import. Bundling them would put a copy of that shared module
// in the page chunk and another in the worker chunk (about 110 kB gzip twice).
// The build therefore publishes MapLibre's own files unchanged under a versioned
// folder of assets/, and src/maplibre.ts imports them at run time: the browser
// downloads the shared module once, and the library finds its worker next to
// itself, on the same origin.
const require = createRequire(import.meta.url);
const MAPLIBRE_DIST = dirname(require.resolve("maplibre-gl/dist/maplibre-gl.mjs"));
const MAPLIBRE_VERSION = (
  JSON.parse(readFileSync(join(MAPLIBRE_DIST, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;
export const MAPLIBRE_DIR = `maplibre-gl-${MAPLIBRE_VERSION}`;
const MAPLIBRE_FILES = [
  "maplibre-gl.mjs",
  "maplibre-gl-shared.mjs",
  "maplibre-gl-worker.mjs",
  "maplibre-gl.mjs.map",
  "maplibre-gl-shared.mjs.map",
  "maplibre-gl-worker.mjs.map",
];

function maplibreFiles(): Plugin {
  return {
    name: "maplibre-files",
    apply: "build",
    generateBundle() {
      for (const name of MAPLIBRE_FILES) {
        this.emitFile({
          type: "asset",
          fileName: `assets/${MAPLIBRE_DIR}/${name}`,
          source: readFileSync(join(MAPLIBRE_DIST, name)),
        });
      }
      this.emitFile({
        type: "asset",
        fileName: `assets/${MAPLIBRE_DIR}/LICENSE.txt`,
        source: readFileSync(join(MAPLIBRE_DIST, "..", "LICENSE.txt")),
      });
    },
  };
}

export default defineConfig({
  base: "./",
  // "mpa" makes the preview server answer 404 for unknown paths, as GitHub Pages
  // does, instead of serving index.html for every URL.
  appType: "mpa",
  plugins: [contentSecurityPolicy(), maplibreFiles()],
  define: { __MAPLIBRE_DIR__: JSON.stringify(MAPLIBRE_DIR) },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  // In development MapLibre is bundled normally and its worker built by Vite,
  // as an ES module like the published one.
  worker: { format: "es" },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "trigger/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "trigger/**/*.ts"],
      exclude: ["src/**/*.test.ts", "trigger/**/*.test.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
