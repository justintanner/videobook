export function LoadingScreen({ label }: { label: string }) {
  return (
    <div className="fixed inset-0 z-50 bg-background flex items-center justify-center">
      {/* Scanline grid background */}
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(0deg, transparent 24%, rgba(var(--color-primary-rgb, 0 255 136)) 25%, rgba(var(--color-primary-rgb, 0 255 136)) 26%, transparent 27%, transparent 74%, rgba(var(--color-primary-rgb, 0 255 136)) 75%, rgba(var(--color-primary-rgb, 0 255 136)) 76%, transparent 77%)',
          backgroundSize: '100% 4px',
        }}
      />

      <div className="text-center space-y-6">
        {/* Spinner ring */}
        <div className="relative w-20 h-20 mx-auto">
          <div className="absolute inset-0 rounded-full border border-primary/20 animate-pulse" />
          <svg className="w-20 h-20 animate-spin-slow" viewBox="0 0 80 80">
            <circle
              cx="40" cy="40" r="36"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray="60 160"
              className="text-primary/60"
            />
          </svg>
          {/* Inner pulsing circle */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-10 h-10 rounded-full bg-primary/10 animate-pulse" />
          </div>
        </div>

        <p className="font-mono text-primary/50 text-sm tracking-widest">{label}</p>
      </div>
    </div>
  );
}
