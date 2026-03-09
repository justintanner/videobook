import type { OverlayProps } from './types';

function getBadgeText(status: string | undefined): string {
  if (status === 'rendering-landscape') return 'LANDSCAPE';
  if (status === 'rendering-portrait') return 'PORTRAIT';
  if (status === 'render-queued') return 'QUEUED';
  if (status === 'render-queued-landscape') return 'QUEUED';
  if (status === 'render-queued-portrait') return 'QUEUED';
  if (status === 'rendering-square') return 'SQUARE';
  if (status === 'render-queued-square') return 'QUEUED';
  return 'RENDERING';
}

function InlineElf({ delay }: { delay: number }) {
  return (
    <div className="relative flex flex-col items-center">
      {/* Hammer - animated */}
      <div
        className="absolute -top-3 -right-1 text-[8px] elf-hammer"
        style={{
          animationDelay: `${delay}s`,
          color: '#fbbf24',
          textShadow: '0 0 4px #fbbf24',
        }}
      >
        🔨
      </div>
      {/* Pointed hat */}
      <div
        className="w-0 h-0 elf-bounce"
        style={{
          borderLeft: '4px solid transparent',
          borderRight: '4px solid transparent',
          borderBottom: '6px solid #fbbf24',
          filter: 'drop-shadow(0 0 2px #fbbf24)',
          animationDelay: `${delay}s`,
        }}
      />
      {/* Head/body block */}
      <div
        className="w-3 h-4 elf-bounce"
        style={{
          backgroundColor: '#fbbf24',
          boxShadow: '0 0 6px #fbbf24',
          animationDelay: `${delay}s`,
        }}
      />
      {/* Legs */}
      <div className="flex gap-[2px]">
        <div
          className="w-1 h-2"
          style={{
            backgroundColor: '#d97706',
            boxShadow: '0 0 3px #d97706',
          }}
        />
        <div
          className="w-1 h-2"
          style={{
            backgroundColor: '#d97706',
            boxShadow: '0 0 3px #d97706',
          }}
        />
      </div>
    </div>
  );
}

function GoldenSparkle({ index }: { index: number }) {
  const leftOffsets = [-30, 0, 30];
  const delays = [0, 0.6, 1.2];

  return (
    <div
      className="absolute w-1 h-1 elf-sparkle"
      style={{
        left: `calc(50% + ${leftOffsets[index % 3]}px)`,
        bottom: '4px',
        backgroundColor: '#fbbf24',
        boxShadow: '0 0 4px #fbbf24, 0 0 8px #fbbf24',
        borderRadius: '50%',
        animationDelay: `${delays[index % 3]}s`,
      }}
    />
  );
}

export function ElfBuildingOverlay({ item }: OverlayProps) {
  const primaryColor = '#fbbf24';
  const badgeText = getBadgeText(item.status);

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 overflow-hidden">
      {/* Subtle pixel grid background */}
      <div
        className="absolute inset-0 pointer-events-none opacity-15"
        style={{
          backgroundImage: `
            linear-gradient(rgba(251, 191, 36, 0.3) 1px, transparent 1px),
            linear-gradient(90deg, rgba(251, 191, 36, 0.3) 1px, transparent 1px)
          `,
          backgroundSize: '8px 8px',
        }}
      />

      {/* Grouped elves + badge container */}
      <div className="relative flex flex-col items-center -mt-4">
        {/* Elves row - at top */}
        <div className="relative flex items-end justify-center gap-6 h-12">
          {/* Golden sparkles */}
          {[0, 1, 2].map((i) => (
            <GoldenSparkle key={i} index={i} />
          ))}

          {/* Three pixel elves in a row */}
          <InlineElf delay={0} />
          <InlineElf delay={0.3} />
          <InlineElf delay={0.6} />
        </div>

        {/* Work surface / anvil line */}
        <div
          className="w-32 h-[2px]"
          style={{
            backgroundColor: primaryColor,
            boxShadow: `0 0 8px ${primaryColor}`,
            opacity: 0.6,
          }}
        />

        {/* Badge - below work surface */}
        <div
          className="px-3 py-1 text-[10px] font-mono font-bold tracking-wider border flex items-center gap-2 mt-2"
          style={{
            color: primaryColor,
            borderColor: 'rgba(251, 191, 36, 0.6)',
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            boxShadow: `0 0 12px ${primaryColor}`,
            animation: 'generating-model-pulse 2s ease-in-out infinite',
            textShadow: `0 0 8px ${primaryColor}`,
          }}
        >
          <span>⚒</span>
          <span>{badgeText}</span>
          <span>⚒</span>
        </div>
      </div>
    </div>
  );
}
