import { useEffect, useState } from 'react';
import type { RepoInfo } from '../../../shared/ipc.js';

export function InstructionsModal(props: { repo: RepoInfo; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    window.margin.getRepoInstructions(props.repo.path).then(setText);
  }, [props.repo.path]);

  if (text === null) return null;

  const save = async () => {
    await window.margin.saveRepoInstructions(props.repo.path, text);
    props.onClose();
  };

  return (
    <div className="modal-overlay" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Review instructions — {props.repo.name}</h2>
        <p className="modal-note">
          Injected into every review and comment thread in this repository, alongside any committed{' '}
          <code>.margin/margin.md</code>. Stored in the app — never written to the repo — and deleted
          when the repository is removed.
        </p>
        <textarea
          className="instructions-input"
          value={text}
          autoFocus
          placeholder={
            '- Money amounts are integer cents; flag any float arithmetic on them.\n- legacy/ is frozen — do not report findings there.'
          }
          onChange={(e) => setText(e.target.value)}
        />
        <div className="modal-actions">
          <button className="icon-btn" onClick={props.onClose}>Cancel</button>
          <button className="run-btn small" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
