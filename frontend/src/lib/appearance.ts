import { createEffect, createMemo, createRoot, createSignal, onCleanup } from 'solid-js';
import { createPersistedStringSignal } from './persisted-signal';
import {
  DEFAULT_ACCENT_SEED,
  DEFAULT_BASE_SEED,
  SEED_TOKEN_NAMES,
  accentSeed,
  baseSeed,
  resolveSeedTokens,
} from './theme-seeds';

/**
 * Appearance — the four knobs Settings → Appearance exposes.
 *
 * Each one writes a single attribute (or one custom property) on <html>, and
 * the shell stylesheet reads it from there. Nothing else in the app needs
 * to know a choice was made, which is why there is no context and no provider:
 * the CSS is the subscriber.
 *
 * The stored values are also read by the inline boot script in `index.html`
 * before first paint, so a dark-mode user never sees a white flash. Keep the
 * key names and the attribute names here in sync with that script.
 */

export const MODES = ['light', 'dark', 'system'] as const;
export const CONTRASTS = ['softer', 'normal', 'high'] as const;
export const DENSITIES = ['comfortable', 'default', 'compact'] as const;
export const FONT_SIZES = ['small', 'default', 'large'] as const;

export type Mode = (typeof MODES)[number];
export type Contrast = (typeof CONTRASTS)[number];
export type Density = (typeof DENSITIES)[number];
export type FontSize = (typeof FONT_SIZES)[number];

export const MODE_KEY = 'opsiforce:appearance:mode';
export const CONTRAST_KEY = 'opsiforce:appearance:contrast';
export const DENSITY_KEY = 'opsiforce:appearance:density';
export const FONT_SIZE_KEY = 'opsiforce:appearance:font-size';
export const BASE_SEED_KEY = 'opsiforce:appearance:base-seed';
export const ACCENT_SEED_KEY = 'opsiforce:appearance:accent-seed';

const FONT_SCALE: Record<FontSize, string> = {
  small: '0.92',
  default: '1',
  large: '1.08',
};

const isOneOf = <T extends string>(values: readonly T[], value: string | null | undefined): value is T =>
  !!value && (values as readonly string[]).includes(value);

export const isMode = (v: string | null | undefined): v is Mode => isOneOf(MODES, v);
export const isContrast = (v: string | null | undefined): v is Contrast => isOneOf(CONTRASTS, v);
export const isDensity = (v: string | null | undefined): v is Density => isOneOf(DENSITIES, v);
export const isFontSize = (v: string | null | undefined): v is FontSize => isOneOf(FONT_SIZES, v);

const prefersDark = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;

/** The scheme actually painted, once `system` has been resolved. */
export function resolveScheme(mode: Mode): 'light' | 'dark' {
  if (mode === 'system') return prefersDark() ? 'dark' : 'light';
  return mode;
}

/**
 * Swapping the whole token set mid-transition makes every animated colour
 * crawl to its new value, so transitions are suppressed for one frame. CSS
 * animations are deliberately left running: a working indicator that freezes
 * on a theme change reads as a hung agent.
 */
function withoutTransitions(apply: () => void): void {
  const root = document.documentElement;
  root.classList.add('no-transitions');
  apply();
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => root.classList.remove('no-transitions'));
  });
}

export function applyAppearance(opts: {
  mode?: Mode;
  contrast?: Contrast;
  density?: Density;
  fontSize?: FontSize;
}): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  withoutTransitions(() => {
    if (opts.mode) root.setAttribute('data-scheme', resolveScheme(opts.mode));
    if (opts.contrast) root.setAttribute('data-contrast', opts.contrast);
    if (opts.density) root.setAttribute('data-density', opts.density);
    if (opts.fontSize) root.style.setProperty('--font-scale', FONT_SCALE[opts.fontSize]);
  });
}

function createAppearanceStore() {
  const [rawMode, setRawMode] = createPersistedStringSignal(MODE_KEY, 'system');
  const [rawContrast, setRawContrast] = createPersistedStringSignal(CONTRAST_KEY, 'normal');
  const [rawDensity, setRawDensity] = createPersistedStringSignal(DENSITY_KEY, 'comfortable');
  const [rawFontSize, setRawFontSize] = createPersistedStringSignal(FONT_SIZE_KEY, 'default');
  const [rawBase, setRawBase] = createPersistedStringSignal(BASE_SEED_KEY, DEFAULT_BASE_SEED);
  const [rawAccent, setRawAccent] = createPersistedStringSignal(ACCENT_SEED_KEY, DEFAULT_ACCENT_SEED);

  const mode = (): Mode => (isMode(rawMode()) ? (rawMode() as Mode) : 'system');
  const contrast = (): Contrast => (isContrast(rawContrast()) ? (rawContrast() as Contrast) : 'normal');
  const density = (): Density => (isDensity(rawDensity()) ? (rawDensity() as Density) : 'comfortable');
  const fontSize = (): FontSize => (isFontSize(rawFontSize()) ? (rawFontSize() as FontSize) : 'default');

  // `system` has to keep tracking the OS after the first paint, so the media
  // query is a signal of its own rather than a one-off read.
  const [systemDark, setSystemDark] = createSignal(prefersDark());
  if (typeof window !== 'undefined') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    onCleanup(() => mq.removeEventListener('change', onChange));
  }

  const scheme = (): 'light' | 'dark' =>
    mode() === 'system' ? (systemDark() ? 'dark' : 'light') : (mode() as 'light' | 'dark');

  const seedsAreDefault = () => rawBase() === DEFAULT_BASE_SEED && rawAccent() === DEFAULT_ACCENT_SEED;
  const seedTokens = createMemo(() =>
    seedsAreDefault()
      ? undefined
      : resolveSeedTokens(baseSeed(rawBase()).color, accentSeed(rawAccent()).color, scheme() === 'dark')
  );

  return {
    mode,
    setMode: (v: Mode) => setRawMode(v),
    contrast,
    setContrast: (v: Contrast) => setRawContrast(v),
    density,
    setDensity: (v: Density) => setRawDensity(v),
    fontSize,
    setFontSize: (v: FontSize) => setRawFontSize(v),
    base: () => baseSeed(rawBase()),
    setBase: (id: string) => setRawBase(id),
    accent: () => accentSeed(rawAccent()),
    setAccent: (id: string) => setRawAccent(id),
    scheme,
    /** The semantic tokens the seeds regenerate, or undefined for the authored defaults. */
    seedTokens,
  };
}

// One store for the page, created once: every reader shares its signals and
// listeners instead of building its own copy.
const store = createRoot(createAppearanceStore);

export const useAppearance = () => store;

/**
 * The one writer of the appearance onto <html>, mounted once by the root
 * layout. Readers never write: the CSS is the subscriber.
 */
export function mountAppearance() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;

  createEffect(() => {
    const next = store.scheme();
    withoutTransitions(() => root.setAttribute('data-scheme', next));
  });

  // Seeds regenerate the semantic layer through opencode's OKLCH generator.
  // The defaults are the authored stylesheet, so choosing them clears the
  // overrides rather than approximating the hand-tuned values.
  createEffect(() => {
    const tokens = store.seedTokens();
    withoutTransitions(() => {
      if (!tokens) {
        for (const name of SEED_TOKEN_NAMES) root.style.removeProperty(name);
        return;
      }
      for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
    });
  });

  createEffect(() => applyAppearance({ contrast: store.contrast() }));
  createEffect(() => applyAppearance({ density: store.density() }));
  createEffect(() => applyAppearance({ fontSize: store.fontSize() }));

  keepBrandThemeColor();
}

/**
 * The embedded chat writes its own grey into <meta name="theme-color"> each
 * time it applies a theme, and never puts the brand colour back. The browser
 * bar and an installed app's title bar belong to the shell, so the shell
 * restores it.
 */
function keepBrandThemeColor() {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) return;
  const brand = meta.content;
  const observer = new MutationObserver(() => {
    if (meta.content !== brand) meta.content = brand;
  });
  observer.observe(meta, { attributes: true, attributeFilter: ['content'] });
  onCleanup(() => observer.disconnect());
}
