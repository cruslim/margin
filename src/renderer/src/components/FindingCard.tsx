import type { Finding } from '../../../shared/ipc.js';
import { CopyButton } from './ChatParts.js';

/**
 * The finding's text alone — no severity/location header, so it pastes clean
 * into a PR comment or an agent prompt. CodeRabbit findings repeat the summary
 * as the scenario's opening sentence, so a summary the scenario already starts
 * with is not written twice.
 */
function findingClipboardText(f: Finding): string {
  return f.failureScenario.startsWith(f.summary.trimEnd())
    ? f.failureScenario
    : `${f.summary}\n\n${f.failureScenario}`;
}

export function FindingCard(props: {
  finding: Finding;
  inline?: boolean;
  onJump?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const f = props.finding;
  const collapsible = !!props.onToggleCollapse;

  const head = (
    <div
      className={`finding-head ${collapsible ? 'toggleable' : ''}`}
      onClick={props.onToggleCollapse}
      title={collapsible ? (props.collapsed ? 'Expand' : 'Collapse') : undefined}
    >
      {collapsible && <span className="chevron">{props.collapsed ? '▸' : '▾'}</span>}
      <span className={`sev-pill sev-${f.severity}`}>{f.severity}</span>
      <span className="finding-cat">{f.category}</span>
      {f.source && <span className="source-chip" title={`Found by ${f.source}`}>{f.source}</span>}
      {f.verdict === 'confirmed' && (
        <span className="verdict-chip confirmed" title={f.verdictReason || 'Verified against the code'}>✓ verified</span>
      )}
      {f.verdict === 'uncertain' && (
        <span className="verdict-chip uncertain" title={f.verdictReason || 'Verifier could not determine'}>? unverified</span>
      )}
      {props.collapsed && <span className="finding-preview">{f.summary}</span>}
      {props.onJump ? (
        <button
          className="finding-loc"
          onClick={(e) => {
            e.stopPropagation();
            props.onJump?.();
          }}
        >
          {f.file}:{f.line}
        </button>
      ) : (
        <span className="finding-loc plain">{f.file}:{f.line}</span>
      )}
    </div>
  );

  if (props.collapsed) {
    return <div className={`finding-card collapsed sev-${f.severity} ${props.inline ? 'inline' : ''}`}>{head}</div>;
  }

  return (
    <div className={`finding-card sev-${f.severity} ${props.inline ? 'inline' : ''}`}>
      {head}
      <div className="finding-summary">
        {/* Anchored here, not on the card, so it tracks the summary's first line
            even when the head row above wraps. */}
        <CopyButton text={findingClipboardText(f)} title="Copy finding" />
        {f.summary}
      </div>
      <div className="finding-scenario">{f.failureScenario}</div>
    </div>
  );
}
