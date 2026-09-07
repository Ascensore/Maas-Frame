'use client';

import { useState } from 'react';
import type { EditLibraryView } from '@/lib/comment-edit/types';

export function GraphicPresetPreview({ preset }: { preset: EditLibraryView['presets'][number] }) {
  const [title, setTitle] = useState('Your title here');
  const [subtitle, setSubtitle] = useState('A short supporting line');
  const template = preset.template ?? preset.id;
  const y = template === 'lower-third' ? 820 : 400;
  const titleSize = Math.min(
    preset.titleSize ?? 48,
    Math.floor(1600 / Math.max(1, title.length) / 0.7)
  );
  const subtitleSize = Math.min(
    preset.subtitleSize ?? 32,
    Math.floor(1600 / Math.max(1, subtitle.length) / 0.7)
  );
  return (
    <details className="rounded border p-2" open>
      <summary className="cursor-pointer">Graphic layout preview</summary>
      <svg
        className="my-2 aspect-video w-full rounded"
        viewBox="0 0 1920 1080"
        role="img"
        aria-label={`${preset.name} layout preview`}
      >
        <rect width="1920" height="1080" fill="#48545B" />
        <path d="M0 840L520 240L1060 800L1520 380L1920 900V1080H0Z" fill="#627078" />
        {template === 'title-card' ? (
          <rect width="1920" height="1080" fill={preset.background} />
        ) : (
          <rect
            x="96"
            y={y}
            width="1728"
            height="170"
            fill={preset.background}
            opacity={223 / 255}
          />
        )}
        <rect x="96" y={y} width="10" height="170" fill={preset.accent} />
        <text
          x="128"
          y={y + 24}
          dominantBaseline="text-before-edge"
          fill={preset.foreground}
          fontFamily={`${preset.font ?? 'DejaVu Sans'}, sans-serif`}
          fontWeight="700"
          fontSize={titleSize}
        >
          {title}
        </text>
        <text
          x="128"
          y={y + 94}
          dominantBaseline="text-before-edge"
          fill={preset.foreground}
          fontFamily={`${preset.font ?? 'DejaVu Sans'}, sans-serif`}
          fontSize={subtitleSize}
        >
          {subtitle}
        </text>
      </svg>
      <div className="space-y-1">
        <label className="block">
          Preview title
          <input
            className="mt-1 w-full rounded border bg-background p-1"
            value={title}
            maxLength={90}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="block">
          Preview subtitle
          <input
            className="mt-1 w-full rounded border bg-background p-1"
            value={subtitle}
            maxLength={140}
            onChange={(event) => setSubtitle(event.target.value)}
          />
        </label>
      </div>
      <p className="mt-2 text-muted-foreground">
        Sample text is for preview only. Put the final text in your feedback. Font appearance may
        differ here; review the rendered draft for final typography and motion.
      </p>
    </details>
  );
}
