import type { DesktopTheme } from '@opencode/ui/theme/types';

/**
 * The shell palette, handed to the embedded chat.
 *
 * The chat renders from opencode's own theme system, and that system is in the
 * vendored tree we do not edit. It accepts a theme object at runtime though, so
 * the shell registers this one and selects it — the palette lives here, on the
 * consuming side, next to the overrides that already shape the chat.
 *
 * Values are the same literals the shell authors in `styles/shell.css`, and
 * they are per mode for the same reason: dark is authored, not inverted, so the
 * primary brightens and the ink flips while the domain hues hold still.
 */
export const SHELL_CHAT_THEME_ID = 'opsiforce-shell';

export const SHELL_CHAT_THEME: DesktopTheme = {
  id: SHELL_CHAT_THEME_ID,
  name: 'Opsiforce',
  light: {
    palette: {
      // the chat IS the content surface, not the canvas around it: the band's
      // selected tab has to merge into it
      neutral: '#ffffff', // --bg-content
      ink: '#1d1b32', // --ink-strong
      primary: '#605ef6', // --fill-solid
      accent: '#544fe6', // --ink-accent
      interactive: '#605ef6',
      success: '#1c9a6b', // --job-done
      warning: '#c2871b', // --job-needs-you
      error: '#d9484c', // --job-failed
      info: '#4f86e8', // --job-running
      diffAdd: '#1c9a6b', // --diff-added
      diffDelete: '#d9484c', // --diff-deleted
    },
  },
  dark: {
    palette: {
      neutral: '#16161f', // --bg-content, dark
      ink: '#f3f2fb',
      // #8C89FF tops out at APCA Lc 48.3 against any ink, so the fill goes all
      // the way to the brand tint and takes dark ink instead.
      primary: '#cbcbff',
      accent: '#cbcbff',
      interactive: '#cbcbff',
      success: '#1c9a6b',
      warning: '#c2871b',
      error: '#d9484c',
      info: '#4f86e8',
      diffAdd: '#1c9a6b',
      diffDelete: '#d9484c',
    },
  },
};
