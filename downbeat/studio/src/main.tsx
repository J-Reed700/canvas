import '../styles.css';
import ReactDOM from 'react-dom/client';
import { StrictMode } from 'react';
import { App } from './components/App/App.tsx';
import { StudioProvider } from './state/StudioContext.tsx';
import { studioRuntime } from './state/store.ts';
import { workspaceStore } from './state/workspaceStore.ts';

const rootEl = document.getElementById('root');
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <StrictMode>
      <StudioProvider runtime={studioRuntime} workspace={workspaceStore}>
        <App />
      </StudioProvider>
    </StrictMode>,
  );
}
