import { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX } from "react";

interface VirtualizedListProps {
  count: number;
  itemHeight: number;
  height: number;
  rowKey: (index: number) => string;
  renderRow: (index: number) => JSX.Element;
  className?: string;
  overscan?: number;
  style?: CSSProperties;
}

/**
 * Renders only the rows inside (and just outside) the visible viewport of a
 * fixed-height list. Transcripts for 1-4 hour meetings can reach thousands of
 * segments; real `map()` over every segment keeps all of them alive in the DOM
 * and stalls the renderer. Windowing caps the number of mounted rows to the
 * viewport, which keeps scrolling smooth regardless of meeting length.
 */
export function VirtualizedList({
  count,
  itemHeight,
  height,
  rowKey,
  renderRow,
  className,
  overscan = 8,
  style,
}: VirtualizedListProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState({ height, width: 0 });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setViewport({ height: entry.contentRect.height, width: entry.contentRect.width });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const visibleHeight = viewport.height || height;
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const endIndex = Math.min(count - 1, Math.floor((scrollTop + visibleHeight) / itemHeight) + overscan);

  const rows = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    rows.push(
      <div
        key={rowKey(index)}
        style={{
          position: "absolute",
          top: index * itemHeight,
          left: 0,
          right: 0,
          height: itemHeight,
          overflow: "hidden",
        }}
      >
        {renderRow(index)}
      </div>,
    );
  }

  const onScroll = useCallback(() => {
    setScrollTop(scrollRef.current?.scrollTop ?? 0);
  }, []);

  return (
    <div
      ref={scrollRef}
      className={className}
      onScroll={onScroll}
      style={{ position: "relative", height, overflowY: "auto", ...style }}
      role="list"
      aria-live="polite"
    >
      <div style={{ position: "relative", height: count * itemHeight }}>{rows}</div>
    </div>
  );
}