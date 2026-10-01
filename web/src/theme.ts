export type ThemePreference = "auto" | "light" | "dark";
export type Theme = "light" | "dark";

const STORAGE_KEY = "veille-feux:theme";
const ORDER: readonly ThemePreference[] = ["auto", "light", "dark"];

export const LABELS: Record<ThemePreference, string> = {
  auto: "Thème : automatique",
  light: "Thème : clair",
  dark: "Thème : sombre",
};

export function isPreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (ORDER as readonly string[]).includes(value);
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): Theme {
  if (preference === "auto") return systemPrefersDark ? "dark" : "light";
  return preference;
}

export function nextPreference(current: ThemePreference): ThemePreference {
  const index = ORDER.indexOf(current);
  return ORDER[(index + 1) % ORDER.length] ?? "auto";
}

// Storage can be missing or throw (private mode, blocked site data): the theme
// must still work, it just stops being remembered.
export function loadPreference(storage: Pick<Storage, "getItem"> | undefined): ThemePreference {
  try {
    const value = storage?.getItem(STORAGE_KEY);
    return isPreference(value) ? value : "auto";
  } catch {
    return "auto";
  }
}

export function savePreference(
  storage: Pick<Storage, "setItem"> | undefined,
  preference: ThemePreference,
): void {
  try {
    storage?.setItem(STORAGE_KEY, preference);
  } catch {
    // Nothing to do: the preference simply is not persisted.
  }
}

export function applyTheme(
  root: HTMLElement,
  preference: ThemePreference,
  systemPrefersDark: boolean,
): Theme {
  const theme = resolveTheme(preference, systemPrefersDark);
  root.dataset["theme"] = theme;
  root.dataset["themePreference"] = preference;
  return theme;
}
