import ReactDOM from 'react-dom/client';
import { App } from './App.tsx';
import '../styles.css';
import './workspace.css';

const rootEl = document.getElementById('root');
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(<App />);
}
