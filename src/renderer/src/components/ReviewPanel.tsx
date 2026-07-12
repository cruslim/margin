import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, Finding } from '../../../shared/ipc.js';
import type { Session } from '../App.js';
import { FindingCard } from './FindingCard.js';
import { ChatBubble, ChatInput } from './ChatParts.js';

const SEV_ORDER: Record<Finding['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 };

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

export function ReviewPanel(props: {
  session: Session;
  busy: boolean;
  onJumpToFinding: (f: Finding) => void;
  onSendChat: (text: string, findingIndex?: number) => void;
  onProposeFix: (findingIndex: number) => void;
  onApplyPatch: (patch: string, findingIndex?: number) => void;
}) {
  const s = props.session;
  const [tab, setTab] = useState<'findings' | 'chat' | 'transcript'>('findings');
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Follow the transcript while a review is running.
  useEffect(() => {
    if (s.status === 'reviewing') setTab('transcript');
    if (s.status === 'done') setTab('findings');
  }, [s.status]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [s.transcript.length]);

  // Keep original indices — threads are keyed by them.
  const sorted = s.findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => SEV_ORDER[a.finding.severity] - SEV_ORDER[b.finding.severity]);

  return (
    <aside className="review-panel">
      <div className="panel-tabs">
        <button className={tab === 'findings' ? 'active' : ''} onClick={() => setTab('findings')}>
          Findings{s.findings.length > 0 ? ` (${s.findings.length})` : ''}
        </button>
        <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
          Chat
        </button>
        <button className={tab === 'transcript' ? 'active' : ''} onClick={() => setTab('transcript')}>
          Agent log
        </button>
      </div>

      {tab === 'findings' && (
        <div className="panel-body">
          {s.status === 'idle' && <div className="empty-note">Run a review to get findings.</div>}
          {s.status === 'reviewing' && <div className="empty-note">Reviewing… watch the agent log.</div>}
          {s.status === 'error' && <div className="error-note">{s.error}</div>}
          {s.status === 'done' && (
            <>
              {s.changeSummary && <p className="change-summary">{s.changeSummary}</p>}
              {sorted.length === 0 ? (
                <div className="empty-note ok">No blocking findings — looks good.</div>
              ) : (
                sorted.map(({ finding, index }) => (
                  <FindingThread
                    key={index}
                    finding={finding}
                    thread={s.threads?.[index] ?? []}
                    busy={props.busy}
                    onJump={() => props.onJumpToFinding(finding)}
                    onReply={(text) => props.onSendChat(text, index)}
                    onProposeFix={() => props.onProposeFix(index)}
                    onApplyPatch={(patch) => props.onApplyPatch(patch, index)}
                  />
                ))
              )}
              <ReviewStats session={s} />
            </>
          )}
        </div>
      )}

      {tab === 'chat' && (
        <ChatTab
          session={s}
          busy={props.busy}
          onSend={(text) => props.onSendChat(text)}
          onApplyPatch={(patch) => props.onApplyPatch(patch)}
        />
      )}

      {tab === 'transcript' && (
        <div className="panel-body transcript" ref={transcriptRef}>
          {s.transcript.length === 0 ? (
            <div className="empty-note">Nothing yet.</div>
          ) : (
            s.transcript.map((line, i) => (
              <div key={i} className={`t-line ${line.startsWith('[tool]') ? 't-tool' : ''}`}>
                {line}
              </div>
            ))
          )}
        </div>
      )}
    </aside>
  );
}

function FindingThread(props: {
  finding: Finding;
  thread: ChatMessage[];
  busy: boolean;
  onJump: () => void;
  onReply: (text: string) => void;
  onProposeFix: () => void;
  onApplyPatch: (patch: string) => void;
}) {
  const [replyOpen, setReplyOpen] = useState(false);

  return (
    <div className="finding-thread">
      <FindingCard finding={props.finding} onJump={props.onJump} />
      {props.thread.length > 0 && (
        <div className="thread-msgs">
          {props.thread.map((m, i) => (
            <ChatBubble key={i} msg={m} onApplyPatch={props.onApplyPatch} />
          ))}
        </div>
      )}
      <div className="thread-actions">
        <button onClick={() => setReplyOpen(!replyOpen)}>Reply</button>
        <button onClick={props.onProposeFix} disabled={props.busy}>Propose fix</button>
        {props.busy && <span className="busy-dot">thinking…</span>}
      </div>
      {replyOpen && (
        <ChatInput
          disabled={props.busy}
          placeholder="Ask about this finding…"
          onSend={(text) => {
            props.onReply(text);
            setReplyOpen(false);
          }}
        />
      )}
    </div>
  );
}

function ChatTab(props: {
  session: Session;
  busy: boolean;
  onSend: (text: string) => void;
  onApplyPatch: (patch: string) => void;
}) {
  const s = props.session;
  const listRef = useRef<HTMLDivElement>(null);
  const messages = s.chat ?? [];

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, props.busy]);

  if (!s.sdkSessionId) {
    return (
      <div className="panel-body">
        <div className="empty-note">Run a review first — chat continues that session with everything the reviewer learned.</div>
      </div>
    );
  }

  return (
    <div className="chat-tab">
      <div className="panel-body chat-list" ref={listRef}>
        {messages.length === 0 && (
          <div className="empty-note">
            Ask anything about this changeset — “summarize the risk”, “are there tests for this?”, “propose a refactor”.
          </div>
        )}
        {messages.map((m, i) => (
          <ChatBubble key={i} msg={m} onApplyPatch={props.onApplyPatch} />
        ))}
        {props.busy && <div className="busy-dot">thinking…</div>}
      </div>
      <ChatInput disabled={props.busy} placeholder="Ask about this changeset…" onSend={props.onSend} />
    </div>
  );
}

function ReviewStats({ session: s }: { session: Session }) {
  if (s.costUsd == null && !s.usage && !s.model) return null;
  return (
    <div className="review-stats">
      {s.model && <span title="Model that ran the review">{s.model}</span>}
      {s.usage && (
        <span title={`input ${s.usage.inputTokens} · output ${s.usage.outputTokens} · cache read ${s.usage.cacheReadTokens} · cache write ${s.usage.cacheCreationTokens}`}>
          {fmtTokens(s.usage.inputTokens + s.usage.cacheReadTokens + s.usage.cacheCreationTokens)} in ·{' '}
          {fmtTokens(s.usage.outputTokens)} out
        </span>
      )}
      {s.costUsd != null && <span>${s.costUsd.toFixed(4)}</span>}
    </div>
  );
}
