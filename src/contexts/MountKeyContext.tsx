import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';

interface MountKeyContextValue {
  keys: ReadonlySet<string>;
  register: (key: string) => void;
  unregister: (key: string) => void;
}

const MountKeyContext = createContext<MountKeyContextValue | null>(null);

export function MountKeyProvider({ children }: { children: React.ReactNode }) {
  const [keys, setKeys] = useState<ReadonlySet<string>>(new Set());

  const register = useCallback((key: string) => {
    setKeys((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  const unregister = useCallback((key: string) => {
    setKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ keys, register, unregister }), [keys, register, unregister]);

  return (
    <MountKeyContext.Provider value={value}>
      {children}
    </MountKeyContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useMountKey(key: string): void {
  const ctx = useContext(MountKeyContext);
  if (!ctx) throw new Error('useMountKey must be used within MountKeyProvider');
  const { register, unregister } = ctx;
  useEffect(() => {
    register(key);
    return () => unregister(key);
  }, [key, register, unregister]);
}

// eslint-disable-next-line react-refresh/only-export-components
export function useMountKeys(): ReadonlySet<string> {
  const ctx = useContext(MountKeyContext);
  if (!ctx) throw new Error('useMountKeys must be used within MountKeyProvider');
  return ctx.keys;
}
