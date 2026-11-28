import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import './index.css';

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const vv = window.visualViewport;
  const h = Math.max(240, Math.round(vv ? vv.height : window.innerHeight));
  const top = Math.max(0, Math.round(vv ? vv.offsetTop : 0));
  document.documentElement.style.setProperty('--app-height', `${h}px`);
  document.documentElement.style.setProperty('--app-top', `${top}px`);
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
