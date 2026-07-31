import { THEME_TOKENS, type Theme } from '../../shared/themes.js';

/** Write a theme's tokens onto :root — the whole UI repaints from CSS variables. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(THEME_TOKENS)) {
    const value = theme.colors[key as keyof typeof THEME_TOKENS];
    // Custom themes saved before a token existed lack it — fall back to the
    // stylesheet default, clearing anything a previous theme left inline.
    if (value) root.style.setProperty(cssVar, value);
    else root.style.removeProperty(cssVar);
  }
  root.dataset.mode = theme.mode;
}
