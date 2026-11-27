import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import './index.css';

const syncInitialViewportMetrics = () => {
  try {
    const vv = window.visualViewport;
    const h = vv ? Math.round(vv.height) : window.innerHeight;
    const top = vv ? Math.max(0, Math.round(vv.offsetTop)) : 0;
    if (h > 0) {
      document.documentElement.style.setProperty('--app-height', `${h}px`);
    }
    document.documentElement.style.setProperty('--app-offset-top', `${top}px`);
  } catch (_e) {}
};
syncInitialViewportMetrics();

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
