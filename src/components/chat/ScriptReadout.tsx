import { useState, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';
import { FileText, Loader2, Film } from 'lucide-react';
import { ProofReadButton } from './ProofReadButton';
import { ScriptBlock } from './ScriptBlocks';

const pixelGridStyle = {
  backgroundImage:
    'linear-gradient(rgba(0, 255, 255, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 255, 255, 0.1) 1px, transparent 1px)',
  backgroundSize: '4px 4px',
};

interface ScriptReadoutProps {
  content: string | null | undefined;
  slug: string;
  className?: string;
  onSave?: (content: string) => void;
  onGenerateVideo?: (scriptContent: string) => void;
  onProofRead?: () => void;
  isGenerating?: boolean;
  isProofReading?: boolean;
  audioUrl?: string | null;
}

export function ScriptReadout({
  content,
  slug,
  className,
  onSave,
  onGenerateVideo,
  onProofRead,
  isGenerating = false,
  isProofReading = false,
  audioUrl = null,
}: ScriptReadoutProps) {
  const [plainContent, setPlainContent] = useState(content ?? '');
  const [originalContent] = useState(content ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  const plainHasChanges = plainContent !== originalContent;

  const handleSave = useCallback(() => {
    if (!onSave) return;
    setIsSaving(true);
    onSave(plainContent);
    setTimeout(() => setIsSaving(false), 800);
  }, [plainContent, onSave]);

  const handleCancel = useCallback(() => {
    setPlainContent(originalContent);
  }, [originalContent]);

  const handleStopPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setIsPlaying(false);
  }, []);

  const handlePlayToggle = useCallback(() => {
    if (isPlaying) {
      handleStopPlayback();
      return;
    }
    if (audioUrl && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play();
      setIsPlaying(true);
    }
  }, [isPlaying, handleStopPlayback, audioUrl]);

  const handleGenerateVideo = useCallback(() => {
    if (content && onGenerateVideo) {
      onGenerateVideo(content);
    }
  }, [content, onGenerateVideo]);

  return (
    <div
      className={cn(
        'relative w-full h-full overflow-hidden',
        'bg-gradient-to-b from-cyan-950/30 via-black to-black',
        className
      )}
    >
      {/* Scanlines overlay */}
      <div className="absolute inset-0 pointer-events-none scanlines opacity-20 z-10" />
      {/* Pixel grid */}
      <div className="absolute inset-0 pointer-events-none opacity-5" style={pixelGridStyle} />

      {/* Corner accent SVGs */}
      <svg
        className="absolute top-0 left-0 w-6 h-6 text-primary/30 z-30"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      >
        <path d="M0 12 L12 0" />
        <path d="M0 6 L6 0" />
      </svg>
      <svg
        className="absolute bottom-0 right-0 w-6 h-6 text-primary/30 z-30"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      >
        <path d="M24 12 L12 24" />
        <path d="M24 18 L18 24" />
      </svg>

      {/* Content frame */}
      <div
        className={cn(
          'relative z-20 h-full flex flex-col',
          'border-2 border-cyan-400/50',
          'clip-corner-both',
          'shadow-[0_0_30px_-10px_rgba(0,255,255,0.3)]'
        )}
      >
        {/* Header */}
        <div
          className={cn(
            'flex items-center gap-3 px-4 py-2 shrink-0',
            'border-b-2 border-inherit',
            'bg-black/50 backdrop-blur-sm'
          )}
        >
          <FileText className="w-4 h-4 text-cyan-400 drop-shadow-[0_0_6px_#22d3ee]" />
          <span className="text-sm font-bold tracking-[0.15em] text-cyan-400">{slug}</span>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={handleGenerateVideo}
              disabled={isGenerating || !content}
              className={cn(
                'h-6 px-2 font-bold text-[10px] tracking-wider shrink-0 rounded',
                'bg-primary/20 border border-primary/40',
                'text-primary hover:bg-primary/30 hover:border-primary/60',
                'shadow-[0_0_8px_rgba(0,255,255,0.3)]',
                'disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-primary/20',
                'transition-all duration-200',
                'flex items-center justify-center gap-1'
              )}
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Gen...</span>
                </>
              ) : (
                <>
                  <Film className="w-3 h-3" />
                  <span>Gen Video</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
          {!content ? (
            <div className="text-primary/50 animate-pulse">NO_CONTENT...</div>
          ) : (
            <ScriptBlock
              label="Script"
              content={plainContent}
              onChange={setPlainContent}
              onSave={handleSave}
              onCancel={handleCancel}
              hasChanges={plainHasChanges}
              isSaving={isSaving}
              placeholder="Enter script content..."
              audioActions={
                <ProofReadButton
                  audioUrl={audioUrl}
                  isPlaying={isPlaying}
                  isPending={isProofReading}
                  dialogDirty={plainHasChanges}
                  disabled={false}
                  onPlay={handlePlayToggle}
                  onRegenerate={onProofRead ?? (() => {})}
                  audioRef={audioRef}
                />
              }
            />
          )}
        </div>

        {/* Hidden audio element for proof read playback */}
        {audioUrl && <audio ref={audioRef} src={audioUrl} onEnded={handleStopPlayback} />}
      </div>
    </div>
  );
}
