import { describe, expect, it } from 'vitest';
import { queryAbort, ReviewCancelledError, throwIfCancelled } from './types.js';

describe('review cancellation helpers', () => {
  it('throwIfCancelled is a no-op without a signal or before it fires', () => {
    expect(() => throwIfCancelled()).not.toThrow();
    expect(() => throwIfCancelled(new AbortController().signal)).not.toThrow();
  });

  it('throwIfCancelled rejects with the cancelled error once the signal fired', () => {
    const cancel = new AbortController();
    cancel.abort();
    expect(() => throwIfCancelled(cancel.signal)).toThrow(ReviewCancelledError);
    expect(() => throwIfCancelled(cancel.signal)).toThrow('Review cancelled');
  });

  it('queryAbort relays the review signal into a fresh controller', () => {
    const cancel = new AbortController();
    const a = queryAbort(cancel.signal);
    const b = queryAbort(cancel.signal);
    expect(a).not.toBe(b);
    expect(a.signal.aborted).toBe(false);
    cancel.abort();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
  });

  it('queryAbort starts aborted when the review was already cancelled', () => {
    const cancel = new AbortController();
    cancel.abort();
    expect(queryAbort(cancel.signal).signal.aborted).toBe(true);
    expect(queryAbort(undefined).signal.aborted).toBe(false);
  });
});
