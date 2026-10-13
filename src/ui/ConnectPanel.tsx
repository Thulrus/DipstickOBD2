import type { ReactNode } from 'react';
import { connect, useApp } from '../store';

/** The call to action shown wherever a connection is needed but missing. */
export function ConnectPanel({ title, children }: { title: string; children?: ReactNode }) {
  const status = useApp((s) => s.status);
  const step = useApp((s) => s.step);
  const pickerDismissed = useApp((s) => s.pickerDismissed);
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
      {pickerDismissed && (
        <div className="help">
          <b>Adapter not in the list?</b>
          <p>The browser only lists adapters that are already paired with this device, and on Android it needs permission to see them.</p>
          <ol>
            <li>
              On Android, open Settings → Apps → Chrome → Permissions and allow <b>Nearby devices</b>. Chrome doesn't ask for this
              itself, and without it the list is always empty.
            </li>
            <li>Check the adapter is under paired or saved devices in your Bluetooth settings. If it isn't, pair it there.</li>
            <li>Fully close any other OBD2 app, then try again. If the adapter still isn't listed, restart your phone once.</li>
          </ol>
        </div>
      )}
      {busy && (
        <p className="progress" role="status">
          {step}…
        </p>
      )}
    </section>
  );
}
