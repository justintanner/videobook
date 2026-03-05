import './App.css'
import { McpStatus } from './components/McpStatus'
import { FileUpload } from './components/FileUpload'
import { useMcpConnection } from './hooks/useMcpConnection'

function App() {
  const { state, tools, error, retry, callTool } = useMcpConnection()

  return (
    <div style={{ textAlign: "left", maxWidth: 520, margin: "2rem auto" }}>
      <McpStatus state={state} tools={tools} error={error} retry={retry} />
      {state === "ready" && <FileUpload callTool={callTool} />}
    </div>
  )
}

export default App
