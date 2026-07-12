import { useEffect, useMemo, useState } from 'react';
import { DiffView, DiffModeEnum } from '@git-diff-view/react';
import type { FileDiff, Finding, ReviewTarget } from '../../../shared/ipc.js';
import { FindingCard } from './FindingCard.js';

export function DiffPane(props: { target: ReviewTarget; path: string; findings: Finding[] }) {
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

  // Inline finding cards anchored to lines in the new file version.
  const extendData = useMemo(() => {
    const newFile: Record<number, { data: Finding }> = {};
    for (const f of props.findings) newFile[f.line] = { data: f };
    return { newFile };
  }, [props.findings]);

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
        <DiffView<Finding>
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
          extendData={extendData}
          renderExtendLine={({ data }) => (data ? <FindingCard finding={data} inline /> : null)}
        />
      </div>
    </div>
  );
}
