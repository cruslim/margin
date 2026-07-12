import type { Finding } from '../../../shared/ipc.js';

export function FindingCard(props: { finding: Finding; inline?: boolean; onJump?: () => void }) {
  const f = props.finding;
  return (
    <div className={`finding-card sev-${f.severity} ${props.inline ? 'inline' : ''}`}>
      <div className="finding-head">
        <span className={`sev-pill sev-${f.severity}`}>{f.severity}</span>
        <span className="finding-cat">{f.category}</span>
        {props.onJump ? (
          <button className="finding-loc" onClick={props.onJump}>
            {f.file}:{f.line}
          </button>
        ) : (
          <span className="finding-loc plain">{f.file}:{f.line}</span>
        )}
      </div>
      <div className="finding-summary">{f.summary}</div>
      <div className="finding-scenario">{f.failureScenario}</div>
    </div>
  );
}
