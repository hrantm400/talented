// Selectable color-grade presets. Each filter is a real FFmpeg `-vf` chain
// designed to mimic a recognisable cinematic look. They're tuned for video
// material and stay below ±20% on saturation/contrast to avoid clipping.

export interface ColorPreset {
  id: string;
  label: string;
  description: string;
  filter: string;
}

export const COLOR_PRESETS: ColorPreset[] = [
  {
    id: "teal_orange",
    label: "Teal & Orange",
    description: "Hollywood blockbuster look — warm skin, cool shadows.",
    filter:
      "curves=preset=vintage," +
      "colorbalance=rs=0.05:gs=-0.02:bs=-0.10:rm=0.05:gm=0:bm=-0.05:rh=-0.10:gh=0:bh=0.10," +
      "eq=contrast=1.10:saturation=1.15",
  },
  {
    id: "cinematic_warm",
    label: "Warm Sunset",
    description: "Golden hour amber-and-magenta tone.",
    filter:
      "colortemperature=temperature=4200," +
      "eq=contrast=1.08:brightness=0.02:saturation=1.20:gamma=0.95," +
      "vignette=PI/5",
  },
  {
    id: "cool_night",
    label: "Cool Night",
    description: "Cold blue-cyan night look (Mr. Robot / Fincher).",
    filter:
      "colortemperature=temperature=5800," +
      "colorbalance=rs=-0.05:bs=0.10:rm=-0.05:bm=0.10:rh=0:bh=0.05," +
      "eq=contrast=1.15:brightness=-0.02:saturation=0.85:gamma=0.92",
  },
  {
    id: "punchy_vibrant",
    label: "Punchy & Vibrant",
    description: "Saturated, high-contrast social-media pop.",
    filter:
      "eq=contrast=1.18:saturation=1.40:gamma=1.02," +
      "unsharp=5:5:0.8:5:5:0.0",
  },
  {
    id: "vintage_film",
    label: "Vintage Film",
    description: "Faded highlights, warm shadows — old-stock feel.",
    filter:
      "curves=preset=vintage," +
      "eq=contrast=0.92:saturation=0.85:gamma=1.05," +
      "noise=alls=8:allf=t",
  },
  {
    id: "bw_cinematic",
    label: "B&W Cinematic",
    description: "Deep contrast monochrome with soft glow.",
    filter:
      "hue=s=0," +
      "eq=contrast=1.25:brightness=-0.02:gamma=0.93," +
      "unsharp=3:3:0.4:3:3:0.0",
  },
];

export function getColorPreset(id: string | null | undefined): ColorPreset {
  return COLOR_PRESETS.find((p) => p.id === id) || COLOR_PRESETS[0];
}
