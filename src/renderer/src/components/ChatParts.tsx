import { useState } from 'react';
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

export function ChatBubble(props: { msg: ChatMessage; onApplyPatch: (patch: string) => void }) {
  const { msg } = props;
  const parts = msg.role === 'assistant' ? splitDiffBlocks(msg.text) : [{ type: 'text' as const, content: msg.text }];
  return (
    <div className={`chat-msg ${msg.role}`}>
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
  onSend: (text: string) => void;
  onCancel?: () => void;
}) {
  const [text, setText] = useState('');
  const send = () => {
    const t = text.trim();
    if (!t || props.disabled) return;
    props.onSend(t);
    setText('');
  };
  return (
    <div className="chat-input">
      <textarea
        value={text}
        placeholder={props.placeholder}
        rows={3}
        autoFocus={props.autoFocus}
        disabled={props.disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
          if (e.key === 'Escape') props.onCancel?.();
        }}
      />
      <div className="chat-input-actions">
        {props.onCancel && (
          <button className="icon-btn" onClick={props.onCancel}>Cancel</button>
        )}
        <button className="run-btn small" disabled={props.disabled || !text.trim()} onClick={send}>
          {props.onCancel ? 'Comment' : 'Send'}
        </button>
      </div>
    </div>
  );
}
