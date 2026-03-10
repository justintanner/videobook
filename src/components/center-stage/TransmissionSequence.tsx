import { useState, useEffect } from 'react';

interface TransmissionSequenceProps {
  message: string;
  onComplete?: () => void;
}

export function TransmissionSequence({ message, onComplete }: TransmissionSequenceProps) {
  const [phase, setPhase] = useState<'flash' | 'typewriter' | 'dissolve'>('flash');
  const [typedText, setTypedText] = useState('');
  const transmissionText = 'TRANSMISSION_RECEIVED';

  useEffect(() => {
    const flashTimer = setTimeout(() => setPhase('typewriter'), 300);
    const dissolveTimer = setTimeout(() => setPhase('dissolve'), 1200);
    const completeTimer = setTimeout(() => {
      onComplete?.();
    }, 1500);

    return () => {
      clearTimeout(flashTimer);
      clearTimeout(dissolveTimer);
      clearTimeout(completeTimer);
    };
  }, [onComplete]);

  useEffect(() => {
    if (phase !== 'typewriter') return;

    let charIndex = 0;
    const interval = setInterval(() => {
      if (charIndex <= transmissionText.length) {
        setTypedText(transmissionText.slice(0, charIndex));
        charIndex++;
      } else {
        clearInterval(interval);
      }
    }, 40);

    return () => clearInterval(interval);
  }, [phase]);

  return (
    <div
      className="w-full h-full flex items-center justify-center pointer-events-none transition-opacity"
      style={{
        opacity: phase === 'dissolve' ? 0 : 1,
        transitionDuration: phase === 'dissolve' ? '300ms' : '100ms',
      }}
    >
      {/* Horizontal scan line sweep */}
      {phase === 'flash' && (
        <div
          className="absolute left-0 right-0 h-1 bg-gradient-to-r from-transparent via-primary to-transparent"
          style={{
            animation: 'transmission-scan 0.3s linear forwards',
            boxShadow: '0 0 20px var(--color-primary), 0 0 40px var(--color-primary)',
          }}
        />
      )}

      {/* Main content container */}
      <div className="relative flex flex-col items-center gap-4">
        {/* Typewriter text */}
        {(phase === 'typewriter' || phase === 'dissolve') && (
          <div className="relative">
            <span
              className="font-mono text-xl font-bold text-primary tracking-widest"
              style={{ textShadow: '0 0 10px var(--color-primary), 0 0 20px var(--color-primary)' }}
            >
              {typedText}
            </span>
            {/* Blinking block cursor */}
            {phase === 'typewriter' && typedText.length < transmissionText.length && (
              <span
                className="inline-block w-3 h-5 bg-primary ml-0.5 align-middle"
                style={{ animation: 'cursor-blink 0.4s step-end infinite' }}
              />
            )}
          </div>
        )}

        {/* Message echo (faded) */}
        {(phase === 'typewriter' || phase === 'dissolve') && message && (
          <div className="max-w-md text-center opacity-40">
            <span className="font-mono text-xs text-primary/60 truncate block">
              &gt; {message.slice(0, 60)}
              {message.length > 60 ? '...' : ''}
            </span>
          </div>
        )}
      </div>

      {/* Screen shake/jitter effect */}
      {phase === 'typewriter' && (
        <div
          className="absolute inset-0"
          style={{ animation: 'transmission-jitter 0.3s linear 2' }}
        />
      )}
    </div>
  );
}
