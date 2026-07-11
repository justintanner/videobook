import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

const LOOP_WINDOW = 2;

interface UseBoundaryPlayerResult {
  videoRef: RefObject<HTMLVideoElement | null>;
  playing: boolean;
  togglePlay: () => void;
  seekTo: (time: number) => void;
  currentTime: number;
}

export function useBoundaryPlayer(
  videoSrc: string,
  boundarySec: number | null,
  duration: number,
): UseBoundaryPlayerResult {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const seekTo = useCallback((time: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = time;
    setCurrentTime(time);
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || boundarySec === null) return;
    const loopStart = Math.max(0, boundarySec - LOOP_WINDOW);
    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      const loopEnd = Math.min(duration || Infinity, boundarySec + LOOP_WINDOW);
      if (video.currentTime >= loopEnd || video.currentTime < loopStart - 0.1) {
        video.currentTime = loopStart;
      }
    };
    const onSeeked = () => setCurrentTime(video.currentTime);
    const onLoadedMetadata = () => {
      video.currentTime = loopStart;
    };
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    if (video.readyState >= 1) {
      video.currentTime = loopStart;
    }
    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
    };
  }, [boundarySec, duration, videoSrc]);

  return { videoRef, playing, togglePlay, seekTo, currentTime };
}
