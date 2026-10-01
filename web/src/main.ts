import "./styles.css";
import { LABELS, applyTheme, loadPreference, nextPreference, savePreference } from "./theme";

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

const root = document.documentElement;
const media = window.matchMedia("(prefers-color-scheme: dark)");
let preference = loadPreference(storage());

const button = document.querySelector<HTMLButtonElement>("#theme-toggle");

function render(): void {
  applyTheme(root, preference, media.matches);
  if (button) {
    button.textContent = LABELS[preference];
    button.setAttribute("aria-label", `${LABELS[preference]}. Changer de thème`);
  }
}

button?.addEventListener("click", () => {
  preference = nextPreference(preference);
  savePreference(storage(), preference);
  render();
});

media.addEventListener("change", render);
render();
