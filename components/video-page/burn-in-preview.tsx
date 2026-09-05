'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  BURN_IN_FONTS,
  BURN_IN_REFERENCE_HEIGHT,
  type BurnInFontId,
  type BurnInStyle,
} from '@/lib/rough-cut/subtitle-style';
import { cn } from '@/lib/utils';

/**
 * What a burned-in caption will roughly look like.
 *
 * A likeness, not a proof: the same font family, colours, weight, placement and
 * words-per-caption the renderer will use, scaled from the schema's 1080-line
 * reference height to whatever this box measures. libass draws the real thing,
 * and it draws the stroke rather than eight offset copies of the text.
 */

/** Fourteen words, the schema's ceiling, so the line can show any pacing setting. */
const SAMPLE_WORDS = [
  'This',
  'is',
  'how',
  'your',
  'captions',
  'will',
  'look',
  'once',
  'they',
  'are',
  'burned',
  'into',
  'the',
  'picture',
];

/** What the browser falls back to when the render font is not installed locally. */
const FONT_FALLBACKS: Record<BurnInFontId, string> = {
  'dejavu-sans': 'sans-serif',
  'liberation-sans': 'Arial, Helvetica, sans-serif',
  roboto: 'sans-serif',
  'open-sans': 'sans-serif',
  'liberation-serif': 'Times New Roman, serif',
  'dejavu-sans-mono': 'ui-monospace, monospace',
};

/** The box height assumed until the real one has been measured. */
const NOMINAL_HEIGHT = 240;

function rgba(hex: string, alpha: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Eight offsets standing in for libass's stroke. */
function outlineShadow(color: string, radius: number): string {
  const r = Math.round(radius * 100) / 100;
  return [
    [-r, -r],
    [0, -r],
    [r, -r],
    [-r, 0],
    [r, 0],
    [-r, r],
    [0, r],
    [r, r],
  ]
    .map(([x, y]) => `${x}px ${y}px 0 ${color}`)
    .join(', ');
}

export function BurnInPreview({ style }: { style: BurnInStyle }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const node = boxRef.current;
    if (!node) return;
    const measure = () => setHeight(node.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const font = BURN_IN_FONTS.find((entry) => entry.id === style.font) ?? BURN_IN_FONTS[0];
  // A nominal box keeps the first paint proportionate instead of collapsing the
  // line to nothing before the observer has reported anything.
  const scale = (height || NOMINAL_HEIGHT) / BURN_IN_REFERENCE_HEIGHT;
  const fontSize = style.fontSize * scale;
  const boxed = style.backgroundOpacity > 0;

  const textStyle = useMemo<CSSProperties>(
    () => ({
      fontFamily: `"${font.family}", ${FONT_FALLBACKS[font.id]}`,
      fontSize: `${fontSize}px`,
      lineHeight: 1.2,
      color: style.textColor,
      fontWeight: style.bold ? 700 : 400,
      textAlign: 'center',
      whiteSpace: 'pre-wrap',
      padding: boxed ? `${fontSize * 0.12}px ${fontSize * 0.3}px` : undefined,
      // The renderer draws the box in the outline colour too, so the two agree.
      backgroundColor: boxed ? rgba(style.outlineColor, style.backgroundOpacity) : undefined,
      textShadow:
        style.outlineWidth > 0
          ? outlineShadow(style.outlineColor, style.outlineWidth * scale)
          : undefined,
    }),
    [boxed, font, fontSize, scale, style]
  );

  const line = useMemo(() => {
    const words = SAMPLE_WORDS.slice(0, style.maxWordsPerCue).join(' ');
    return style.uppercase ? words.toUpperCase() : words;
  }, [style.maxWordsPerCue, style.uppercase]);

  const margin = style.marginVertical * scale;

  return (
    <div
      ref={boxRef}
      aria-hidden="true"
      className="relative aspect-video w-full overflow-hidden rounded-xl bg-neutral-900"
    >
      <div
        className={cn(
          'absolute inset-0 flex justify-center px-[4%]',
          style.position === 'bottom' && 'items-end',
          style.position === 'center' && 'items-center',
          style.position === 'top' && 'items-start'
        )}
        style={{
          paddingBottom: style.position === 'bottom' ? margin : undefined,
          paddingTop: style.position === 'top' ? margin : undefined,
        }}
      >
        <span style={textStyle}>{line}</span>
      </div>
    </div>
  );
}
