import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import './index.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  // reducedMotion="user" → Framer honors the OS "reduce motion" setting:
  // transform/layout animations become instant, opacity still fades.
  <MotionConfig reducedMotion="user">
    <App />
  </MotionConfig>,
);
