import React, { useState, useRef, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Play, Pause, Scissors } from 'lucide-react';

interface TimelineProps {
  duration: number; // in seconds
  currentTime: number;
  onTimeChange: (time: number) => void;
  highlights?: Array<{ start: number, end: number, id: string }>;
  onHighlightAdjust?: (id: string, start: number, end: number) => void;
}

export function VideoTimeline({
  duration,
  currentTime,
  onTimeChange,
  highlights = [],
  onHighlightAdjust
}: TimelineProps) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [activeHandle, setActiveHandle] = useState<{ id: string, type: 'start' | 'end' } | null>(null);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!timelineRef.current || activeHandle) return;
    setIsDragging(true);
    updateTimeFromEvent(e);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isDragging) {
      updateTimeFromEvent(e);
    } else if (activeHandle && onHighlightAdjust) {
      updateHighlightFromEvent(e);
    }
  };

  const handlePointerUp = () => {
    setIsDragging(false);
    setActiveHandle(null);
  };

  const updateTimeFromEvent = (e: React.PointerEvent) => {
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const percentage = x / rect.width;
    onTimeChange(percentage * duration);
  };

  const updateHighlightFromEvent = (e: React.PointerEvent) => {
    if (!timelineRef.current || !activeHandle || !onHighlightAdjust) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const newTime = (x / rect.width) * duration;

    const highlight = highlights.find(h => h.id === activeHandle.id);
    if (!highlight) return;

    if (activeHandle.type === 'start') {
      onHighlightAdjust(highlight.id, Math.min(newTime, highlight.end - 1), highlight.end);
    } else {
      onHighlightAdjust(highlight.id, highlight.start, Math.max(newTime, highlight.start + 1));
    }
  };

  useEffect(() => {
    window.addEventListener('pointerup', handlePointerUp);
    return () => window.removeEventListener('pointerup', handlePointerUp);
  }, []);

  return (
    <Card className="p-4 bg-card/50 backdrop-blur">
      <div className="flex justify-between items-center mb-4">
        <div className="text-sm font-medium">Timeline Editor</div>
        <Badge variant="secondary" className="font-mono">
          {formatTime(currentTime)} / {formatTime(duration)}
        </Badge>
      </div>

      <div
        className="relative h-24 bg-muted rounded-lg overflow-hidden cursor-crosshair select-none touch-none"
        ref={timelineRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
      >
        {/* Background markers */}
        <div className="absolute inset-0 opacity-10" style={{
          backgroundImage: 'repeating-linear-gradient(90deg, transparent, transparent 49px, currentColor 49px, currentColor 50px)'
        }} />

        {/* Highlights */}
        {highlights.map((h) => {
          const left = `${(h.start / duration) * 100}%`;
          const width = `${((h.end - h.start) / duration) * 100}%`;
          return (
            <div
              key={h.id}
              className="absolute top-2 bottom-2 bg-primary/20 border border-primary/50 rounded flex items-center group"
              style={{ left, width }}
            >
              {/* Left Handle */}
              <div
                className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize hover:bg-primary z-10"
                onPointerDown={(e) => { e.stopPropagation(); setActiveHandle({ id: h.id, type: 'start' }); }}
              />
              <div className="mx-auto opacity-0 group-hover:opacity-100 transition-opacity">
                <Scissors className="w-4 h-4 text-primary" />
              </div>
              {/* Right Handle */}
              <div
                className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize hover:bg-primary z-10"
                onPointerDown={(e) => { e.stopPropagation(); setActiveHandle({ id: h.id, type: 'end' }); }}
              />
            </div>
          );
        })}

        {/* Playhead */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-20 pointer-events-none"
          style={{ left: `${(currentTime / duration) * 100}%` }}
        >
          <div className="absolute -top-1 -translate-x-1/2 w-3 h-3 rounded-full bg-red-500" />
        </div>
      </div>
    </Card>
  );
}
