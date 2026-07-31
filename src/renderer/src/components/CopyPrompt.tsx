import { useState } from 'react';
import { CopyIcon } from './ChatParts.js';

/**
 * What to tell an agent so it starts working the bridge — the path alone leaves
 * it guessing. Asks for continuous pickup rather than a single pass: comments
 * arrive while the agent works, so a one-shot reading would miss everything
 * after the first.
 */
export function briefingFor(dir: string): string {
  return (
    `I'm reviewing this branch in Margin and my review comments are brokered to you as files. ` +
    `Read ${dir}/README.md for the protocol, then work the items in ${dir}/inbox/: make the change ` +
    `each one asks for in the repo, and write one reply file per item.\n\n` +
    `Keep picking these up as I review — when you finish the current items, check ${dir}/inbox/ ` +
    `again rather than treating this as a one-off. New items appear there whenever I comment.`
  );
}

/**
 * Hands over that sentence, beside the answerer picker that chose the handoff —
 * on its own it reads as mystery meat, since nothing says what the prompt is for.
 * The directory is resolved on click rather than up front, because resolving it
 * creates it: nothing should appear in app data for a session that never uses
 * the bridge.
 */
export function CopyPromptButton(props: { resolveDir: () => Promise<string> }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      className="icon-btn copy-prompt"
      title="Copy an instruction pointing your agent at this session’s bridge"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(briefingFor(await props.resolveDir()));
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard denied or the bridge path couldn't be resolved — nothing useful to say.
        }
      }}
    >
      {copied ? '✓' : CopyIcon}
      {/* Short, because it shares a row with the picker inside one column of the
          split view; the picker beside it already says what the prompt is for. */}
      {copied ? 'copied' : 'copy prompt'}
    </button>
  );
}
