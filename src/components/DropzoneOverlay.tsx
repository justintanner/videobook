import { Upload } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DropzoneOverlayProps {
  isDragging: boolean;
}

const FILE_GROUPS = [
  { label: 'Video', exts: '.mp4 .mov .webm .avi .mkv' },
  { label: 'Image', exts: '.jpg .jpeg .png .gif .webp .svg' },
  { label: 'Audio', exts: '.mp3 .wav .aac .flac .ogg' },
  { label: 'Script', exts: '.md' },
];

export function DropzoneOverlay({ isDragging }: DropzoneOverlayProps) {
  if (!isDragging) return null;

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center',
        'bg-black/80 backdrop-blur-sm',
      )}
    >
      {/* Scanline overlay */}
      <div className="absolute inset-0 pointer-events-none scanlines opacity-30" />

      {/* Dashed border inset */}
      <div className="absolute inset-4 border-2 border-dashed border-cyan-500/60 rounded-lg" />

      {/* Center content */}
      <div className="relative flex flex-col items-center gap-4 z-10">
        {/* Upload icon with glow */}
        <div className="relative">
          <Upload className="w-12 h-12 text-cyan-400 drop-shadow-[0_0_12px_#00ffff]" />
        </div>

        {/* Heading */}
        <h2 className="text-2xl font-mono font-bold text-cyan-400 tracking-[0.3em] drop-shadow-[0_0_8px_#00ffff]">
          DROP FILES
        </h2>

        {/* File type groups */}
        <div className="flex flex-col gap-1.5 mt-2">
          {FILE_GROUPS.map((group) => (
            <div key={group.label} className="flex items-baseline gap-2 font-mono text-xs">
              <span className="text-cyan-500 tracking-wider uppercase w-14 text-right">
                {group.label}
              </span>
              <span className="text-cyan-600/80">{group.exts}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Glitch scanline sweep */}
      <div
        className="absolute inset-0 pointer-events-none bg-gradient-to-b from-transparent via-cyan-500/10 to-transparent h-8"
        style={{ animation: 'uploading-scanline 3s linear infinite' }}
      />
    </div>
  );
}
