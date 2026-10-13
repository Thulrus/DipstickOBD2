import { disconnect, dismissError, setTab, useApp, type Tab } from '../store';
import { Codes } from './Codes';
import { History } from './History';
import { Live } from './Live';
import { Settings } from './Settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'codes', label: 'Codes' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
];

export function App() {
  const tab = useApp((s) => s.tab);
  const status = useApp((s) => s.status);
  const demo = useApp((s) => s.demo);
  const disconnecting = useApp((s) => s.disconnecting);
  const error = useApp((s) => s.error);
  const stored = useApp((s) => s.codes?.stored.length ?? 0);

  return (
    <div className="app">
      <header className="topbar">
        <h1>Dipstick</h1>
        {status === 'connected' && (
          <>
            <span className="chip">
              <span className="dot" aria-hidden="true" />
              {demo ? 'Demo vehicle' : 'Connected'}
            </span>
            <button className="quiet" disabled={disconnecting} onClick={() => void disconnect()}>
              {disconnecting ? 'Saving…' : 'Disconnect'}
            </button>
          </>
        )}
      </header>

      {error && (
        <div className="banner" role="alert">
          <span>{error}</span>
          <button className="quiet" onClick={dismissError} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      <main>
        {tab === 'live' && <Live />}
        {tab === 'codes' && <Codes />}
        {tab === 'history' && <History />}
        {tab === 'settings' && <Settings />}
      </main>

      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'codes' && stored > 0 && <span className="badge">{stored}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}
