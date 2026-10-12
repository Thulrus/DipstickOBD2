import type { ReactNode } from 'react';
import { connect, useApp } from '../store';

/** The call to action shown wherever a connection is needed but missing. */
export function ConnectPanel({ title, children }: { title: string; children?: ReactNode }) {
  const status = useApp((s) => s.status);
  const step = useApp((s) => s.step);
  const supported = 'serial' in navigator;
  const busy = status === 'connecting';

  return (
    <section className="connect">
      <h2>{title}</h2>
      {children}
      {!supported && (
        <p className="note">
          This browser can't talk to OBD2 adapters. Use Chrome on Android, or Chrome or Edge on a computer. You can still try the demo
          here.
        </p>
      )}
      <div className="row">
        <button className="primary" disabled={busy || !supported} onClick={() => void connect('serial')}>
          Connect adapter
        </button>
        <button disabled={busy} onClick={() => void connect('demo')}>
          Try the demo
        </button>
      </div>
      {busy && (
        <p className="progress" role="status">
          {step}…
        </p>
      )}
    </section>
  );
}
