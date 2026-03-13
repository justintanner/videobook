import { Switch, Route, Link } from 'wouter';
import { McpStatus } from './components/McpStatus';
import { FileUpload } from './components/FileUpload';
import { useMcpConnection } from './hooks/useMcpConnection';
import { Styleguide } from '@/pages/styleguide';

function Dashboard() {
  const { state, tools, error, retry, callTool } = useMcpConnection()

  return (
    <div style={{ textAlign: "left", maxWidth: 520, margin: "2rem auto" }}>
      <McpStatus state={state} tools={tools} error={error} retry={retry} />
      {state === "ready" && <FileUpload callTool={callTool} />}
      <nav style={{ marginTop: "1rem" }}>
        <Link href="/styleguide" className="text-sm text-muted-foreground hover:text-primary transition-colors">
          Styleguide &rarr;
        </Link>
      </nav>
    </div>
  )
}

function BlankIndex() {
  return (
    <div
      className="w-screen h-screen"
      style={{
        backgroundColor: '#0a0c10',
        backgroundImage: 'radial-gradient(circle, rgba(0,212,255,0.08) 1px, transparent 1px)',
        backgroundSize: '24px 24px',
      }}
    />
  )
}

function App() {
  return (
    <Switch>
      <Route path="/styleguide/:page" component={Styleguide} />
      <Route path="/styleguide" component={Styleguide} />
      <Route path="/up" component={Dashboard} />
      <Route path="/" component={BlankIndex} />
    </Switch>
  )
}

export default App
