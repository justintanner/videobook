import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './index.css'
import App from './App.tsx'
import { loadInitialWorkspace } from './videobook/initial-workspace'

const initialWorkspace = await loadInitialWorkspace().catch(() => null)

createRoot(document.getElementById('root')!).render(
  <App initialWorkspace={initialWorkspace} />,
)
