import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { applyTheme } from './theme.js';
import { resolveTheme } from '../../shared/themes.js';
import '@git-diff-view/react/styles/diff-view.css';
import './styles.css';

const render = () =>
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

// Apply the active theme before the first paint so a non-default theme never
// flashes the stylesheet's built-in palette. Render regardless if settings fail.
window.margin
  .getSettings()
  .then((s) => applyTheme(resolveTheme(s.themes)))
  .catch(() => {})
  .finally(render);
