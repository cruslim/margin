import { THEME_TOKENS, type Theme } from '../../shared/themes.js';

/** Write a theme's tokens onto :root — the whole UI repaints from CSS variables. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(THEME_TOKENS)) {
    root.style.setProperty(cssVar, theme.colors[key as keyof typeof THEME_TOKENS]);
  }
  root.dataset.mode = theme.mode;
}
