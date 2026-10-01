import { describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  isPreference,
  loadPreference,
  nextPreference,
  resolveTheme,
  savePreference,
} from "./theme";

describe("resolveTheme", () => {
  it("follows the system in auto mode", () => {
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("auto", false)).toBe("light");
  });

  it("ignores the system when the user chose a theme", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("nextPreference", () => {
  it("cycles auto, light, dark", () => {
    expect(nextPreference("auto")).toBe("light");
    expect(nextPreference("light")).toBe("dark");
    expect(nextPreference("dark")).toBe("auto");
  });
});

describe("storage", () => {
  it("rejects values that are not a known preference", () => {
    expect(isPreference("dark")).toBe(true);
    expect(isPreference("<img src=x>")).toBe(false);
    expect(loadPreference({ getItem: () => "<script>" })).toBe("auto");
  });

  it("falls back to auto when storage is missing or throws", () => {
    expect(loadPreference(undefined)).toBe("auto");
    expect(
      loadPreference({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe("auto");
  });

  it("round-trips a saved preference", () => {
    const store = new Map<string, string>();
    savePreference(
      {
        setItem: (k, v) => {
          store.set(k, v);
        },
      },
      "dark",
    );
    expect(loadPreference({ getItem: (k) => store.get(k) ?? null })).toBe("dark");
  });

  it("does not throw when saving is refused", () => {
    const setItem = vi.fn(() => {
      throw new Error("quota");
    });
    expect(() => {
      savePreference({ setItem }, "light");
    }).not.toThrow();
    expect(setItem).toHaveBeenCalledOnce();
  });
});

describe("applyTheme", () => {
  it("writes the resolved theme on the root element", () => {
    const root = document.createElement("html");
    expect(applyTheme(root, "auto", true)).toBe("dark");
    expect(root.dataset["theme"]).toBe("dark");
    expect(root.dataset["themePreference"]).toBe("auto");
  });
});
