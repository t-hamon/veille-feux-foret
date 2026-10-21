// Colours shared by the map layers and the legend, which is drawn before the
// map code is loaded. Age classes go from dark red (recent) to pale yellow.
export const AGE_COLOURS = ["#b10026", "#e31a1c", "#fd8d3c", "#fed976"] as const;
export const FOYER_COLOUR = "#67000d";
export const DATED_COLOUR = "#5d4037";
export const NRT_COLOUR = "#bf360c";
export const SELECTION_COLOUR = "#0b57d0";
// Wind speed classes (wind.ts SPEED_CLASSES), one blue from light to dark:
// lightness falls steadily (OKLCH L 0.60 to 0.28) and the lightest still has a
// contrast of 3.2:1 on the grey Plan IGN and 3.5:1 on Positron.
export const WIND_COLOURS = ["#4682cc", "#2769b7", "#07519d", "#003b7f", "#002758"] as const;
