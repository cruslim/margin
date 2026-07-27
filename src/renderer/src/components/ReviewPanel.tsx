import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, DismissedFinding, Finding } from '../../../shared/ipc.js';
import type { ChatScope, Session } from '../App.js';
import { dismissalKey } from '../App.js';
import { FindingCard } from './FindingCard.js';
import { ChatBubble, ChatInput, StreamingBubble } from './ChatParts.js';

const SEV_ORDER: Record<Finding['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 };

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

export function ReviewPanel(props: {
  width: number;
  session: Session;
  busy: boolean;
  streamScope?: ChatScope;
  streamText: string;
  dismissedKeys: Set<string>;
  dismissals: DismissedFinding[];
  collapsedFindings: Record<string, boolean>;
  onToggleFinding: (f: Finding) => void;
  onDismiss: (f: Finding) => void;
  onRestore: (key: string) => void;
  onJumpToFinding: (f: Finding) => void;
  onSendChat: (text: string, findingIndex?: number) => void;
  onProposeFix: (findingIndex: number) => void;
  onApplyPatch: (patch: string, findingIndex?: number) => void;
}) {
  const s = props.session;
  const [tab, setTab] = useState<'findings' | 'chat' | 'transcript'>('findings');
  const [logFilter, setLogFilter] = useState<string>('all');
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Transcript lines from extra finders are prefixed "[tag] …"; Claude's own
  // lines are unprefixed or "[tool] …".
  const sourceOf = (line: string): string => {
    const m = line.match(/^\[([^\]]+)\]/);
    return !m || m[1] === 'tool' ? 'claude' : m[1];
  };
  const logSources = useMemo(() => {
    const seen = new Set<string>(['claude']);
    for (const line of s.transcript) seen.add(sourceOf(line));
    return [...seen];
  }, [s.transcript]);
  const visibleLog =
    logFilter === 'all' ? s.transcript : s.transcript.filter((l) => sourceOf(l) === logFilter);

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
    .filter(({ finding }) => !props.dismissedKeys.has(dismissalKey(finding)) && finding.verdict !== 'refuted')
    .sort((a, b) => SEV_ORDER[a.finding.severity] - SEV_ORDER[b.finding.severity]);
  const refuted = s.findings.filter((f) => f.verdict === 'refuted');

  return (
    <aside className="review-panel" style={{ width: props.width }}>
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
                    collapsed={!!props.collapsedFindings[dismissalKey(finding)]}
                    onToggleCollapse={() => props.onToggleFinding(finding)}
                    streaming={
                      props.streamScope?.type === 'finding' && props.streamScope.index === index
                        ? props.streamText
                        : undefined
                    }
                    onJump={() => props.onJumpToFinding(finding)}
                    onDismiss={() => props.onDismiss(finding)}
                    onReply={(text) => props.onSendChat(text, index)}
                    onProposeFix={() => props.onProposeFix(index)}
                    onApplyPatch={(patch) => props.onApplyPatch(patch, index)}
                  />
                ))
              )}
              {refuted.length > 0 && <RefutedSection refuted={refuted} />}
              {props.dismissals.length > 0 && (
                <DismissedSection dismissals={props.dismissals} onRestore={props.onRestore} />
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
          streaming={props.streamScope?.type === 'chat' ? props.streamText : undefined}
          onSend={(text) => props.onSendChat(text)}
          onApplyPatch={(patch) => props.onApplyPatch(patch)}
        />
      )}

      {tab === 'transcript' && (
        <>
          {logSources.length > 1 && (
            <div className="log-pills">
              {['all', ...logSources].map((src) => (
                <button
                  key={src}
                  className={`log-pill ${logFilter === src ? 'active' : ''}`}
                  onClick={() => setLogFilter(src)}
                >
                  {src}
                </button>
              ))}
            </div>
          )}
          <div className="panel-body transcript" ref={transcriptRef}>
            {visibleLog.length === 0 ? (
              <div className="empty-note">Nothing yet.</div>
            ) : (
              visibleLog.map((line, i) => (
                <div key={i} className={`t-line ${line.startsWith('[tool]') ? 't-tool' : ''}`}>
                  {logFilter !== 'all' && logFilter !== 'claude'
                    ? line.replace(/^\[[^\]]+\]\s*/, '')
                    : line}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function FindingThread(props: {
  finding: Finding;
  thread: ChatMessage[];
  busy: boolean;
  streaming?: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onJump: () => void;
  onDismiss: () => void;
  onReply: (text: string) => void;
  onProposeFix: () => void;
  onApplyPatch: (patch: string) => void;
}) {
  const [replyOpen, setReplyOpen] = useState(false);

  if (props.collapsed) {
    return (
      <div className="finding-thread">
        <FindingCard
          finding={props.finding}
          onJump={props.onJump}
          collapsed
          onToggleCollapse={props.onToggleCollapse}
        />
      </div>
    );
  }

  return (
    <div className="finding-thread">
      <FindingCard finding={props.finding} onJump={props.onJump} onToggleCollapse={props.onToggleCollapse} />
      {props.thread.length > 0 && (
        <div className="thread-msgs">
          {props.thread.map((m, i) => (
            <ChatBubble key={i} msg={m} onApplyPatch={props.onApplyPatch} />
          ))}
        </div>
      )}
      {props.streaming !== undefined && (
        <div className="thread-msgs">
          <StreamingBubble text={props.streaming} />
        </div>
      )}
      <div className="thread-actions">
        <button onClick={() => setReplyOpen(!replyOpen)}>Reply</button>
        <button onClick={props.onProposeFix} disabled={props.busy}>Propose fix</button>
        <button className="dismiss-btn" onClick={props.onDismiss} title="Hide this finding and never report it again">
          Dismiss
        </button>
        {props.busy && props.streaming === undefined && <span className="busy-dot">thinking…</span>}
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
  streaming?: string;
  onSend: (text: string) => void;
  onApplyPatch: (patch: string) => void;
}) {
  const s = props.session;
  const listRef = useRef<HTMLDivElement>(null);
  const messages = s.chat ?? [];

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, props.busy, props.streaming?.length]);

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
        {props.streaming !== undefined ? (
          <StreamingBubble text={props.streaming} />
        ) : (
          props.busy && <div className="busy-dot">thinking…</div>
        )}
      </div>
      <ChatInput disabled={props.busy} placeholder="Ask about this changeset…" onSend={props.onSend} />
    </div>
  );
}

function RefutedSection(props: { refuted: Finding[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="dismissed-section">
      <button className="dismissed-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} Refuted by verifier ({props.refuted.length})
      </button>
      {open &&
        props.refuted.map((f, i) => (
          <div key={i} className="refuted-item">
            <div className="dismissed-item">
              <span className="dismissed-summary">
                {f.source ? `[${f.source}] ` : ''}{f.file}:{f.line} — {f.summary}
              </span>
            </div>
            {f.verdictReason && <div className="refuted-reason">{f.verdictReason}</div>}
          </div>
        ))}
    </div>
  );
}

function DismissedSection(props: { dismissals: DismissedFinding[]; onRestore: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="dismissed-section">
      <button className="dismissed-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} Dismissed ({props.dismissals.length})
      </button>
      {open &&
        props.dismissals.map((d) => {
          const key = dismissalKey(d);
          return (
            <div key={key} className="dismissed-item">
              <span className="dismissed-summary">
                {d.file}: {d.summary}
              </span>
              <button className="finding-loc" onClick={() => props.onRestore(key)}>Restore</button>
            </div>
          );
        })}
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
