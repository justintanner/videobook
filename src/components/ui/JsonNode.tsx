export function JsonNode({ data, indent = 0 }: { data: unknown; indent?: number }) {
  const pad = '  '.repeat(indent);
  const bracketClass = 'text-primary/30';
  const punctClass = 'text-zinc-600';

  if (data === null) return <span style={{ color: '#ff4060' }}>null</span>;
  if (typeof data === 'boolean') return <span style={{ color: '#ffcc00' }}>{String(data)}</span>;
  if (typeof data === 'number') return <span style={{ color: '#ff00ff' }}>{data}</span>;
  if (typeof data === 'string') return <span style={{ color: '#39ff14' }}>"{data}"</span>;

  if (Array.isArray(data)) {
    if (data.length === 0) return <span className={bracketClass}>[]</span>;
    return (
      <>
        <span className={bracketClass}>[</span>{'\n'}
        {data.map((val, i) => (
          <span key={i}>
            {pad}  <JsonNode data={val} indent={indent + 1} />
            {i < data.length - 1 && <span className={punctClass}>,</span>}
            {'\n'}
          </span>
        ))}
        {pad}<span className={bracketClass}>]</span>
      </>
    );
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return <span className={bracketClass}>{'{}'}</span>;
    return (
      <>
        <span className={bracketClass}>{'{'}</span>{'\n'}
        {entries.map(([key, val], i) => (
          <span key={key}>
            {pad}  <span style={{ color: '#00e5ff' }}>"{key}"</span>
            <span className={punctClass}>: </span>
            <JsonNode data={val} indent={indent + 1} />
            {i < entries.length - 1 && <span className={punctClass}>,</span>}
            {'\n'}
          </span>
        ))}
        {pad}<span className={bracketClass}>{'}'}</span>
      </>
    );
  }

  return <span>{String(data)}</span>;
}
