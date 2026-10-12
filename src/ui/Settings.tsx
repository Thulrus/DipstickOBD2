import { setUnits, useApp } from '../store';

export function Settings() {
  const units = useApp((s) => s.units);
  const adapter = useApp((s) => s.adapter);

  return (
    <>
      <section className="card">
        <h2>Units</h2>
        <div className="row">
          {(['imperial', 'metric'] as const).map((u) => (
            <label key={u} className="radio">
              <input type="radio" name="units" checked={units === u} onChange={() => setUnits(u)} />
              {u === 'imperial' ? 'Imperial (°F, mph, psi)' : 'Metric (°C, km/h, kPa)'}
            </label>
          ))}
        </div>
        <p className="note">Applies to the dashboard and to exports. Logs are stored in metric, so you can switch at any time.</p>
      </section>

      {adapter && (
        <section className="card">
          <h2>Adapter</h2>
          <dl>
            <dt>Reports as</dt>
            <dd>{adapter.version}</dd>
            <dt>Vehicle protocol</dt>
            <dd>{adapter.protocolName}</dd>
            <dt>Battery at connect</dt>
            <dd>{adapter.voltage === null ? 'Not reported' : `${adapter.voltage.toFixed(1)} V`}</dd>
          </dl>
        </section>
      )}

      <section className="card">
        <h2>About</h2>
        <p className="note">
          Dipstick is free, open-source software. Your logs stay in this browser on this device; nothing is uploaded anywhere. Version{' '}
          {__APP_VERSION__}.
        </p>
      </section>
    </>
  );
}
