export type Theme = "light" | "dark";

export type ViewerLook = {
  background: string;
  cell: string;
  section: string;
  bone: string;
  joint: string;
  jointEmissive: string;
  trail: string;
  marker: string;
  hemiSky: string;
  hemiGround: string;
  ambient: number;
  directional: number;
};

const DARK: ViewerLook = {
  background: "#0b0d12",
  cell: "#334455",
  section: "#667788",
  bone: "#5ec8e8",
  joint: "#ffb454",
  jointEmissive: "#663300",
  trail: "#6cb2ff",
  marker: "#7dd3fc",
  hemiSky: "#dfe8ff",
  hemiGround: "#2a3140",
  ambient: 0.7,
  directional: 1.1,
};

const LIGHT: ViewerLook = {
  background: "#d8e0cc",
  cell: "#7d9158",
  section: "#3f5328",
  bone: "#1b6a84",
  joint: "#c26e0d",
  jointEmissive: "#6a3a00",
  trail: "#2a6fbf",
  marker: "#1f7aa8",
  hemiSky: "#f4f7ee",
  hemiGround: "#c3d0b4",
  ambient: 0.95,
  directional: 0.85,
};

export function viewerLook(theme: Theme): ViewerLook {
  return theme === "light" ? LIGHT : DARK;
}
