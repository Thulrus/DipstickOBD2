import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import 'uplot/dist/uPlot.min.css';
import './styles.css';
import { App } from './ui/App';

// Caches the app so it works with no signal, e.g. in a garage or on the road.
registerSW({ immediate: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
