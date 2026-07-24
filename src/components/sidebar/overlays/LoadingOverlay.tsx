import type { OverlayProps } from './types';

export function LoadingOverlay({ item: _item }: OverlayProps) {
  return (
    <>
      {/* Layer 1: Frost base - semi-transparent ice blue tint with vignette */}
      <div
        className="absolute inset-0 z-30 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(136, 212, 255, 0.05) 0%, rgba(136, 212, 255, 0.15) 70%, rgba(79, 168, 212, 0.25) 100%)',
        }}
      />

      {/* Layer 2: Shimmer sweep - light reflection moving diagonally across */}
      <div className="absolute inset-0 z-30 overflow-hidden pointer-events-none">
        <div
          className="absolute w-32 h-full"
          style={{
            background:
              'linear-gradient(105deg, transparent 0%, rgba(255, 255, 255, 0.1) 45%, rgba(136, 212, 255, 0.25) 50%, rgba(255, 255, 255, 0.1) 55%, transparent 100%)',
            animation: 'ice-shimmer-sweep 4s ease-in-out infinite',
          }}
        />
      </div>
    </>
  );
}
