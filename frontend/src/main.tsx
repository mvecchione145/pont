import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initAuth } from './auth';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

try {
  await initAuth();
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  root.render(
    <main>
      <h1>pont</h1>
      <p className="down">Could not sign in: {message}</p>
    </main>,
  );
}
