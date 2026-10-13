import { useRef, useState } from 'react';
import { toReport } from '../log/export';
import { dtcArea } from '../obd/dtc';
import type { ModuleScan } from '../obd/modules';
import { SIGNALS } from '../obd/signals';
import { displayUnit, formatValue } from '../obd/units';
import { clearCodes, refreshCodes, scanAllModules, stopModuleScan, useApp } from '../store';
import { download } from './download';
import { ConnectPanel } from './ConnectPanel';

export function Codes() {
  const status = useApp((s) => s.status);
  const codes = useApp((s) => s.codes);
  const busy = useApp((s) => s.codesBusy);
  const scan = useApp((s) => s.scan);
  const scanStep = useApp((s) => s.scanStep);
  const modules = useApp((s) => s.modules);
  const modulesStep = useApp((s) => s.modulesStep);
  const units = useApp((s) => s.units);
  const adapter = useApp((s) => s.adapter);
  const vin = useApp((s) => s.vin);
  const demo = useApp((s) => s.demo);
  const confirm = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);

  if (status !== 'connected') {
    return (
      <ConnectPanel title="Trouble codes">
        <p className="note">Connect to read the codes behind a check-engine light, and to see whether the vehicle is ready for an emissions test.</p>
      </ConnectPanel>
    );
  }

  const monitors = codes?.status?.monitors ?? [];
  const incomplete = monitors.filter((m) => !m.complete);
  const frame = scan?.freezeFrame;
  const frameRows = frame ? SIGNALS.filter((s) => frame.values[s.id] !== undefined) : [];
  const tests = scan?.monitorTests ?? [];
  const failed = tests.filter((t) => !t.passed);
  const working = busy || scanStep !== '' || modulesStep !== '';

  function report(): string {
    const vehicle = { vin, adapter: adapter?.version ?? '', protocol: adapter?.protocol ?? '', protocolName: adapter?.protocolName ?? '' };
    const head = `# OBD2 diagnostic report\n\n${demo ? '**Demo data from a simulated vehicle, not a real one.**\n\n' : ''}`;
    return head + toReport(vehicle, codes, scan, units, modules);
  }

  async function copyReport() {
    await navigator.clipboard.writeText(report());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function downloadReport() {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    download(`dipstick_${stamp}_report.md`, report(), 'text/markdown');
  }

  return (
    <>
      <div className="toolbar">
        <p className="meta">
          Check-engine light: <b>{codes?.status ? (codes.status.mil ? 'On' : 'Off') : 'Unknown'}</b>
          <br />
          {codes ? `Read at ${new Date(codes.readAt).toLocaleTimeString()}` : 'Not read yet'}
        </p>
        <button disabled={working} onClick={() => void refreshCodes()}>
          {working ? 'Reading…' : 'Read again'}
        </button>
      </div>

      <section className="card">
        <h2>Export</h2>
        <p className="note" role="status">
          {scanStep
            ? `${scanStep}… You can export now, but the report will be more complete in a moment.`
            : 'Everything on this page as one report, ready to paste into a chat with an AI assistant. It is also saved with this session in History.'}
        </p>
        <div className="row">
          <button className="primary" onClick={() => void copyReport()}>
            {copied ? 'Copied ✓' : 'Copy report for AI'}
          </button>
          <button onClick={downloadReport}>Report file</button>
        </div>
      </section>

      <CodeList title="Stored codes" hint="Confirmed faults. These turn the check-engine light on." codes={codes?.stored ?? []} />
      <CodeList title="Pending codes" hint="Seen recently but not confirmed yet. Often an early warning." codes={codes?.pending ?? []} />
      {(codes?.permanent?.length ?? 0) > 0 && (
        <CodeList
          title="Permanent codes"
          hint="These can't be cleared with a scanner. The vehicle removes them itself once it has confirmed the fault is gone."
          codes={codes?.permanent ?? []}
        />
      )}

      <section className="card">
        <h2>Other modules</h2>
        <p className="note">
          Airbag, ABS, body, transmission and any other computer that will answer. This reads their stored codes exactly as they are sent,
          without decoding them: copy the report into an AI assistant or search the codes yourself. It only reads, and never clears or
          changes anything. On newer (CAN) vehicles it can take about a minute; older vehicles only expose their emissions computers, so
          it is quick. Live logging pauses while it runs.
        </p>
        {modulesStep ? (
          <div className="row">
            <button onClick={stopModuleScan}>Stop</button>
            <span className="note" role="status">
              {modulesStep}
            </span>
          </div>
        ) : (
          <button disabled={working} onClick={() => void scanAllModules()}>
            {modules ? 'Scan again' : 'Scan all modules'}
          </button>
        )}
        {modules && <ModuleResults scan={modules} />}
      </section>

      {frame && (
        <section className="card">
          <h2>Freeze frame</h2>
          <p className="note">What the engine was doing at the moment {frame.dtc} was recorded.</p>
          <div className="scroll">
            <table>
              <tbody>
                {frameRows.map((s) => (
                  <tr key={s.id}>
                    <th>{s.name}</th>
                    <td>
                      {formatValue(s, frame.values[s.id]!, units)} <span className="unit">{displayUnit(s, units)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {scan && scan.fuelSystem.length > 0 && (
        <section className="card">
          <h2>Fuel system</h2>
          <ul className="monitors">
            {scan.fuelSystem.map((state, i) => (
              <li key={i}>
                <span>{state}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

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

      {tests.length > 0 && (
        <section className="card">
          <h2>Self-test results</h2>
          <p className="note">
            The vehicle's own component tests, with the limits it checks against.{' '}
            {failed.length === 0 ? `All ${tests.length} are within limits.` : `${failed.length} of ${tests.length} are outside limits.`} Values
            are raw numbers from the engine computer.
          </p>
          <details open={failed.length > 0}>
            <summary>Show {tests.length} results</summary>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Test</th>
                    <th>Value</th>
                    <th>Limits</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {[...failed, ...tests.filter((t) => t.passed)].map((t, i) => (
                    <tr key={i}>
                      <th>
                        {t.monitor}
                        <span className="unit"> {t.test}</span>
                      </th>
                      <td>{t.value}</td>
                      <td>{t.min !== null && t.max !== null ? `${t.min} to ${t.max}` : t.min !== null ? `≥ ${t.min}` : `≤ ${t.max}`}</td>
                      <td className={t.passed ? 'ok' : 'fail'}>{t.passed ? '✓ Pass' : '✕ Fail'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
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

function ModuleResults({ scan }: { scan: ModuleScan }) {
  const noun = scan.method === 'emissions-only' ? 'computer' : 'module';
  return (
    <>
      <p className="note">
        {scan.modules.length === 0 ? `No ${noun}s answered.` : `${scan.modules.length} ${noun}${scan.modules.length === 1 ? '' : 's'} answered`}
        {scan.complete ? '' : ' (scan stopped early)'}. {scan.note}
      </p>
      {scan.modules.map((m) => (
        <div key={m.responseId}>
          <h3>
            {noun === 'computer' ? 'Computer' : 'Module'} {m.responseId} <span className="unit">{m.protocol}</span>
          </h3>
          {m.info && m.info.length > 0 && (
            <ul className="monitors">
              {m.info.map((line, i) => (
                <li key={i}>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          )}
          {m.note ? (
            <p className="empty">{m.note}</p>
          ) : m.codes.length === 0 ? (
            <p className="empty">No codes stored</p>
          ) : (
            <ul className="codes">
              {m.codes.map((c) => (
                <li key={`${c.raw}-${c.flags.join()}`}>
                  <b>{c.code}</b>
                  <span>
                    raw {c.raw}
                    {c.status && `, status ${c.status}`}
                    {c.flags.length > 0 && ` (${c.flags.join(', ')})`}
                  </span>
                  <a href={`https://www.google.com/search?q=${encodeURIComponent(c.code.split('-')[0] + ' code')}`} target="_blank" rel="noreferrer">
                    Look up
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </>
  );
}
