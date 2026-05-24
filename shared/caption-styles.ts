export interface CaptionStyle {
  id: string;
  name: string;
  description: string;
  fontName: string;
  fontSize: number;
  primaryColor: string;
  highlightColor: string;
  outlineColor: string;
  backColor: string;
  outlineWidth: number;
  shadow: number;
  bold: boolean;
  uppercase: boolean;
  scaleOnHighlight: number;
  cssHighlightColor: string;
  cssPrimaryColor: string;
}

export const CAPTION_STYLES: CaptionStyle[] = [
  {
    id: "capcut_green",
    name: "CapCut Green",
    description: "White bold text with green highlight",
    fontName: "Impact",
    fontSize: 92,
    primaryColor: "&H00FFFFFF",
    highlightColor: "&H0000FF00",
    outlineColor: "&H00000000",
    backColor: "&H80000000",
    outlineWidth: 4,
    shadow: 2,
    bold: true,
    uppercase: true,
    scaleOnHighlight: 115,
    cssHighlightColor: "#00FF00",
    cssPrimaryColor: "#FFFFFF",
  },
  {
    id: "capcut_yellow",
    name: "CapCut Yellow",
    description: "White bold text with yellow highlight",
    fontName: "Impact",
    fontSize: 92,
    primaryColor: "&H00FFFFFF",
    highlightColor: "&H0000FFFF",
    outlineColor: "&H00000000",
    backColor: "&H80000000",
    outlineWidth: 4,
    shadow: 2,
    bold: true,
    uppercase: true,
    scaleOnHighlight: 115,
    cssHighlightColor: "#FFD700",
    cssPrimaryColor: "#FFFFFF",
  },
  {
    id: "neon_pop",
    name: "Neon Pop",
    description: "White text with cyan neon glow",
    fontName: "Arial",
    fontSize: 92,
    primaryColor: "&H00FFFFFF",
    highlightColor: "&H00FFFF00",
    outlineColor: "&H00FF8800",
    backColor: "&H00000000",
    outlineWidth: 3,
    shadow: 3,
    bold: true,
    uppercase: true,
    scaleOnHighlight: 115,
    cssHighlightColor: "#00FFFF",
    cssPrimaryColor: "#FFFFFF",
  },
  {
    id: "minimal_white",
    name: "Minimal Clean",
    description: "Clean white with bold highlight",
    fontName: "Arial",
    fontSize: 92,
    primaryColor: "&H00CCCCCC",
    highlightColor: "&H00FFFFFF",
    outlineColor: "&H00000000",
    backColor: "&H60000000",
    outlineWidth: 2,
    shadow: 1,
    bold: true,
    uppercase: false,
    scaleOnHighlight: 115,
    cssHighlightColor: "#FFFFFF",
    cssPrimaryColor: "#CCCCCC",
  },
  {
    id: "fire",
    name: "Fire",
    description: "White text with orange-red highlight",
    fontName: "Impact",
    fontSize: 92,
    primaryColor: "&H00FFFFFF",
    highlightColor: "&H000066FF",
    outlineColor: "&H00000000",
    backColor: "&H80000000",
    outlineWidth: 4,
    shadow: 2,
    bold: true,
    uppercase: true,
    scaleOnHighlight: 115,
    cssHighlightColor: "#FF4500",
    cssPrimaryColor: "#FFFFFF",
  },
  {
    id: "gradient_glow",
    name: "Pink Glow",
    description: "White text with magenta-pink highlight",
    fontName: "Arial",
    fontSize: 92,
    primaryColor: "&H00FFFFFF",
    highlightColor: "&H00FF00FF",
    outlineColor: "&H00000000",
    backColor: "&H60000000",
    outlineWidth: 3,
    shadow: 2,
    bold: true,
    uppercase: true,
    scaleOnHighlight: 115,
    cssHighlightColor: "#FF00FF",
    cssPrimaryColor: "#FFFFFF",
  },
];

export function getCaptionStyleById(id: string): CaptionStyle {
  return CAPTION_STYLES.find((s) => s.id === id) || CAPTION_STYLES[0];
}
