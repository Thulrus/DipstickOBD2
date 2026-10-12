import { useRef } from 'react';
import { dtcArea } from '../obd/dtc';
import { clearCodes, refreshCodes, useApp } from '../store';
import { ConnectPanel } from './ConnectPanel';

export function Codes() {
  const status = useApp((s) => s.status);
  const codes = useApp((s) => s.codes);
  const busy = useApp((s) => s.codesBusy);
  const confirm = useRef<HTMLDialogElement>(null);

  if (status !== 'connected') {
    return (
      <ConnectPanel title="Trouble codes">
        <p className="note">Connect to read the codes behind a check-engine light, and to see whether the vehicle is ready for an emissions test.</p>
      </ConnectPanel>
    );
  }

  const monitors = codes?.status?.monitors ?? [];
  const incomplete = monitors.filter((m) => !m.complete);

  return (
    <>
      <div className="toolbar">
        <p className="meta">
          Check-engine light: <b>{codes?.status ? (codes.status.mil ? 'On' : 'Off') : 'Unknown'}</b>
          <br />
          {codes ? `Read at ${new Date(codes.readAt).toLocaleTimeString()}` : 'Not read yet'}
        </p>
        <button disabled={busy} onClick={() => void refreshCodes()}>
          {busy ? 'Reading…' : 'Read again'}
        </button>
      </div>

      <CodeList title="Stored codes" hint="Confirmed faults. These turn the check-engine light on." codes={codes?.stored ?? []} />
      <CodeList title="Pending codes" hint="Seen recently but not confirmed yet. Often an early warning." codes={codes?.pending ?? []} />

      {monitors.length > 0 && (
        <section className="card">
          <h2>Readiness monitors</h2>
          <p className="note">
            {incomplete.length === 0
              ? 'All self-tests have completed.'
              : `${incomplete.length} of ${monitors.length} self-tests haven't completed since codes were last cleared.`}
          </p>
          <ul className="monitors">
            {monitors.map((m) => (
              <li key={m.name}>
                <span>{m.name}</span>
                <span className={m.complete ? 'ok' : 'wait'}>{m.complete ? '✓ Complete' : '… Not complete'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>Clear codes</h2>
        <p className="note">
          Turns the check-engine light off and erases stored codes. It doesn't fix anything: if the fault is still there, the code comes
          back.
        </p>
        <button className="danger" disabled={busy} onClick={() => confirm.current?.showModal()}>
          Clear codes…
        </button>
      </section>

      <dialog ref={confirm} className="confirm">
        <form method="dialog">
          <h2>Clear all trouble codes?</h2>
          <p>
            This also erases freeze-frame data and resets every readiness monitor, so the vehicle can't pass an emissions test until
            you've driven it enough for the self-tests to run again. It can't be undone.
          </p>
          <div className="row">
            <button>Cancel</button>
            <button className="danger" onClick={() => void clearCodes()}>
              Clear codes
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

function CodeList({ title, hint, codes }: { title: string; hint: string; codes: string[] }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      <p className="note">{hint}</p>
      {codes.length === 0 ? (
        <p className="empty">None</p>
      ) : (
        <ul className="codes">
          {codes.map((code) => (
            <li key={code}>
              <b>{code}</b>
              <span>{dtcArea(code)}</span>
              <a href={`https://www.google.com/search?q=${encodeURIComponent(code + ' code')}`} target="_blank" rel="noreferrer">
                Look up
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
