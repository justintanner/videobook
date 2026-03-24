export function JsonNode({ data, indent = 0 }: { data: unknown; indent?: number }) {
  const pad = '  '.repeat(indent);

  if (data === null) return <span className="text-zinc-500">null</span>;
  if (typeof data === 'boolean') return <span className="text-violet-400">{String(data)}</span>;
  if (typeof data === 'number') return <span className="text-amber-400">{data}</span>;
  if (typeof data === 'string') return <span className="text-emerald-400">"{data}"</span>;

  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="text-zinc-600">[]</span>;
    return (
      <>
        <span className="text-zinc-600">[</span>{'\n'}
        {data.map((val, i) => (
          <span key={i}>
            {pad}  <JsonNode data={val} indent={indent + 1} />
            {i < data.length - 1 && <span className="text-zinc-600">,</span>}
            {'\n'}
          </span>
        ))}
        {pad}<span className="text-zinc-600">]</span>
      </>
    );
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-zinc-600">{'{}'}</span>;
    return (
      <>
        <span className="text-zinc-600">{'{'}</span>{'\n'}
        {entries.map(([key, val], i) => (
          <span key={key}>
            {pad}  <span className="text-cyan-400">"{key}"</span>
            <span className="text-zinc-600">: </span>
            <JsonNode data={val} indent={indent + 1} />
            {i < entries.length - 1 && <span className="text-zinc-600">,</span>}
            {'\n'}
          </span>
        ))}
        {pad}<span className="text-zinc-600">{'}'}</span>
      </>
    );
  }

  return <span>{String(data)}</span>;
}
