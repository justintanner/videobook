import { useState, useCallback, useRef } from 'react';

interface UseAnimateTypeResult {
  animatingText: string;
  isAnimating: boolean;
  startAnimation: (text: string, onComplete: () => void) => void;
  cancelAnimation: () => void;
}

const CHAR_DELAY_MS = 40;

export function useAnimateType(): UseAnimateTypeResult {
  const [animatingText, setAnimatingText] = useState('');
  const [isAnimating, setIsAnimating] = useState(false);
  const rafRef = useRef<number>(0);
  const onCompleteRef = useRef<(() => void) | null>(null);

  const cancelAnimation = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    setIsAnimating(false);
    setAnimatingText('');
    onCompleteRef.current = null;
  }, []);

  const startAnimation = useCallback((text: string, onComplete: () => void) => {
    cancelAnimation();
    if (!text) {
      onComplete();
      return;
    }

    onCompleteRef.current = onComplete;
    setIsAnimating(true);
    setAnimatingText('');

    let charIndex = 0;
    let lastTime = 0;

    const step = (timestamp: number) => {
      if (!lastTime) lastTime = timestamp;
      const elapsed = timestamp - lastTime;

      if (elapsed >= CHAR_DELAY_MS) {
        charIndex++;
        lastTime = timestamp;
        const current = text.slice(0, charIndex);
        setAnimatingText(current);

        if (charIndex >= text.length) {
          setIsAnimating(false);
          rafRef.current = 0;
          onCompleteRef.current?.();
          onCompleteRef.current = null;
          return;
        }
      }

      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
  }, [cancelAnimation]);

  return { animatingText, isAnimating, startAnimation, cancelAnimation };
}
