import { describe, expect, it } from 'vitest';
import { clickSelection } from './Sidebar.js';

describe('clickSelection', () => {
  it('views a clicked commit, and goes back to All changes on a second click', () => {
    expect(clickSelection(null, 'c2', false)).toEqual({ anchor: 'c2', end: 'c2' });
    expect(clickSelection({ anchor: 'c2', end: 'c2' }, 'c2', false)).toBeNull();
    expect(clickSelection({ anchor: 'c2', end: 'c2' }, 'c3', false)).toEqual({ anchor: 'c3', end: 'c3' });
  });

  it('stretches from where the selection started on shift-click', () => {
    expect(clickSelection({ anchor: 'c2', end: 'c2' }, 'c1', true)).toEqual({ anchor: 'c2', end: 'c1' });
    expect(clickSelection({ anchor: 'c2', end: 'c1' }, 'c3', true)).toEqual({ anchor: 'c2', end: 'c3' });
    // Nothing to stretch from: a plain selection.
    expect(clickSelection(null, 'c1', true)).toEqual({ anchor: 'c1', end: 'c1' });
  });
});

