import type { DesktopTheme, HexColor, ThemePaletteColors } from '@opencode/ui/theme/types';

/**
 * The shell palette, handed to the embedded chat.
 *
 * The chat renders from opencode's own theme system, which lives in the
 * vendored tree we do not edit, so the shell registers a theme object from the
 * consuming side. It has two halves, because opencode's theme does:
 *
 * - `palette` is the hex seeds opencode's OKLCH generator mixes its scales
 *   from. A generator cannot read a CSS variable, so these are the resolved
 *   values: the authored ones, or the ones the Appearance seeds regenerated.
 * - `overrides` / `v2Overrides` replace finished tokens, and they accept
 *   `var(...)`. The surfaces, ink, borders and accent the chat paints most
 *   point at the shell's live custom properties, so Contrast and the seeds
 *   reach the chat without a re-render, exactly as they reach the shell.
 */

// The chat surface is the content surface, not the canvas around it: the
// band's selected tab merges into it.
const LIVE_V2_TOKENS: Record<string, string> = {
  'v2-background-bg-base': 'var(--bg-content)',
  'v2-text-text-base': 'var(--ink-default)',
  'v2-text-text-muted': 'var(--ink-subtle)',
  'v2-text-text-accent': 'var(--ink-accent)',
  'v2-icon-icon-accent': 'var(--ink-accent)',
  'v2-border-border-base': 'var(--border-subtle)',
  'v2-border-border-strong': 'var(--border-default)',
  'v2-border-border-focus': 'var(--border-accent)',
  // the user's own message: a solid accent fill and the ink drawn on it
  'v2-background-bg-accent': 'var(--fill-solid)',
  'v2-text-text-contrast': 'var(--ink-on-solid)',
};

const LIVE_V1_TOKENS: Record<string, `var(--${string})`> = {
  'text-strong': 'var(--ink-strong)',
  'text-base': 'var(--ink-default)',
  'text-weak': 'var(--ink-subtle)',
  'border-weak-base': 'var(--border-subtle)',
};

const STATUS = {
  success: '#1c9a6b', // --job-done
  warning: '#c2871b', // --job-needs-you
  error: '#d9484c', // --job-failed
  info: '#4f86e8', // --job-running
  diffAdd: '#1c9a6b', // --diff-added
  diffDelete: '#d9484c', // --diff-deleted
} as const;

// The authored values from styles/shell.css, used while the seeds are the
// defaults. Dark is authored, not inverted: #8C89FF tops out at APCA Lc 48.3
// against any ink, so the dark fill goes to the brand tint and takes dark ink.
const AUTHORED = {
  light: { neutral: '#ffffff', ink: '#1d1b32', primary: '#605ef6', accent: '#544fe6' },
  dark: { neutral: '#16161f', ink: '#f3f2fb', primary: '#cbcbff', accent: '#cbcbff' },
} as const;

type SeedTokens = Record<string, string> | undefined;

function paletteFor(scheme: 'light' | 'dark', seedTokens: SeedTokens): ThemePaletteColors {
  const authored = AUTHORED[scheme];
  const pick = (name: string, fallback: HexColor) => (seedTokens?.[name] as HexColor | undefined) ?? fallback;
  const primary = pick('--fill-solid', authored.primary);
  return {
    neutral: pick('--bg-content', authored.neutral),
    ink: pick('--ink-strong', authored.ink),
    primary,
    accent: pick('--ink-accent', authored.accent),
    interactive: primary,
    ...STATUS,
  };
}

/**
 * The shell theme for the scheme being shown. Only the shown variant carries
 * seed values: the seeds are resolved for one scheme at a time, and a scheme
 * change re-registers the theme anyway.
 */
export function shellChatTheme(id: string, scheme: 'light' | 'dark', seedTokens: SeedTokens): DesktopTheme {
  const variant = (s: 'light' | 'dark') => ({
    palette: paletteFor(s, s === scheme ? seedTokens : undefined),
    overrides: LIVE_V1_TOKENS,
    v2Overrides: LIVE_V2_TOKENS,
  });
  return { id, name: 'Opsiforce', light: variant('light'), dark: variant('dark') };
}
