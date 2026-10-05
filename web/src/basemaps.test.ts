import { describe, expect, it } from "vitest";
import headers from "../public/_headers?raw";
import { BASEMAPS, rewriteUrl } from "./basemaps";

describe("base maps", () => {
  it("asks for the single resolution sprite of the Plan IGN", () => {
    const sprite = "https://data.geopf.fr/annexes/ressources/vectorTiles/styles/PLAN.IGN/sprite/";
    expect(rewriteUrl(`${sprite}PlanIgn-Gris@2x.png`)).toBe(`${sprite}PlanIgn-Gris.png`);
    expect(rewriteUrl(`${sprite}PlanIgn-Gris@2x.json`)).toBe(`${sprite}PlanIgn-Gris.json`);
    const other = "https://tiles.openfreemap.org/sprites/ofm_f384/ofm@2x.png";
    expect(rewriteUrl(other)).toBe(other);
  });

  it("only talks to the hosts allowed by the security policy", () => {
    const connectSrc = /connect-src ([^;]+);/.exec(headers)?.[1] ?? "";
    for (const basemap of Object.values(BASEMAPS)) {
      expect(new URL(basemap.style).origin).toBe(basemap.hosts[0]);
      expect(connectSrc).toContain(` ${basemap.hosts[0] ?? "?"}`);
    }
  });
});
