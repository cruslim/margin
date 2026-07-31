import { useState, type ReactNode } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { ChatMessage } from '../../../shared/ipc.js';

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }));
}

/** Splits ```diff fences out of a message so patches render with an Apply button. */
export function splitDiffBlocks(text: string): Array<{ type: 'text' | 'diff'; content: string }> {
  const parts: Array<{ type: 'text' | 'diff'; content: string }> = [];
  const re = /```diff\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ type: 'text', content: text.slice(last, m.index).trim() });
    parts.push({ type: 'diff', content: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', content: text.slice(last).trim() });
  return parts.filter((p) => p.content);
}

/** Shared with the agent-prompt button, so every copy affordance looks the same. */
export const CopyIcon = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </svg>
);

/** Hover button that copies an AI reply's raw markdown to the clipboard. */
function CopyButton(props: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`copy-btn ${copied ? 'copied' : ''}`}
      title="Copy reply"
      onClick={() => {
        navigator.clipboard.writeText(props.text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? '✓' : CopyIcon}
    </button>
  );
}

export function ChatBubble(props: { msg: ChatMessage; onApplyPatch: (patch: string) => void }) {
  const { msg } = props;
  const parts = msg.role === 'assistant' ? splitDiffBlocks(msg.text) : [{ type: 'text' as const, content: msg.text }];
  return (
    <div className={`chat-msg ${msg.role}`}>
      {msg.role === 'assistant' && <CopyButton text={msg.text} />}
      {parts.map((p, i) =>
        p.type === 'diff' ? (
          <div key={i} className="patch-block">
            <pre>{p.content}</pre>
            <button className="run-btn small" onClick={() => props.onApplyPatch(p.content)}>
              Apply patch
            </button>
          </div>
        ) : msg.role === 'assistant' ? (
          <div key={i} className="chat-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(p.content) }} />
        ) : (
          <div key={i} className="chat-text">{p.content}</div>
        ),
      )}
    </div>
  );
}

/** Live bubble for a reply that's still streaming in. */
export function StreamingBubble(props: { text: string }) {
  return (
    <div className="chat-msg assistant streaming">
      {props.text ? (
        <div className="chat-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(props.text) }} />
      ) : (
        <div className="busy-dot">thinking…</div>
      )}
    </div>
  );
}

export function ChatInput(props: {
  disabled: boolean;
  placeholder: string;
  autoFocus?: boolean;
  /** Rendered at the left of the action row — carries the composer's line range. */
  leading?: ReactNode;
  /**
   * Draft survival across remounts, for the composers that live inside the diff
   * viewer's table — it rebuilds that table whenever DiffPane re-renders, which
   * remounts them and would otherwise discard what you had typed.
   *
   * Deliberately an initial value plus a change *notification*, not a controlled
   * value: holding the draft in DiffPane state would re-render the pane on every
   * keystroke, rebuilding the table each character and pushing the caret to the
   * end. The owner mirrors it into a ref instead. Omit both to keep the draft
   * local (the chat and thread-reply inputs aren't inside the table).
   */
  initialValue?: string;
  onTextChange?: (v: string) => void;
  onSend: (text: string) => void;
  onCancel?: () => void;
}) {
  const [text, setText] = useState(props.initialValue ?? '');
  const update = (v: string) => {
    setText(v);
    props.onTextChange?.(v);
  };
  const send = () => {
    const t = text.trim();
    if (!t || props.disabled) return;
    props.onSend(t);
    update('');
  };
  return (
    <div className="chat-input">
      <textarea
        value={text}
        placeholder={props.placeholder}
        rows={3}
        autoFocus={props.autoFocus}
        disabled={props.disabled}
        onChange={(e) => update(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
          if (e.key === 'Escape') props.onCancel?.();
        }}
      />
      <div className="chat-input-actions">
        {props.leading}
        {/* Grouped so a wrap in a narrow pane drops `leading` to its own line
            instead of separating Cancel from the submit button. */}
        <span className="chat-input-buttons">
          {props.onCancel && (
            <button className="icon-btn" onClick={props.onCancel}>Cancel</button>
          )}
          <button className="run-btn small" disabled={props.disabled || !text.trim()} onClick={send}>
            {props.onCancel ? 'Comment' : 'Send'}
          </button>
        </span>
      </div>
    </div>
  );
}
