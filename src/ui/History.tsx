import { useEffect, useMemo, useState } from 'react';
import { deleteSession, listSessions, loadSamples, putSession } from '../log/db';
import { computeStats, exportFileName, formatDuration, sessionTitle, toJson, toLongCsv, toSummary, toWideCsv } from '../log/export';
import { toSeries, type SampleColumns, type Session } from '../log/types';
import { SIGNAL_BY_ID } from '../obd/signals';
import { useApp } from '../store';
import { SeriesChart } from './Chart';
import { download } from './download';

export function History() {
  const status = useApp((s) => s.status);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = () => void listSessions().then(setSessions);
  // Reload when a recording starts or stops, and when returning from a session.
  useEffect(refresh, [status, openId]);

  const open = sessions?.find((s) => s.id === openId);
  if (open) return <SessionDetail session={open} onBack={() => setOpenId(null)} />;
  if (!sessions) return null;
  if (sessions.length === 0) {
    return <p className="empty">No sessions yet. Every time you connect, the drive is logged here automatically.</p>;
  }

  return (
    <ul className="sessions">
      {sessions.map((s) => (
        <li key={s.id}>
          <button onClick={() => setOpenId(s.id)}>
            <b>{sessionTitle(s)}</b>
            <span>
              {formatDuration(s.endedAt - s.startedAt)} · {s.sampleCount.toLocaleString()} readings
              {s.codes?.stored.length ? ` · ${s.codes.stored.join(', ')}` : ''}
            </span>
            <span>
              {s.demo && <i className="tag">Demo</i>}
              {s.note}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function SessionDetail({ session, onBack }: { session: Session; onBack: () => void }) {
  const units = useApp((s) => s.units);
  const recording = useApp((s) => s.sessionId === session.id);
  const [samples, setSamples] = useState<SampleColumns | null>(null);
  const [note, setNote] = useState(session.note);
  const [odometer, setOdometer] = useState(session.odometer ?? '');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void loadSamples(session.id).then(setSamples);
  }, [session.id]);

  const series = useMemo(() => (samples ? toSeries(session, samples) : []), [session, samples]);
  const stats = useMemo(() => (samples ? computeStats(session, samples, units) : []), [session, samples, units]);
  const durationMs = session.endedAt - session.startedAt;
  const current = { ...session, note, odometer };

  async function copySummary() {
    if (!samples) return;
    await navigator.clipboard.writeText(toSummary(current, samples, units));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function remove() {
    if (!window.confirm('Delete this session? This cannot be undone.')) return;
    await deleteSession(session.id);
    onBack();
  }

  return (
    <>
      <div className="toolbar">
        <button className="quiet" onClick={onBack}>
          ‹ Sessions
        </button>
        {!recording && (
          <button className="quiet danger" onClick={() => void remove()}>
            Delete
          </button>
        )}
      </div>

      <section className="card">
        <h2>
          {sessionTitle(session)}
          {session.demo && <i className="tag">Demo</i>}
        </h2>
        <p className="note">
          {formatDuration(durationMs)} · {session.sampleCount.toLocaleString()} readings · {session.vehicle.vin ?? 'VIN not reported'}
          <br />
          {session.vehicle.protocolName} · {session.vehicle.adapter}
          {session.codes && (
            <>
              <br />
              Stored codes: {session.codes.stored.join(', ') || 'none'} · Pending: {session.codes.pending.join(', ') || 'none'}
            </>
          )}
        </p>
        {recording ? (
          <p className="note">Still recording. Showing what had been saved when you opened this page.</p>
        ) : (
          <label className="field">
            Odometer
            <input type="text" inputMode="numeric" value={odometer} placeholder="e.g. 113,204 mi" onChange={(e) => setOdometer(e.target.value)} onBlur={() => void putSession(current)} />
          </label>
        )}
        {!recording && (
          <label className="field">
            Note
            <textarea
              rows={2}
              value={note}
              placeholder="What were you testing? Symptoms, weather, anything worth remembering."
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => void putSession(current)}
            />
          </label>
        )}
      </section>

      {(session.markers?.length ?? 0) > 0 && (
        <section className="card">
          <h2>Markers</h2>
          <ul className="monitors">
            {session.markers!.map((m, i) => (
              <li key={i}>
                <span>{m.label}</span>
                <span>{formatDuration(m.t)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>Export</h2>
        <p className="note">
          The summary has the vehicle, trouble codes, freeze frame, self-test results and statistics for the logged signals, and is short
          enough to paste into a chat with an AI assistant. Attach a CSV when it needs the readings over time. The JSON file has
          everything in one place.
        </p>
        <div className="row">
          <button className="primary" disabled={!samples} onClick={() => void copySummary()}>
            {copied ? 'Copied ✓' : 'Copy summary for AI'}
          </button>
          <button disabled={!samples} onClick={() => samples && download(exportFileName(session, 'summary', 'md'), toSummary(current, samples, units), 'text/markdown')}>
            Summary file
          </button>
          <button disabled={!samples} onClick={() => samples && download(exportFileName(session, 'per-second', 'csv'), toWideCsv(current, samples, units), 'text/csv')}>
            CSV (per second)
          </button>
          <button disabled={!samples} onClick={() => samples && download(exportFileName(session, 'raw', 'csv'), toLongCsv(current, samples, units), 'text/csv')}>
            CSV (every reading)
          </button>
          <button disabled={!samples} onClick={() => samples && download(exportFileName(session, 'full', 'json'), toJson(current, samples, units), 'application/json')}>
            JSON
          </button>
        </div>
      </section>

      {stats.length > 0 && (
        <section className="card">
          <h2>Summary</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Signal</th>
                  <th>Min</th>
                  <th>Mean</th>
                  <th>Max</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => {
                  const f = (x: number) => x.toFixed(Math.max(s.signal.decimals, 1));
                  return (
                    <tr key={s.signal.id}>
                      <th>
                        {s.signal.name}
                        {s.unit && <span className="unit"> {s.unit}</span>}
                      </th>
                      <td>{f(s.min)}</td>
                      <td>{f(s.mean)}</td>
                      <td>{f(s.max)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {series.map((s) => {
        const signal = SIGNAL_BY_ID.get(s.signalId);
        return signal && s.t.length > 1 ? <SeriesChart key={s.signalId} signal={signal} t={s.t} v={s.v} units={units} durationMs={durationMs} /> : null;
      })}
      {samples && series.length === 0 && <p className="empty">This session has no readings.</p>}
    </>
  );
}
