import { useRef, useState } from 'react';
import { PROFILES } from '../obd/profiles';
import { SIGNAL_BY_ID, type Signal } from '../obd/signals';
import { displayUnit, formatValue } from '../obd/units';
import { addMarker, selectSignals, togglePin, toggleSignal, useApp, type LiveValue } from '../store';
import { ConnectPanel } from './ConnectPanel';

export function Live() {
  const status = useApp((s) => s.status);
  const available = useApp((s) => s.available);
  const selected = useApp((s) => s.selected);
  const adapter = useApp((s) => s.adapter);
  const vin = useApp((s) => s.vin);
  const rate = useApp((s) => s.samplesPerSecond);
  const pinned = useApp((s) => s.pinned);
  const screenAwake = useApp((s) => s.screenAwake);
  const markers = useApp((s) => s.markers);
  const picker = useRef<HTMLDialogElement>(null);
  const marker = useRef<HTMLDialogElement>(null);
  const [markerText, setMarkerText] = useState('');

  function mark(label: string) {
    addMarker(label);
    setMarkerText('');
    marker.current?.close();
  }

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
  // Pinned tiles keep the order they were pinned in.
  const big = pinned.flatMap((id) => shown.filter((s) => s.id === id));
  const rest = shown.filter((s) => !pinned.includes(s.id));
  // Slow signals take only an occasional turn, so the fast ones set the pace.
  const fastCount = shown.filter((s) => s.rate === 'fast').length;
  const cycle = rate > 0 && fastCount > 0 ? fastCount / rate : null;

  return (
    <>
      <div className="toolbar">
        <p className="meta">
          <span className="rec" aria-hidden="true" /> Recording · {rate.toFixed(1)} readings/s
          <br />
          {vin ?? 'VIN not reported'} · {adapter?.protocolName}
          <br />
          {screenAwake ? 'Screen will stay on' : 'Screen may turn off'}
          {markers.length > 0 && ` · ${markers.length} marker${markers.length === 1 ? '' : 's'}`}
        </p>
        <div className="stack">
          <button onClick={() => picker.current?.showModal()}>Signals</button>
          <button onClick={() => marker.current?.showModal()}>Mark</button>
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="empty">No signals selected. Tap Signals to choose what to watch and log.</p>
      ) : (
        <>
          {big.length > 0 && (
            <div className="tiles big">
              {big.map((s) => (
                <Tile key={s.id} signal={s} pinned />
              ))}
            </div>
          )}
          <div className="tiles">
            {rest.map((s) => (
              <Tile key={s.id} signal={s} />
            ))}
          </div>
        </>
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
            {cycle !== null && ` With this selection, fast-changing signals update about every ${cycle.toFixed(1)} s.`}
          </p>
          <div className="row">
            {PROFILES.map((p) => (
              <button key={p.name} type="button" title={p.hint} onClick={() => selectSignals(p.pick(available))}>
                {p.name}
              </button>
            ))}
          </div>
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

      <dialog ref={marker} className="picker" onClick={(e) => e.target === marker.current && marker.current.close()}>
        <form
          method="dialog"
          onSubmit={(e) => {
            if (markerText.trim()) {
              e.preventDefault();
              mark(markerText);
            }
          }}
        >
          <header>
            <h2>Add a marker</h2>
            <button type="button" className="quiet" onClick={() => marker.current?.close()}>
              Cancel
            </button>
          </header>
          <p className="note">Stamps the log at this moment with something the vehicle can't report, so the data can be read in context.</p>
          <div className="row">
            {QUICK_MARKERS.map((label) => (
              <button key={label} type="button" onClick={() => mark(label)}>
                {label}
              </button>
            ))}
          </div>
          <label className="field">
            Or type your own
            <input type="text" value={markerText} onChange={(e) => setMarkerText(e.target.value)} placeholder="e.g. hesitation going uphill" />
          </label>
          <button className="primary" disabled={!markerText.trim()}>
            Add marker
          </button>
        </form>
      </dialog>
    </>
  );
}

const QUICK_MARKERS = ['In Park, idling', 'In Drive, stopped', 'Holding 2,500 rpm', 'Cruising', 'A/C on', 'A/C off', 'Problem happening now'];

function Tile({ signal, pinned = false }: { signal: Signal; pinned?: boolean }) {
  const value = useApp((s) => s.live[signal.id]);
  const units = useApp((s) => s.units);
  const unit = displayUnit(signal, units);
  return (
    <article className="tile">
      <button
        className="pin"
        aria-pressed={pinned}
        aria-label={pinned ? `Unpin ${signal.name}` : `Pin ${signal.name} to the top`}
        onClick={() => togglePin(signal.id)}
      >
        {pinned ? '★' : '☆'}
      </button>
      <h3>{signal.name}</h3>
      {signal.states ? (
        <p className="value state">{value ? (signal.states[value.v] ?? `State ${value.v}`) : '–'}</p>
      ) : (
        <p className="value">
          {value ? formatValue(signal, value.v, units) : '–'}
          {unit && <span className="unit"> {unit}</span>}
        </p>
      )}
      <Sparkline value={value} />
      <p className="range">
        {!value ? 'Waiting for data' : signal.states ? `Code ${value.v}` : `${formatValue(signal, value.min, units)} to ${formatValue(signal, value.max, units)}`}
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
