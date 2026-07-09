import { useEffect, useRef, useState, type RefObject } from 'react';
import { frameIndex } from './utils';

const CACHE_CAP = 64;

interface FrameCacheEntry {
  url: string;
  order: number;
}

interface UseLazySplitFramesArgs {
  open: boolean;
  videoSrc: string;
  fps: number;
  /** End frame of chunk A (typically split − 1 frame). */
  leftSec: number | null;
  /** Start frame of chunk B (split point). */
  rightSec: number | null;
}

interface LazyFrames {
  leftUrl: string | null;
  rightUrl: string | null;
  seeking: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
}

export function useLazySplitFrames({
  open,
  videoSrc,
  fps,
  leftSec,
  rightSec,
}: UseLazySplitFramesArgs): LazyFrames {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cacheRef = useRef<Map<number, FrameCacheEntry>>(new Map());
  const orderRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const [leftUrl, setLeftUrl] = useState<string | null>(null);
  const [rightUrl, setRightUrl] = useState<string | null>(null);
  const [seeking, setSeeking] = useState(false);

  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      for (const entry of cache.values()) {
        URL.revokeObjectURL(entry.url);
      }
      cache.clear();
    };
  }, []);

  useEffect(() => {
    if (!open || !videoSrc) return;
    if (leftSec === null && rightSec === null) return;

    let cancelled = false;

    const captureAt = (t: number): Promise<string | null> => {
      const key = frameIndex(t, fps);
      const hit = cacheRef.current.get(key);
      if (hit) {
        hit.order = ++orderRef.current;
        return Promise.resolve(hit.url);
      }

      const video = videoRef.current;
      if (!video) return Promise.resolve(null);

      return new Promise((resolve) => {
        const target = Math.max(0, Math.min(t, Number.isFinite(video.duration) ? video.duration : t));

        const finish = () => {
          try {
            if (!canvasRef.current) {
              canvasRef.current = document.createElement('canvas');
            }
            const canvas = canvasRef.current;
            const w = video.videoWidth || 0;
            const h = video.videoHeight || 0;
            if (w <= 0 || h <= 0) {
              resolve(null);
              return;
            }
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              resolve(null);
              return;
            }
            ctx.drawImage(video, 0, 0, w, h);
            canvas.toBlob((blob) => {
              if (!blob) {
                resolve(null);
                return;
              }
              const url = URL.createObjectURL(blob);
              if (cacheRef.current.size >= CACHE_CAP) {
                let oldestKey: number | null = null;
                let oldestOrder = Infinity;
                for (const [k, v] of cacheRef.current) {
                  if (v.order < oldestOrder) {
                    oldestOrder = v.order;
                    oldestKey = k;
                  }
                }
                if (oldestKey !== null) {
                  const old = cacheRef.current.get(oldestKey);
                  if (old) URL.revokeObjectURL(old.url);
                  cacheRef.current.delete(oldestKey);
                }
              }
              cacheRef.current.set(key, { url, order: ++orderRef.current });
              resolve(url);
            }, 'image/jpeg', 0.85);
          } catch {
            resolve(null);
          }
        };

        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          requestAnimationFrame(() => {
            requestAnimationFrame(finish);
          });
        };

        video.addEventListener('seeked', onSeeked);
        if (Math.abs(video.currentTime - target) < 0.0005 && video.readyState >= 2) {
          video.removeEventListener('seeked', onSeeked);
          requestAnimationFrame(() => {
            requestAnimationFrame(finish);
          });
        } else {
          video.currentTime = target;
        }
      });
    };

    const run = async () => {
      if (!cancelled) setSeeking(true);
      const nextLeft = leftSec !== null ? await captureAt(leftSec) : null;
      if (cancelled) return;
      const nextRight = rightSec !== null ? await captureAt(rightSec) : null;
      if (cancelled) return;
      if (nextLeft) setLeftUrl(nextLeft);
      if (nextRight) setRightUrl(nextRight);
      setSeeking(false);
    };

    queueRef.current = queueRef.current.then(run, run);
    return () => { cancelled = true; };
  }, [open, videoSrc, fps, leftSec, rightSec]);

  return { leftUrl, rightUrl, seeking, videoRef };
}
