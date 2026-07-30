import { THEME_TOKENS, type Theme } from '../../shared/themes.js';

/** Write a theme's tokens onto :root — the whole UI repaints from CSS variables. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(THEME_TOKENS)) {
    const value = theme.colors[key as keyof typeof THEME_TOKENS];
    // Custom themes saved before a token existed lack it — keep the stylesheet default.
    if (value) root.style.setProperty(cssVar, value);
  }
  root.dataset.mode = theme.mode;
}
