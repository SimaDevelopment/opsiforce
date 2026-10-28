import {
  blend,
  contrastRatio,
  generateNeutralScale,
  generateScale,
  hexToRgb,
  mixColors,
  withAlpha,
} from '@opencode/ui/theme/color';
import type { HexColor } from '@opencode/ui/theme/types';

/**
 * Theme seeds — the two colours the whole interface is mixed from.
 *
 * A seed is not a token. Picking one runs the OKLCH generator that opencode
 * already ships and refits the semantic layer from its output, so a choice
 * cannot land on an unreadable value the way hand-picked hexes can. The
 * defaults are authored rather than generated: the default base and accent mean
 * "leave the stylesheet alone", because those values were tuned against the
 * APCA floors by hand and the generator would only approximate them.
 */

export interface Seed {
  id: string;
  name: string;
  note?: string;
  color: HexColor;
}

export const BASE_SEEDS: Seed[] = [
  { id: 'ink', name: 'Periwinkle ink', note: 'the Opsiforce default', color: '#3f3d6f' },
  { id: 'slate', name: 'Slate', color: '#46505e' },
  { id: 'graphite', name: 'Graphite', color: '#3b3b3f' },
  { id: 'warm', name: 'Warm', color: '#4a443c' },
];

export const ACCENT_SEEDS: Seed[] = [
  { id: 'brand', name: 'Opsiforce', note: 'brand periwinkle', color: '#6666ff' },
  { id: 'indigo', name: 'Indigo', color: '#4f5bd5' },
  { id: 'teal', name: 'Teal', color: '#0e8f86' },
  { id: 'amber', name: 'Amber', color: '#b8761a' },
  { id: 'rose', name: 'Rose', color: '#c2446e' },
];

export const DEFAULT_BASE_SEED = 'ink';
export const DEFAULT_ACCENT_SEED = 'brand';

export const baseSeed = (id: string): Seed => BASE_SEEDS.find((s) => s.id === id) ?? BASE_SEEDS[0];
export const accentSeed = (id: string): Seed => ACCENT_SEEDS.find((s) => s.id === id) ?? ACCENT_SEEDS[0];

/** Ink that clears the larger contrast ratio against a solid fill. */
function inkOn(fill: HexColor): HexColor {
  const onWhite = contrastRatio('#ffffff', fill);
  const onDark = contrastRatio('#15122e', fill);
  return onWhite >= onDark ? '#ffffff' : '#15122e';
}

/**
 * Walk a generated accent ramp until the step clears `floor` against the
 * surface it will sit on. Accent *text* is where a seed most easily fails, so
 * it is checked rather than assumed.
 */
function readableStep(scale: HexColor[], surface: HexColor, floor: number, from: number): HexColor {
  for (let i = from; i < scale.length; i++) {
    if (contrastRatio(scale[i], surface) >= floor) return scale[i];
  }
  return scale[scale.length - 1];
}

/**
 * The legacy shadcn bridge is consumed as `hsl(var(--primary) / a)`, so it
 * needs bare `H S% L%` triplets rather than a colour.
 */
function hslTriplet(hex: HexColor): string {
  const { r, g, b } = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return `${h.toFixed(1)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%`;
}

/**
 * The semantic layer, regenerated from two seeds. Keys are the custom property
 * names the stylesheet already reads, so applying this is a style write and
 * nothing else re-renders. The legacy bridge is regenerated alongside, or the
 * controls still written against `bg-primary` and `ring-ring` would keep the
 * authored accent while everything around them changed.
 */
export function resolveSeedTokens(base: HexColor, accent: HexColor, isDark: boolean): Record<string, string> {
  const ink: HexColor = isDark ? '#f3f2fb' : '#1d1b32';
  const neutral = generateNeutralScale(base, isDark, ink);
  const brand = generateScale(accent, isDark);

  // The ladder is the point: app -> panel -> content must stay three distinct
  // steps, or the sidebar dissolves into the canvas. In light the canvas is
  // the inked step and the panel the lighter one, matching the authored
  // #ECECF3 / #F5F5FA / #FFFFFF; in dark it climbs away from the darkest step.
  const content: HexColor = isDark ? neutral[2] : '#ffffff';
  const fill = brand[8];
  const fillHover = brand[9];
  // 4.5:1 is the floor for the 13px labels this accent carries as text
  const accentText = readableStep(brand, content, 4.5, 9);

  const app = isDark ? neutral[0] : neutral[1];
  const panel = isDark ? neutral[1] : neutral[0];
  const elevated: HexColor = isDark ? neutral[3] : '#ffffff';
  const elementAlpha = isDark ? 0.055 : 0.045;
  const elementHoverAlpha = isDark ? 0.095 : 0.075;
  // the same strengths the stylesheet uses at normal contrast; the bridge has
  // no contrast steps of its own, as it never had
  const borderSubtleAlpha = isDark ? 0.095 : 0.1;
  const borderDefaultAlpha = isDark ? 0.18 : 0.17;
  const textDefault = mixColors(neutral[9], ink, 0.62);
  const onSolid = inkOn(fill);

  // legacy values are flattened onto the surface they sit on, as the authored
  // bridge is, because a triplet cannot carry alpha
  const element = hslTriplet(blend(neutral[11], content, elementAlpha));
  const elementHover = hslTriplet(blend(neutral[11], content, elementHoverAlpha));
  const borderSubtle = hslTriplet(blend(neutral[11], content, borderSubtleAlpha));

  return {
    '--bg-app': app,
    '--bg-panel': panel,
    '--bg-content': content,
    '--bg-elevated': elevated,
    '--bg-element': withAlpha(neutral[11], elementAlpha),
    '--bg-element-hover': withAlpha(neutral[11], elementHoverAlpha),
    '--bg-element-selected': withAlpha(fill, isDark ? 0.17 : 0.1),
    // the strengths stay with the stylesheet, where Contrast sets them
    '--border-ink': neutral[11],
    '--border-accent': fill,
    '--fill-solid': fill,
    '--fill-solid-hover': fillHover,
    '--ink-subtle-base': neutral[9],
    '--ink-default-base': textDefault,
    '--ink-strong': ink,
    '--ink-on-solid': onSolid,
    '--ink-accent': accentText,
    '--fill-tint': withAlpha(fill, isDark ? 0.14 : 0.11),
    '--fill-tint-strong': withAlpha(fill, isDark ? 0.24 : 0.18),
    '--ring-accent': withAlpha(fill, isDark ? 0.46 : 0.38),

    // legacy bridge, same mapping as the authored block in shell.css
    '--background': hslTriplet(app),
    '--foreground': hslTriplet(textDefault),
    '--card': hslTriplet(content),
    '--card-foreground': hslTriplet(textDefault),
    '--popover': hslTriplet(elevated),
    '--popover-foreground': hslTriplet(textDefault),
    '--primary': hslTriplet(fill),
    '--primary-foreground': hslTriplet(onSolid),
    '--secondary': element,
    '--secondary-foreground': hslTriplet(ink),
    '--muted': element,
    '--muted-foreground': hslTriplet(neutral[9]),
    '--accent': elementHover,
    '--accent-foreground': hslTriplet(ink),
    '--border': borderSubtle,
    '--input': hslTriplet(blend(neutral[11], content, borderDefaultAlpha)),
    '--ring': hslTriplet(fill),
    '--sidebar': hslTriplet(panel),
    '--sidebar-foreground': hslTriplet(textDefault),
    '--sidebar-border': borderSubtle,
    '--sidebar-accent': elementHover,
    '--sidebar-accent-foreground': hslTriplet(ink),
    '--sidebar-muted-foreground': hslTriplet(neutral[9]),
  };
}

/** The custom properties `resolveSeedTokens` owns, for clearing them again. */
export const SEED_TOKEN_NAMES = Object.keys(resolveSeedTokens('#3f3d6f', '#6666ff', false));
