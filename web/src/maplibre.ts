// Loads MapLibre. In the build, its published files are imported from
// assets/maplibre-gl-<version>/ (see vite.config.ts): the library then starts
// its worker from the same folder. The development server bundles it instead.

type MapLibre = typeof import("maplibre-gl");

declare const __MAPLIBRE_DIR__: string;

export async function loadMapLibre(): Promise<MapLibre> {
  if (import.meta.env.DEV) {
    const [lib, worker] = await Promise.all([
      import("maplibre-gl"),
      import("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"),
    ]);
    lib.setWorkerUrl(worker.default);
    return lib;
  }
  // The base is put in a variable on purpose: Vite rewrites the literal pattern
  // new URL(path, import.meta.url) as a reference to a file of the project.
  const base = import.meta.url;
  const url = new URL(`./${__MAPLIBRE_DIR__}/maplibre-gl.mjs`, base).href;
  return (await import(/* @vite-ignore */ url)) as MapLibre;
}
