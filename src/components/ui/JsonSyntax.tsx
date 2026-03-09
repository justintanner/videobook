import { cn } from '@/lib/utils';

interface JsonSyntaxProps {
  data: unknown;
  className?: string;
}

function renderValue(value: unknown, indent: number = 0): React.ReactNode {

  if (value === null) {
    return <span className="text-gray-500">null</span>;
  }

  if (typeof value === 'boolean') {
    return <span className="text-purple-400">{value ? 'true' : 'false'}</span>;
  }

  if (typeof value === 'number') {
    return <span className="text-yellow-400">{value}</span>;
  }

  if (typeof value === 'string') {
    // Truncate long strings
    const displayStr = value.length > 100 ? value.substring(0, 100) + '...' : value;
    return <span className="text-green-400">"{displayStr}"</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-gray-400">[]</span>;
    }
    return (
      <>
        <span className="text-gray-400">[</span>
        {value.map((item, i) => (
          <div key={i} className="pl-4">
            {renderValue(item, indent + 1)}
            {i < value.length - 1 && <span className="text-gray-400">,</span>}
          </div>
        ))}
        <span className="text-gray-400">]</span>
      </>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return <span className="text-gray-400">{'{}'}</span>;
    }
    return (
      <>
        <span className="text-gray-400">{'{'}</span>
        {entries.map(([key, val], i) => (
          <div key={key} className="pl-4">
            <span className="text-primary">"{key}"</span>
            <span className="text-gray-400">: </span>
            {renderValue(val, indent + 1)}
            {i < entries.length - 1 && <span className="text-gray-400">,</span>}
          </div>
        ))}
        <span className="text-gray-400">{'}'}</span>
      </>
    );
  }

  return <span className="text-gray-500">undefined</span>;
}

export function JsonSyntax({ data, className }: JsonSyntaxProps) {
  return (
    <pre className={cn('font-mono text-xs leading-relaxed whitespace-pre-wrap break-all', className)}>
      {renderValue(data)}
    </pre>
  );
}
