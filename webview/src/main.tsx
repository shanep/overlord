import { createRoot } from 'react-dom/client';

const root = document.querySelector('#root');
if (root !== null) {
  createRoot(root).render(<p>Overlord</p>);
}
