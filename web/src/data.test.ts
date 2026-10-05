import { describe, expect, it } from "vitest";
import completBilan from "../e2e/fixtures/complet/bilan.json?raw";
import completDetections from "../e2e/fixtures/complet/detections.geojson?raw";
import completEtat from "../e2e/fixtures/complet/etat.json?raw";
import completEmprises from "../e2e/fixtures/complet/foyers-emprises.geojson?raw";
import completFoyers from "../e2e/fixtures/complet/foyers.geojson?raw";
import completSurfaces from "../e2e/fixtures/complet/surfaces-brulees.geojson?raw";
import panneEtat from "../e2e/fixtures/firms-en-panne/etat.json?raw";
import {
  DataFormatError,
  LIMITS,
  cleanText,
  loadFile,
  parseBurned,
  parseDetections,
  parseFoyers,
  parseInstant,
  parseOutlines,
  parseStatus,
  parseSummary,
} from "./data";

// The fixtures are written by the real pipeline (tools/build_web_fixtures.py)
// from the capture of 3 October 2026.
const json = (text: string): unknown => JSON.parse(text);

function collection(features: unknown[]): unknown {
  return { type: "FeatureCollection", features };
}

function detection(overrides: Record<string, unknown> = {}, coordinates = [2.35, 48.85]): unknown {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates },
    properties: {
      t: 1_791_000_000,
      src: "viirs_snpp",
      frp: 1.5,
      conf: "nominal",
      conf_pct: null,
      dn: "N",
      foyer: null,
      ...overrides,
    },
  };
}

describe("files written by the pipeline", () => {
  it("reads the status of every source", () => {
    const status = parseStatus(json(completEtat));
    expect(status.generatedAt.toISOString()).toBe("2026-10-03T11:28:00.000Z");
    expect(status.windowHours).toBe(168);
    expect(status.sources.map((s) => s.id)).toEqual([
      "firms_viirs_snpp",
      "firms_viirs_noaa20",
      "firms_viirs_noaa21",
      "firms_modis",
      "effis_dated",
      "effis_nrt",
      "effis_stats",
    ]);
    expect(status.sources.every((s) => s.ok)).toBe(true);
    expect(status.files).toContain("detections.geojson");
  });

  it("reads a failed source with its error and no update time", () => {
    const status = parseStatus(json(panneEtat));
    const snpp = status.sources.find((s) => s.id === "firms_viirs_snpp");
    expect(snpp?.ok).toBe(false);
    expect(snpp?.updatedAt).toBeNull();
    expect(snpp?.error).toContain("URLError");
  });

  it("keeps every detection, foyer and outline", () => {
    const detections = parseDetections(json(completDetections));
    expect(detections.rejected).toBe(0);
    expect(detections.items).toHaveLength(46);
    const foyers = parseFoyers(json(completFoyers));
    expect(foyers.rejected).toBe(0);
    expect(foyers.items.map((f) => f.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const outlines = parseOutlines(json(completEmprises));
    expect(outlines.rejected).toBe(0);
    expect(outlines.items.length).toBeGreaterThan(0);
    const inFoyers = detections.items.filter((d) => d.foyer !== null).length;
    expect(inFoyers).toBe(foyers.items.reduce((sum, f) => sum + f.detections, 0));
  });

  it("keeps every burned area of both kinds", () => {
    const burned = parseBurned(json(completSurfaces));
    expect(burned.rejected).toBe(0);
    expect(burned.items.filter((b) => b.kind === "dated")).toHaveLength(43);
    expect(burned.items.filter((b) => b.kind === "nrt")).toHaveLength(28);
  });

  it("reads the season summary", () => {
    const summary = parseSummary(json(completBilan));
    expect(summary.year).toBe(2026);
    expect(summary.burnedHa).toBe(97_971);
    expect(summary.averageHa).toBe(14_198);
  });
});

describe("rejected entries", () => {
  it("drops detections outside metropolitan France or malformed, never repairs them", () => {
    const parsed = parseDetections(
      collection([
        detection(),
        detection({}, [-60, 14]),
        detection({ t: "1791000000" }),
        detection({ src: "goes" }),
        detection({ frp: -1 }),
        detection({ conf: "maybe" }),
        detection({ dn: "X" }),
        detection({ foyer: 0 }),
        detection({ conf_pct: 140 }),
        "not a feature",
      ]),
    );
    expect(parsed.items).toHaveLength(1);
    expect(parsed.rejected).toBe(9);
  });

  it("accepts missing optional values as unknown", () => {
    const parsed = parseDetections(
      collection([detection({ frp: null, conf: null, dn: null, conf_pct: 72 })]),
    );
    expect(parsed.items[0]).toMatchObject({
      frp: null,
      confidence: null,
      daytime: null,
      confidencePct: 72,
    });
  });

  it("refuses a file that is not a feature collection or too large", () => {
    expect(() => parseDetections({ type: "Feature" })).toThrow(DataFormatError);
    expect(() => parseDetections(collection(new Array(LIMITS.detections + 1).fill(null)))).toThrow(
      DataFormatError,
    );
  });

  it("drops a foyer whose first detection follows its last one", () => {
    const parsed = parseFoyers(
      collection([
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [2, 47] },
          properties: {
            id: 1,
            detections: 3,
            detections_24h: 3,
            first: "2026-10-03T10:00:00Z",
            last: "2026-10-03T09:00:00Z",
            max_frp: 2,
            estimated_area_ha: 14,
            active: true,
          },
        },
      ]),
    );
    expect(parsed).toEqual({ items: [], rejected: 1 });
  });

  it("drops open rings and unknown burned area kinds", () => {
    const ring = [
      [2, 47],
      [2.1, 47],
      [2.1, 47.1],
      [2, 47.1],
    ];
    const parsed = parseBurned(
      collection([
        {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [ring] },
          properties: { kind: "nrt" },
        },
        {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [[...ring, [2, 47]]] },
          properties: { kind: "other" },
        },
        {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [[...ring, [2, 47]]] },
          properties: { kind: "nrt" },
        },
      ]),
    );
    expect(parsed.items).toHaveLength(1);
    expect(parsed.rejected).toBe(2);
  });

  it("keeps hostile commune names as plain text", () => {
    const ring = [
      [2, 47],
      [2.1, 47],
      [2.1, 47.1],
      [2, 47],
    ];
    const parsed = parseBurned(
      collection([
        {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [ring] },
          properties: {
            kind: "dated",
            date: "2026-08-01",
            updated: "2026-08-02",
            area_ha: 12,
            commune: '<img src=x onerror="alert(1)">',
            province: "Var\u0000",
          },
        },
      ]),
    );
    expect(parsed.items[0]?.commune).toBe('<img src=x onerror="alert(1)">');
    expect(parsed.items[0]?.province).toBe("Var");
  });

  it("refuses an invalid status file", () => {
    expect(() =>
      parseStatus({ generated_at: "yesterday", window_hours: 168, sources: {} }),
    ).toThrow(DataFormatError);
    expect(() => parseStatus(null)).toThrow(DataFormatError);
  });

  it("ignores malformed sources in the status file", () => {
    const status = parseStatus({
      generated_at: "2026-10-03T11:28:00Z",
      window_hours: 168,
      sources: { "Bad Id!": { ok: true }, firms_modis: { ok: "yes" }, effis_nrt: { ok: true } },
      files: ["etat.json", "../secret"],
    });
    expect(status.sources.map((s) => s.id)).toEqual(["effis_nrt"]);
    expect(status.files).toEqual(["etat.json"]);
  });
});

describe("helpers", () => {
  it("only accepts UTC instants written by the pipeline", () => {
    expect(parseInstant("2026-10-03T11:28:00Z")?.getTime()).toBe(Date.UTC(2026, 9, 3, 11, 28));
    expect(parseInstant("2026-10-03 11:28")).toBeNull();
    expect(parseInstant("2026-13-45T99:99:99Z")).toBeNull();
    expect(parseInstant(12)).toBeNull();
  });

  it("cleans and shortens labels", () => {
    expect(cleanText("  Var ")).toBe("Var");
    expect(cleanText("")).toBeNull();
    expect(cleanText(42)).toBeNull();
    expect(cleanText("x".repeat(500), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("loadFile", () => {
  const ok =
    (body: string, status = 200) =>
    () =>
      Promise.resolve(new Response(body, { status }));

  it("parses a file served normally", async () => {
    const result = await loadFile("summary", parseSummary, ok(completBilan));
    expect(result.state).toBe("ok");
  });

  it("reports a missing file apart from an error", async () => {
    expect(await loadFile("summary", parseSummary, ok("", 404))).toEqual({ state: "missing" });
    expect(await loadFile("summary", parseSummary, ok("", 503))).toEqual({
      state: "error",
      message: "réponse HTTP 503",
    });
  });

  it("reports network failures and unreadable files without throwing", async () => {
    const offline = () => Promise.reject(new TypeError("Failed to fetch"));
    expect(await loadFile("summary", parseSummary, offline)).toEqual({
      state: "error",
      message: "réseau indisponible",
    });
    expect(await loadFile("summary", parseSummary, ok("<html>"))).toEqual({
      state: "error",
      message: "fichier illisible",
    });
    expect(await loadFile("summary", parseSummary, ok("{}"))).toMatchObject({ state: "error" });
  });

  it("refuses a file announced as too large before reading it", async () => {
    const big = () =>
      Promise.resolve(
        new Response("{}", { headers: { "content-length": String(LIMITS.textChars + 1) } }),
      );
    expect(await loadFile("summary", parseSummary, big)).toEqual({
      state: "error",
      message: "fichier trop volumineux",
    });
  });

  it("asks for the file under the data folder", async () => {
    const asked: string[] = [];
    await loadFile("status", parseStatus, (url) => {
      asked.push(url);
      return Promise.resolve(new Response(completEtat));
    });
    expect(asked).toEqual(["./data/etat.json"]);
  });
});
