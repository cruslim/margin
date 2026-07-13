import { useEffect, useMemo, useRef, useState } from 'react';
import { DiffViewWithMultiSelect, DiffModeEnum, SplitSide } from '@git-diff-view/react';
import type { DiffViewWithMultiSelectRef } from '@git-diff-view/react';
import type { Comment, FileDiff, Finding, ReviewTarget } from '../../../shared/ipc.js';
import type { ChatScope } from '../App.js';
import { FindingCard } from './FindingCard.js';
import { ChatBubble, ChatInput, StreamingBubble } from './ChatParts.js';

interface LineExtend {
  finding?: Finding;
  comments: Comment[];
}

export function DiffPane(props: {
  target: ReviewTarget;
  path: string;
  findings: Finding[];
  comments: Comment[];
  busy: boolean;
  streamScope?: ChatScope;
  streamText: string;
  onAddComment: (
    file: string,
    side: 'old' | 'new',
    startLine: number,
    endLine: number,
    quoted: string,
    text: string,
  ) => void;
  onReplyComment: (comment: Comment, text: string) => void;
  onApplyPatch: (patch: string, commentId: string) => void;
}) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffModeEnum>(DiffModeEnum.SplitGitHub);
  const [pendingRange, setPendingRange] = useState<{ side: 'old' | 'new'; start: number; end: number } | null>(null);
  const msRef = useRef<DiffViewWithMultiSelectRef>(null);

  const clearRange = () => {
    setPendingRange(null);
    msRef.current?.clearSelection();
  };

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    setPendingRange(null);
    window.margin
      .fileDiff(props.target, props.path)
      .then((d) => !cancelled && setDiff(d))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [props.target.repoPath, props.target.baseRef, props.target.headRef, props.path]);

  // Inline extends: findings anchor to the new side; comments to either side.
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
    return { oldFile, newFile };
  }, [props.findings, props.comments]);

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
        <span className="diff-path">{diff.path}</span>
        <button
          className="icon-btn"
          onClick={() => setMode(mode === DiffModeEnum.SplitGitHub ? DiffModeEnum.Unified : DiffModeEnum.SplitGitHub)}
        >
          {mode === DiffModeEnum.SplitGitHub ? 'unified' : 'split'}
        </button>
      </div>
      {pendingRange && (
        <div className="range-composer">
          <div className="composer-range">
            Comment on lines {pendingRange.start}–{pendingRange.end}
            {pendingRange.side === 'old' ? ' (old side)' : ''}
          </div>
          <ChatInput
            disabled={props.busy}
            placeholder="Comment on the selected lines — starts an AI thread…"
            autoFocus
            onCancel={clearRange}
            onSend={(text) => {
              props.onAddComment(
                props.path,
                pendingRange.side,
                pendingRange.start,
                pendingRange.end,
                quotedLines(pendingRange.side === 'old' ? SplitSide.old : SplitSide.new, pendingRange.start, pendingRange.end),
                text,
              );
              clearRange();
            }}
          />
        </div>
      )}
      <div className="diff-scroll">
        <DiffViewWithMultiSelect<LineExtend>
          ref={msRef}
          onMultiSelectComplete={(result) => {
            if (result.range.startLineNumber !== result.range.endLineNumber) {
              setPendingRange({
                side: result.range.side,
                start: result.range.startLineNumber,
                end: result.range.endLineNumber,
              });
            }
          }}
          data={{
            oldFile: { fileName: diff.path, content: diff.oldContent, fileLang: diff.lang },
            newFile: { fileName: diff.path, content: diff.newContent, fileLang: diff.lang },
            hunks: diff.hunks,
          }}
          diffViewMode={mode}
          diffViewTheme="dark"
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
                startLine={from}
                endLine={to}
                onCancel={onClose}
                onSend={(startLine, text) => {
                  props.onAddComment(
                    props.path,
                    side === SplitSide.old ? 'old' : 'new',
                    startLine,
                    to,
                    quotedLines(side, startLine, to),
                    text,
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
                {data.finding && <FindingCard finding={data.finding} inline />}
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

function CommentComposer(props: {
  busy: boolean;
  startLine: number;
  endLine: number;
  onCancel: () => void;
  onSend: (startLine: number, text: string) => void;
}) {
  const [startLine, setStartLine] = useState(props.startLine);

  return (
    <div className="comment-composer">
      <div className="composer-range">
        Lines{' '}
        <input
          type="number"
          min={1}
          max={props.endLine}
          value={startLine}
          onChange={(e) => {
            const v = Number(e.target.value);
            setStartLine(Number.isFinite(v) ? Math.max(1, Math.min(props.endLine, v)) : props.endLine);
          }}
        />{' '}
        – {props.endLine}
      </div>
      <ChatInput
        disabled={props.busy}
        placeholder="Comment on these lines — starts an AI thread…"
        autoFocus
        onCancel={props.onCancel}
        onSend={(text) => props.onSend(startLine, text)}
      />
    </div>
  );
}

function CommentThread(props: {
  comment: Comment;
  busy: boolean;
  streaming?: string;
  onReply: (text: string) => void;
  onApplyPatch: (patch: string) => void;
}) {
  const [replyOpen, setReplyOpen] = useState(false);
  const waiting =
    props.busy &&
    props.streaming === undefined &&
    props.comment.messages[props.comment.messages.length - 1]?.role === 'user';

  return (
    <div className="comment-thread">
      <div className="comment-head">
        <span className="comment-title">Comment</span>
        <span className="comment-loc">
          {props.comment.file}:
          {props.comment.startLine !== props.comment.endLine
            ? `${props.comment.startLine}–${props.comment.endLine}`
            : props.comment.endLine}
          {props.comment.side === 'old' ? ' (old)' : ''}
        </span>
      </div>
      {props.comment.messages.map((m, i) => (
        <ChatBubble key={i} msg={m} onApplyPatch={props.onApplyPatch} />
      ))}
      {props.streaming !== undefined && <StreamingBubble text={props.streaming} />}
      {waiting && <div className="busy-dot">thinking…</div>}
      <div className="thread-actions">
        <button onClick={() => setReplyOpen(!replyOpen)}>Reply</button>
      </div>
      {replyOpen && (
        <ChatInput
          disabled={props.busy}
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
