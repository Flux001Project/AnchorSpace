/**
 * Color palette — verbatim from the AnchorSpace brief.
 * Any drift from these values gets called out in the Phase 2 report.
 */

export const palette = {
  wall: "#2C1810",        // deep warm brown
  floor: "#1A0F0A",       // dark wood
  desk: "#3D2314",        // medium brown
  monitorGlow: "#F0A500", // amber, warm
  windowDark: "#1a1a2e",  // night sky base
  windowStar: "#4a4a8a",  // night sky stars
  ambient: "#FF6B35",     // warm lamp glow (used at 15% opacity)
  textChrome: "#E8D5B7",  // cream
  accent: "#8B6914",      // gold
  flux: "#F0A500",        // warm amber, same as monitor glow
  /** Sub-agent body colors, cycled by spawn order. */
  subagents: ["#5B8CFF", "#FF6B9D", "#50C878", "#FF8C42"] as const,
} as const;

export const subagentColor = (index: number): string => {
  return palette.subagents[index % palette.subagents.length];
};
