import { useEffect, useMemo, useRef, useState } from 'react';
import { DiffViewWithMultiSelect, DiffModeEnum, SplitSide } from '@git-diff-view/react';
import type { DiffViewWithMultiSelectRef } from '@git-diff-view/react';
import type { Comment, FileDiff, Finding, ReviewTarget } from '../../../shared/ipc.js';
import type { ChatScope } from '../App.js';
import { dismissalKey } from '../App.js';
import { FindingCard } from './FindingCard.js';
import { GenBadge } from './FileList.js';
import { ChatBubble, ChatInput, StreamingBubble } from './ChatParts.js';
import { agentValue, answererOf, ANSWER_EXTERNAL } from './answerer.js';
import { CopyPromptButton } from './CopyPrompt.js';

interface LineExtend {
  finding?: Finding;
  comments: Comment[];
  /** The drag-selection composer belongs on this line — the last line selected. */
  composer?: boolean;
}

export function DiffPane(props: {
  target: ReviewTarget;
  path: string;
  /** File is auto-generated — flagged in the toolbar. */
  generated?: boolean;
  /** Fetched by App, whose content also anchors the findings panel. */
  diff: FileDiff | null;
  error?: string | null;
  /** Changes on an explicit refresh, to drop a half-made selection. */
  reloadKey?: number;
  findings: Finding[];
  comments: Comment[];
  /** Configured specialist agent names, selectable in the comment composer. */
  agents: string[];
  /** Picker value a fresh composer starts on, from AppSettings.defaultAnswerer. */
  defaultAnswerer: string;
  /** Active theme's mode — flips the diff viewer's own palette. */
  themeMode: 'dark' | 'light';
  busy: boolean;
  /** Resolves (and creates) this session's bridge directory — called only when asked for. */
  resolveBridgeDir: () => Promise<string>;
  streamScope?: ChatScope;
  streamText: string;
  onAddComment: (
    file: string,
    side: 'old' | 'new',
    startLine: number,
    endLine: number,
    quoted: string,
    text: string,
    answerer: { agent?: string; external?: boolean },
  ) => void;
  onReplyComment: (comment: Comment, text: string) => void;
  /** Hand an existing thread to your own agent — brokers it as it stands. */
  onHandOff: (comment: Comment) => void;
  /** Stop expecting a reply to this thread's outstanding turn. */
  onStopWaiting: (comment: Comment) => void;
  onToggleCollapse: (comment: Comment) => void;
  onToggleResolve: (comment: Comment) => void;
  onDeleteComment: (comment: Comment) => void;
  collapsedFindings: Record<string, boolean>;
  onToggleFinding: (f: Finding) => void;
  onApplyPatch: (patch: string, commentId: string) => void;
}) {
  const { diff, error } = props;
  const [mode, setMode] = useState<DiffModeEnum>(DiffModeEnum.SplitGitHub);
  const [pendingRange, setPendingRange] = useState<{ side: 'old' | 'new'; start: number; end: number } | null>(null);
  const msRef = useRef<DiffViewWithMultiSelectRef>(null);
  /** The scroll container the lib renders its table into — watched for rebuilds. */
  const scrollRef = useRef<HTMLDivElement>(null);

  /**
   * Composer state lives in refs, and the composers keep their own local copies.
   * Nothing a composer does may re-render DiffPane: the diff viewer rebuilds its
   * table on every render, which remounts the range composer (losing whatever it
   * held) and closes the `+` widget outright, since the viewer owns that widget's
   * open state. Refs let the values survive a remount caused by something else.
   * Null answerer means untouched — it follows the configured default.
   */
  const range = useRef({ draft: '', answerer: null as string | null });
  const widget = useRef({ draft: '', answerer: null as string | null, startLine: null as number | null });

  const clearRange = () => {
    setPendingRange(null);
    range.current = { draft: '', answerer: null };
    msRef.current?.clearSelection();
  };

  // Complete drag-selections ourselves: the lib's onMultiSelectComplete reads
  // line data from a DiffFile reference that goes stale after re-renders
  // (e.g. after a composer cancel), silently dropping subsequent selections.
  // onMultiSelectChange is DOM-driven and always fires, so track the range
  // during the drag and finish it on mouseup.
  const dragRange = useRef<{ side: 'old' | 'new'; start: number; end: number } | null>(null);
  useEffect(() => {
    const onUp = () => {
      // Defer past the lib's own mouseup handling.
      setTimeout(() => {
        const r = dragRange.current;
        dragRange.current = null;
        if (r && r.start !== r.end) setPendingRange(r);
      }, 0);
    };
    document.addEventListener('mouseup', onUp);
    return () => document.removeEventListener('mouseup', onUp);
  }, []);

  // The diff itself is fetched by App (its content anchors both the inline cards
  // and the findings panel); this just drops a half-made selection when the
  // underlying file changes out from under it.
  useEffect(() => {
    setPendingRange(null);
    range.current = { draft: '', answerer: null };
    widget.current = { draft: '', answerer: null, startLine: null };
  }, [props.path, props.reloadKey]);

  // Keep the drag-selected rows visibly lit while the range composer is open
  // (the lib clears its own selection highlight on mouseup).
  useEffect(() => {
    if (!pendingRange) return;
    const sideClass = pendingRange.side === 'old' ? 'diff-line-old-num' : 'diff-line-new-num';
    let lit = new Set<Element>();
    const apply = () => {
      const next = new Set<Element>();
      document.querySelectorAll(`td.${sideClass} span[data-line-num]`).forEach((span) => {
        const n = Number(span.getAttribute('data-line-num'));
        if (n >= pendingRange.start && n <= pendingRange.end) {
          const tr = span.closest('tr');
          if (tr) {
            tr.classList.add('margin-range-lit');
            next.add(tr);
          }
        }
      });
      for (const el of lit) if (!next.has(el)) el.classList.remove('margin-range-lit');
      lit = next;
    };
    apply();
    // The lib rebuilds its table asynchronously and on its own schedule — fixed
    // retry delays used to miss a slow rebuild (a file with an existing thread
    // rebuilds later), leaving the selection unlit with nothing to restore it.
    // Watching the DOM re-applies whenever the rows are actually replaced.
    const observer = new MutationObserver(apply);
    const root = scrollRef.current;
    if (root) observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      lit.forEach((el) => el.classList.remove('margin-range-lit'));
    };
  }, [pendingRange]);

  // Inline extends: findings anchor to the new side; comments to either side.
  // Both arrive already re-anchored from App.
  const extendData = useMemo(() => {
    const oldFile: Record<number, { data: LineExtend }> = {};
    const newFile: Record<number, { data: LineExtend }> = {};
    const at = (side: 'old' | 'new', line: number): LineExtend => {
      const bucket = side === 'old' ? oldFile : newFile;
      bucket[line] ??= { data: { comments: [] } };
      return bucket[line].data;
    };
    for (const f of props.findings) at('new', f.line).finding = f;
    for (const c of props.comments) at(c.side, c.endLine).comments.push(c);
    // Anchored to the end of the selection, so the composer opens under the lines
    // it is about — like the single-line `+` composer, and like the thread it becomes.
    if (pendingRange) at(pendingRange.side, pendingRange.end).composer = true;
    return { oldFile, newFile };
  }, [props.findings, props.comments, pendingRange]);

  const quotedLines = (side: SplitSide, startLine: number, endLine: number): string => {
    const content = side === SplitSide.old ? diff?.oldContent : diff?.newContent;
    return content?.split('\n').slice(startLine - 1, endLine).join('\n') ?? '';
  };

  if (error) return <div className="empty-note">{error}</div>;
  if (!diff) return <div className="empty-note">Loading diff…</div>;
  if (diff.hunks.length === 0) return <div className="empty-note">No changes in this file</div>;

  return (
    <div className="diff-container">
      <div className="diff-toolbar">
        <span className="diff-title">
          <span className="diff-path">{diff.path}</span>
          {props.generated && <GenBadge />}
        </span>
        <button
          className="icon-btn"
          onClick={() => setMode(mode === DiffModeEnum.SplitGitHub ? DiffModeEnum.Unified : DiffModeEnum.SplitGitHub)}
        >
          {mode === DiffModeEnum.SplitGitHub ? 'unified' : 'split'}
        </button>
      </div>
      <div className="diff-scroll" ref={scrollRef}>
        <DiffViewWithMultiSelect<LineExtend>
          ref={msRef}
          onMultiSelectChange={(range) => {
            dragRange.current = range
              ? {
                  side: range.side as 'old' | 'new',
                  start: Math.min(range.startLineNumber, range.endLineNumber),
                  end: Math.max(range.startLineNumber, range.endLineNumber),
                }
              : null;
          }}
          data={{
            oldFile: { fileName: diff.path, content: diff.oldContent, fileLang: diff.lang },
            newFile: { fileName: diff.path, content: diff.newContent, fileLang: diff.lang },
            hunks: diff.hunks,
          }}
          diffViewMode={mode}
          diffViewTheme={props.themeMode}
          diffViewHighlight
          // Wrap mode is required for drag-select: the lib only emits the
          // data-side attributes the MultiSelectManager needs when wrapping.
          diffViewWrap
          diffViewFontSize={12.5}
          diffViewAddWidget
          enableMultiSelect
          renderWidgetLine={({ side, lineNumber, fromLineNumber, onClose }) => {
            const from = Math.min(fromLineNumber || lineNumber, lineNumber);
            const to = Math.max(fromLineNumber || lineNumber, lineNumber);
            return (
              <CommentComposer
                busy={props.busy}
                agents={props.agents}
                defaultAnswerer={props.defaultAnswerer}
                resolveBridgeDir={props.resolveBridgeDir}
                startLine={widget.current.startLine ?? from}
                endLine={to}
                initialAnswerer={widget.current.answerer}
                initialDraft={widget.current.draft}
                onEdit={(patch) => {
                  // Written straight to the ref: a re-render here would close this
                  // very composer, since the diff viewer owns whether it is open.
                  widget.current = { ...widget.current, ...patch };
                }}
                onCancel={() => {
                  widget.current = { draft: '', answerer: null, startLine: null };
                  onClose();
                }}
                onSend={(startLine, text, answerer) => {
                  widget.current = { draft: '', answerer: null, startLine: null };
                  props.onAddComment(
                    props.path,
                    side === SplitSide.old ? 'old' : 'new',
                    startLine,
                    to,
                    quotedLines(side, startLine, to),
                    text,
                    answerer,
                  );
                  onClose();
                }}
              />
            );
          }}
          extendData={extendData}
          renderExtendLine={({ data }) =>
            data ? (
              <div className="line-extends">
                {data.composer && pendingRange && (
                  <RangeComposer
                    busy={props.busy}
                    agents={props.agents}
                    defaultAnswerer={props.defaultAnswerer}
                    resolveBridgeDir={props.resolveBridgeDir}
                    range={pendingRange}
                    initialAnswerer={range.current.answerer}
                    initialDraft={range.current.draft}
                    onEdit={(patch) => {
                      range.current = { ...range.current, ...patch };
                    }}
                    onCancel={clearRange}
                    onSend={(text, answerer) => {
                      props.onAddComment(
                        props.path,
                        pendingRange.side,
                        pendingRange.start,
                        pendingRange.end,
                        quotedLines(
                          pendingRange.side === 'old' ? SplitSide.old : SplitSide.new,
                          pendingRange.start,
                          pendingRange.end,
                        ),
                        text,
                        answerer,
                      );
                      clearRange();
                    }}
                  />
                )}
                {data.finding && (
                  <FindingCard
                    finding={data.finding}
                    inline
                    collapsed={!!props.collapsedFindings[dismissalKey(data.finding)]}
                    onToggleCollapse={() => props.onToggleFinding(data.finding!)}
                  />
                )}
                {data.comments.map((c) => (
                  <CommentThread
                    key={c.id}
                    comment={c}
                    busy={props.busy}
                    streaming={
                      props.streamScope?.type === 'comment' && props.streamScope.id === c.id
                        ? props.streamText
                        : undefined
                    }
                    onReply={(text) => props.onReplyComment(c, text)}
                    onHandOff={() => props.onHandOff(c)}
                    onStopWaiting={() => props.onStopWaiting(c)}
                    onToggleCollapse={() => props.onToggleCollapse(c)}
                    onToggleResolve={() => props.onToggleResolve(c)}
                    onDelete={() => props.onDeleteComment(c)}
                    onApplyPatch={(patch) => props.onApplyPatch(patch, c.id)}
                  />
                ))}
              </div>
            ) : null
          }
        />
      </div>
    </div>
  );
}

/**
 * Who answers a new thread — the main reviewer, a specialist Margin briefs, or
 * your own agent over the file bridge.
 */
function Answerer(props: { agents: string[]; value: string; onChange: (v: string) => void }) {
  // Not "reviewer": the person using Margin is the reviewer, and this picks who
  // answers them.
  return (
    <label className="labelled-select composer-answerer">
      answered by
      <AnswererPicker agents={props.agents} value={props.value} onChange={props.onChange} />
    </label>
  );
}

/**
 * Offered beside the picker once the handoff is chosen — that's the moment you
 * need to go and brief the agent. On the picker's row, not the action row: there
 * it competed with Cancel/Comment and pushed them past the composer's edge.
 */
function CopyPrompt(props: { show: boolean; resolveBridgeDir: () => Promise<string> }) {
  if (!props.show) return null;
  return <CopyPromptButton resolveDir={props.resolveBridgeDir} />;
}

function AnswererPicker(props: { agents: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <select
      className="agent-select"
      title="Who answers this thread — Margin's own reviewer, a specialist it briefs, or your own agent"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    >
      <option value="">default</option>
      {props.agents.map((a) => (
        <option key={a} value={agentValue(a)}>
          @{a}
        </option>
      ))}
      <option value={ANSWER_EXTERNAL}>↗ my agent</option>
    </select>
  );
}

/**
 * Composer state is local, and every change is also reported to `onEdit` so it
 * survives a remount. It must not be lifted into DiffPane: a render there closes
 * this composer, because the diff viewer owns whether its widget line is open.
 */
function CommentComposer(props: {
  busy: boolean;
  agents: string[];
  defaultAnswerer: string;
  resolveBridgeDir: () => Promise<string>;
  startLine: number;
  endLine: number;
  initialAnswerer: string | null;
  initialDraft: string;
  onEdit: (patch: { draft?: string; answerer?: string; startLine?: number }) => void;
  onCancel: () => void;
  onSend: (startLine: number, text: string, answerer: { agent?: string; external?: boolean }) => void;
}) {
  const [answerer, setAnswerer] = useState(props.initialAnswerer ?? props.defaultAnswerer);
  const [startLine, setStartLine] = useState(props.startLine);

  return (
    <div className="comment-composer">
      <div className="composer-range">
        <Answerer
          agents={props.agents}
          value={answerer}
          onChange={(v) => {
            setAnswerer(v);
            props.onEdit({ answerer: v });
          }}
        />
        <CopyPrompt show={answerer === ANSWER_EXTERNAL} resolveBridgeDir={props.resolveBridgeDir} />
      </div>
      <ChatInput
        disabled={answerer !== ANSWER_EXTERNAL && props.busy}
        initialValue={props.initialDraft}
        onTextChange={(v) => props.onEdit({ draft: v })}
        leading={
          <span className="composer-lines">
            Lines{' '}
            <input
              type="number"
              min={1}
              max={props.endLine}
              value={startLine}
              onChange={(e) => {
                const v = Number(e.target.value);
                const next = Number.isFinite(v) ? Math.max(1, Math.min(props.endLine, v)) : props.endLine;
                setStartLine(next);
                props.onEdit({ startLine: next });
              }}
            />{' '}
            – {props.endLine}
          </span>
        }
        placeholder={
          answerer === ANSWER_EXTERNAL
            ? 'Comment on these lines — sends to your agent…'
            : 'Comment on these lines — starts an AI thread…'
        }
        autoFocus
        onCancel={props.onCancel}
        onSend={(text) => props.onSend(startLine, text, answererOf(answerer))}
      />
    </div>
  );
}

/** The drag-selection composer. Same local-state-plus-ref rule as CommentComposer. */
function RangeComposer(props: {
  busy: boolean;
  agents: string[];
  defaultAnswerer: string;
  resolveBridgeDir: () => Promise<string>;
  range: { side: 'old' | 'new'; start: number; end: number };
  initialAnswerer: string | null;
  initialDraft: string;
  onEdit: (patch: { draft?: string; answerer?: string }) => void;
  onCancel: () => void;
  onSend: (text: string, answerer: { agent?: string; external?: boolean }) => void;
}) {
  const [answerer, setAnswerer] = useState(props.initialAnswerer ?? props.defaultAnswerer);
  const external = answerer === ANSWER_EXTERNAL;

  return (
    <div className="range-composer">
      <div className="composer-range">
        <Answerer
          agents={props.agents}
          value={answerer}
          onChange={(v) => {
            setAnswerer(v);
            props.onEdit({ answerer: v });
          }}
        />
        <CopyPrompt show={external} resolveBridgeDir={props.resolveBridgeDir} />
      </div>
      <ChatInput
        // A handoff spends no AI call, so an in-flight Margin turn doesn't block it.
        disabled={!external && props.busy}
        initialValue={props.initialDraft}
        onTextChange={(v) => props.onEdit({ draft: v })}
        leading={
          <span className="composer-lines">
            Comment on lines {props.range.start}–{props.range.end}
            {props.range.side === 'old' ? ' (old side)' : ''}
          </span>
        }
        placeholder={
          external
            ? 'Comment on the selected lines — sends to your agent…'
            : 'Comment on the selected lines — starts an AI thread…'
        }
        autoFocus
        onCancel={props.onCancel}
        onSend={(text) => props.onSend(text, answererOf(answerer))}
      />
    </div>
  );
}

function CommentThread(props: {
  comment: Comment;
  busy: boolean;
  streaming?: string;
  onReply: (text: string) => void;
  onHandOff: () => void;
  onStopWaiting: () => void;
  onToggleCollapse: () => void;
  onToggleResolve: () => void;
  onDelete: () => void;
  onApplyPatch: (patch: string) => void;
}) {
  const [replyOpen, setReplyOpen] = useState(false);
  const external = !!props.comment.external;
  // A brokered turn is pending until its reply lands — recorded on the comment,
  // so it survives a restart and doesn't depend on the session-wide busy flag.
  const pending = props.comment.pendingTurn != null;
  const lastRole = props.comment.messages[props.comment.messages.length - 1]?.role;
  const waiting = external
    ? pending
    : props.busy && props.streaming === undefined && lastRole === 'user';
  const collapsed = !!props.comment.collapsed;
  const resolved = !!props.comment.resolved;

  const head = (
    <div className="comment-head" onClick={props.onToggleCollapse} title={collapsed ? 'Expand' : 'Collapse'}>
      <span className="comment-chevron">{collapsed ? '▸' : '▾'}</span>
      <span className={`comment-title ${resolved ? 'resolved' : ''}`}>{resolved ? 'Resolved' : 'Comment'}</span>
      {props.comment.agent && <span className="comment-agent">@{props.comment.agent}</span>}
      {/* Identifies the answerer like @specialist does, and stays visible collapsed
          so a folded thread still shows something is out. */}
      {external && (
        <span className="comment-agent external" title={pending ? 'Waiting on your agent' : 'Answered by your agent'}>
          ↗ my agent
        </span>
      )}
      {collapsed && (
        <span className="comment-preview">
          {props.comment.messages[0]?.text.slice(0, 80)}
          {props.comment.messages.length > 1 ? ` · ${props.comment.messages.length} messages` : ''}
        </span>
      )}
      <span className="comment-loc">
        {props.comment.file}:
        {props.comment.startLine !== props.comment.endLine
          ? `${props.comment.startLine}–${props.comment.endLine}`
          : props.comment.endLine}
        {props.comment.side === 'old' ? ' (old)' : ''}
      </span>
      <button
        className="icon-btn comment-resolve"
        title={resolved ? 'Reopen this conversation' : 'Mark conversation as resolved'}
        onClick={(e) => {
          e.stopPropagation();
          props.onToggleResolve();
        }}
      >
        {resolved ? 'Unresolve' : 'Resolve'}
      </button>
      <button
        className="icon-btn comment-delete"
        title="Delete comment thread"
        onClick={(e) => {
          e.stopPropagation();
          props.onDelete();
        }}
      >
        ✕
      </button>
    </div>
  );

  if (collapsed) {
    return <div className={`comment-thread collapsed ${resolved ? 'resolved' : ''}`}>{head}</div>;
  }

  return (
    <div className={`comment-thread ${resolved ? 'resolved' : ''}`}>
      {head}
      {props.comment.messages.map((m, i) => (
        <ChatBubble key={i} msg={m} onApplyPatch={props.onApplyPatch} />
      ))}
      {props.streaming !== undefined && <StreamingBubble text={props.streaming} />}
      {waiting &&
        (external ? (
          <div className="busy-dot waiting-external">
            waiting on your agent…
            <button className="icon-btn stop-waiting" title="Stop expecting a reply" onClick={props.onStopWaiting}>
              Stop waiting
            </button>
          </div>
        ) : (
          <div className="busy-dot">thinking…</div>
        ))}
      <div className="thread-actions">
        <button onClick={() => setReplyOpen(!replyOpen)}>Reply</button>
        {/* Offered once Margin has answered too: read the explanation, then have
            your own agent go and make the change. */}
        {!external && !waiting && (
          <button title="Send this thread to your own agent to act on" onClick={props.onHandOff}>
            ↗ hand to my agent
          </button>
        )}
      </div>
      {replyOpen && (
        <ChatInput
          disabled={!external && props.busy}
          placeholder="Reply…"
          autoFocus
          onSend={(text) => {
            props.onReply(text);
            setReplyOpen(false);
          }}
        />
      )}
    </div>
  );
}
