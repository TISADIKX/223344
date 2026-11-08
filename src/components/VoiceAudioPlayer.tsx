import React, { useState, useRef, useEffect } from 'react';

interface VoiceAudioPlayerProps {
  src: string;
  durationSeconds?: number;
  onRemove?: () => void;
  compact?: boolean;
}

const WAVEFORM_BAR_HEIGHTS = [
  'h-2', 'h-3.5', 'h-2.5', 'h-5', 'h-5.5', 'h-3', 'h-4', 'h-2.5', 'h-5', 'h-3.5',
  'h-3', 'h-5.5', 'h-4', 'h-2.5', 'h-4.5', 'h-3.5', 'h-5', 'h-3', 'h-4', 'h-2.5',
];

export const VoiceAudioPlayer: React.FC<VoiceAudioPlayerProps> = ({
  src,
  durationSeconds = 0,
  onRemove,
  compact = false,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [resolvedDuration, setResolvedDuration] = useState<number>(durationSeconds);

  useEffect(() => {
    if (durationSeconds > 0) {
      setResolvedDuration(durationSeconds);
    }
  }, [durationSeconds]);

  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
  }, [src]);

  const formatTime = (secs: number) => {
    if (!Number.isFinite(secs) || secs < 0) secs = 0;
    const total = Math.floor(secs);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    }
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !resolvedDuration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * resolvedDuration;
    setCurrentTime(audio.currentTime);
  };

  const totalSecs = resolvedDuration > 0 ? resolvedDuration : durationSeconds;
  const progress = totalSecs > 0 ? Math.min(1, currentTime / totalSecs) : 0;

  return (
    <div
      className={`flex items-center gap-2.5 select-none ${
        compact
          ? 'bg-[#1a1c24] border border-white/10 rounded-xl px-2.5 py-1.5 w-full sm:w-auto sm:min-w-[250px]'
          : 'bg-[#15171e] border border-white/10 rounded-xl px-3 py-2 min-w-[216px] sm:min-w-[252px]'
      }`}
    >
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) {
            setResolvedDuration(d);
          }
        }}
        onTimeUpdate={(e) => {
          setCurrentTime(e.currentTarget.currentTime);
        }}
        onEnded={() => {
          setIsPlaying(false);
          setCurrentTime(0);
        }}
      />

      {/* Play / Pause Button */}
      <button
        type="button"
        onClick={togglePlay}
        className="w-7 h-7 rounded-full bg-white text-gray-950 hover:bg-gray-200 flex items-center justify-center transition cursor-pointer shrink-0"
        title={isPlaying ? 'Pause voice' : 'Play voice'}
      >
        <span className="material-symbols-outlined text-[17px]">
          {isPlaying ? 'pause' : 'play_arrow'}
        </span>
      </button>

      {/* Interactive Waveform Progress */}
      <div
        onClick={handleSeek}
        className="flex-1 flex items-center gap-[3px] h-6 cursor-pointer min-w-[100px]"
        title="Seek voice recording"
      >
        {WAVEFORM_BAR_HEIGHTS.map((heightClass, idx) => {
          const barThreshold = (idx + 0.5) / WAVEFORM_BAR_HEIGHTS.length;
          const isFilled = progress >= barThreshold || (isPlaying && idx === 0 && progress > 0);
          return (
            <span
              key={idx}
              className={`flex-1 rounded-full transition-colors duration-100 ${heightClass} ${
                isFilled ? 'bg-white' : 'bg-white/25'
              }`}
            />
          );
        })}
      </div>

      {/* Tabular Duration */}
      <span className="font-mono tabular-nums text-[11px] text-gray-300 shrink-0">
        {isPlaying || currentTime > 0 ? formatTime(currentTime) : formatTime(totalSecs)}
      </span>

      {/* Optional Remove Button (in composer preview before sending) */}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="w-5.5 h-5.5 rounded-full flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 transition cursor-pointer shrink-0"
          title="Discard voice recording"
        >
          <span className="material-symbols-outlined text-[14px]">close</span>
        </button>
      )}
    </div>
  );
};
