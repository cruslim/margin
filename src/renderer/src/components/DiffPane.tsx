import { useEffect, useMemo, useState } from 'react';
import { DiffView, DiffModeEnum, SplitSide } from '@git-diff-view/react';
import type { Comment, FileDiff, Finding, ReviewTarget } from '../../../shared/ipc.js';
import { FindingCard } from './FindingCard.js';
import { ChatBubble, ChatInput } from './ChatParts.js';

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
  onAddComment: (file: string, side: 'old' | 'new', line: number, quoted: string, text: string) => void;
  onReplyComment: (comment: Comment, text: string) => void;
  onApplyPatch: (patch: string, commentId: string) => void;
}) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffModeEnum>(DiffModeEnum.Split);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
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

  const quotedLine = (side: SplitSide, line: number): string => {
    const content = side === SplitSide.old ? diff?.oldContent : diff?.newContent;
    return content?.split('\n')[line - 1] ?? '';
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
          onClick={() => setMode(mode === DiffModeEnum.Split ? DiffModeEnum.Unified : DiffModeEnum.Split)}
        >
          {mode === DiffModeEnum.Split ? 'unified' : 'split'}
        </button>
      </div>
      <div className="diff-scroll">
        <DiffView<LineExtend>
          data={{
            oldFile: { fileName: diff.path, content: diff.oldContent, fileLang: diff.lang },
            newFile: { fileName: diff.path, content: diff.newContent, fileLang: diff.lang },
            hunks: diff.hunks,
          }}
          diffViewMode={mode}
          diffViewTheme="dark"
          diffViewHighlight
          diffViewWrap={false}
          diffViewFontSize={12.5}
          diffViewAddWidget
          renderWidgetLine={({ side, lineNumber, onClose }) => (
            <div className="comment-composer">
              <ChatInput
                disabled={props.busy}
                placeholder="Comment on this line — starts an AI thread…"
                autoFocus
                onCancel={onClose}
                onSend={(text) => {
                  props.onAddComment(
                    props.path,
                    side === SplitSide.old ? 'old' : 'new',
                    lineNumber,
                    quotedLine(side, lineNumber),
                    text,
                  );
                  onClose();
                }}
              />
            </div>
          )}
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

function CommentThread(props: {
  comment: Comment;
  busy: boolean;
  onReply: (text: string) => void;
  onApplyPatch: (patch: string) => void;
}) {
  const [replyOpen, setReplyOpen] = useState(false);
  const waiting = props.busy && props.comment.messages[props.comment.messages.length - 1]?.role === 'user';

  return (
    <div className="comment-thread">
      <div className="comment-head">
        <span className="comment-title">Comment</span>
        <span className="comment-loc">
          {props.comment.file}:{props.comment.endLine}
          {props.comment.side === 'old' ? ' (old)' : ''}
        </span>
      </div>
      {props.comment.messages.map((m, i) => (
        <ChatBubble key={i} msg={m} onApplyPatch={props.onApplyPatch} />
      ))}
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
