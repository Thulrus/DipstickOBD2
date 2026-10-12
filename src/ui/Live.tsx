import { useRef } from 'react';
import { SIGNAL_BY_ID, type Signal } from '../obd/signals';
import { displayUnit, formatValue } from '../obd/units';
import { toggleSignal, useApp, type LiveValue } from '../store';
import { ConnectPanel } from './ConnectPanel';

export function Live() {
  const status = useApp((s) => s.status);
  const available = useApp((s) => s.available);
  const selected = useApp((s) => s.selected);
  const adapter = useApp((s) => s.adapter);
  const vin = useApp((s) => s.vin);
  const rate = useApp((s) => s.samplesPerSecond);
  const picker = useRef<HTMLDialogElement>(null);

  if (status !== 'connected') {
    return (
      <ConnectPanel title="Connect to your vehicle">
        <ol className="steps">
          <li>Plug the adapter into the OBD2 port (under the dash, near the steering column) and turn the ignition on.</li>
          <li>
            Pair the adapter in your device's Bluetooth settings. The PIN is usually <b>1234</b> or <b>0000</b>.
          </li>
          <li>Tap Connect adapter and choose it from the list.</li>
        </ol>
      </ConnectPanel>
    );
  }

  const availableIds = new Set(available.map((s) => s.id));
  const shown = selected.flatMap((id) => (availableIds.has(id) ? [SIGNAL_BY_ID.get(id)!] : []));

  return (
    <>
      <div className="toolbar">
        <p className="meta">
          <span className="rec" aria-hidden="true" /> Recording · {rate.toFixed(1)} readings/s
          <br />
          {vin ?? 'VIN not reported'} · {adapter?.protocolName}
        </p>
        <button onClick={() => picker.current?.showModal()}>Signals</button>
      </div>

      {shown.length === 0 ? (
        <p className="empty">No signals selected. Tap Signals to choose what to watch and log.</p>
      ) : (
        <div className="tiles">
          {shown.map((s) => (
            <Tile key={s.id} signal={s} />
          ))}
        </div>
      )}

      <dialog ref={picker} className="picker" onClick={(e) => e.target === picker.current && picker.current.close()}>
        <form method="dialog">
          <header>
            <h2>Signals</h2>
            <button className="primary">Done</button>
          </header>
          <p className="note">
            Your vehicle reports {available.length} signals. The ones you pick are shown and logged. The adapter reads one at a time, so
            fewer signals means faster updates for each.
          </p>
          <ul>
            {available.map((s) => (
              <li key={s.id}>
                <label>
                  <input type="checkbox" checked={selected.includes(s.id)} onChange={() => toggleSignal(s.id)} />
                  {s.name}
                </label>
              </li>
            ))}
          </ul>
        </form>
      </dialog>
    </>
  );
}

function Tile({ signal }: { signal: Signal }) {
  const value = useApp((s) => s.live[signal.id]);
  const units = useApp((s) => s.units);
  const unit = displayUnit(signal, units);
  return (
    <article className="tile">
      <h3>{signal.name}</h3>
      <p className="value">
        {value ? formatValue(signal, value.v, units) : '–'}
        {unit && <span className="unit"> {unit}</span>}
      </p>
      <Sparkline value={value} />
      <p className="range">
        {value ? `${formatValue(signal, value.min, units)} to ${formatValue(signal, value.max, units)}` : 'Waiting for data'}
      </p>
    </article>
  );
}

/** Recent trend only: no axes, scaled to its own range. The number above is the reading. */
function Sparkline({ value }: { value: LiveValue | undefined }) {
  const trail = value?.trail ?? [];
  if (trail.length < 2) return <svg className="spark" viewBox="0 0 100 24" aria-hidden="true" />;
  const lo = Math.min(...trail);
  const span = Math.max(...trail) - lo || 1;
  const points = trail.map((v, i) => `${((i / (trail.length - 1)) * 100).toFixed(1)},${(22 - ((v - lo) / span) * 20).toFixed(1)}`).join(' ');
  return (
    <svg className="spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}
