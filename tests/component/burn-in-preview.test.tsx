import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { BurnInPreview } from '@/components/video-page/burn-in-preview';
import { parseBurnInStyle, type BurnInStyle } from '@/lib/rough-cut/subtitle-style';

function style(overrides: Record<string, unknown> = {}): BurnInStyle {
  const parsed = parseBurnInStyle(overrides);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function draw(overrides: Record<string, unknown> = {}) {
  const { container } = render(<BurnInPreview style={style(overrides)} />);
  const line = container.querySelector('span');
  const frame = line?.parentElement;
  if (!line || !frame) throw new Error('the preview drew no caption line');
  return { line, frame };
}

describe('BurnInPreview', () => {
  it('shows exactly as many words as the pacing control asks for', () => {
    // Both ends of the schema's range, so a preview that quietly clipped at a
    // fixed length would fail at the top even if it passed at the default.
    for (const words of [1, 6, 14]) {
      const { line } = draw({ maxWordsPerCue: words });
      expect(line.textContent?.split(' ')).toHaveLength(words);
    }
  });

  it('uppercases the line only when the operator asked for it', () => {
    expect(draw({ uppercase: true }).line.textContent).toBe('THIS IS HOW YOUR CAPTIONS WILL');
    expect(draw().line.textContent).toBe('This is how your captions will');
  });

  it('puts the line where the position control says', () => {
    expect(draw({ position: 'bottom' }).frame.className).toContain('items-end');
    expect(draw({ position: 'center' }).frame.className).toContain('items-center');
    expect(draw({ position: 'top' }).frame.className).toContain('items-start');
  });

  it('drops the glyph stroke once there is a box behind the text', () => {
    // ASS BorderStyle 3 spends the outline width on padding round the box
    // rather than on a stroke round each glyph, so a preview that kept drawing
    // one would promise an edge the render will not have.
    const outlined = draw({ outlineWidth: 3, backgroundOpacity: 0 });
    expect(outlined.line.getAttribute('style')).toContain('text-shadow');
    expect(outlined.line.getAttribute('style')).not.toContain('background-color');

    const boxed = draw({ outlineWidth: 3, backgroundOpacity: 0.6 });
    expect(boxed.line.getAttribute('style')).not.toContain('text-shadow');
    expect(boxed.line.getAttribute('style')).toContain('background-color');
  });
});
