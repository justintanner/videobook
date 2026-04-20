import { Switch, Route } from 'wouter';
import { McpStatus } from './components/McpStatus';
import { FileUpload } from './components/FileUpload';
import { useMcpConnection } from './hooks/useMcpConnection';
import { HomePage } from '@/pages/HomePage';
import { Toaster } from '@/components/ui/toaster';

function Dashboard() {
  const { state, tools, error, retry, callTool } = useMcpConnection()

  return (
    <div style={{ textAlign: "left", maxWidth: 520, margin: "2rem auto" }}>
      <McpStatus state={state} tools={tools} error={error} retry={retry} />
      {state === "ready" && <FileUpload callTool={callTool} />}
    </div>
  )
}

function App() {
  return (
    <>
      <Switch>
        <Route path="/up" component={Dashboard} />
        <Route path="/" component={HomePage} />
      </Switch>
      <Toaster />
    </>
  )
}

export default App
