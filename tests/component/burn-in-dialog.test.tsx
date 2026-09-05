import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { BurnInDialog } from '@/components/video-page/burn-in-dialog';
import { burnInStyleSchema, type BurnInStyle } from '@/lib/rough-cut/subtitle-style';

const TRACKS = [
  { id: 'sub-tr', language: 'tr', label: 'Turkish', canDelete: true },
  { id: 'sub-en', language: 'en', label: 'English', canDelete: true },
];

/**
 * The defaults and bounds the API answers with, written out by hand rather than
 * read off the schema: this is the contract the dialog is being held to, and a
 * schema change that moves it is meant to show up here as a failing test rather
 * than as a slider that silently starts offering a value the route refuses.
 */
const API_DEFAULTS = {
  font: 'dejavu-sans',
  fontSize: 48,
  textColor: '#FFFFFF',
  outlineColor: '#000000',
  outlineWidth: 2,
  backgroundOpacity: 0,
  position: 'bottom',
  marginVertical: 60,
  bold: true,
  uppercase: false,
  maxWordsPerCue: 6,
  maxCueSeconds: 4,
  playbackRate: 1,
};

const onStart = vi.fn<(style: Partial<BurnInStyle>, subtitleId?: string) => Promise<string | null>>(
  async () => null
);

function renderDialog(overrides: Partial<ComponentProps<typeof BurnInDialog>> = {}) {
  return render(
    <BurnInDialog
      open
      onOpenChange={vi.fn()}
      onStart={onStart}
      starting={false}
      canStart
      subtitles={TRACKS}
      {...overrides}
    />
  );
}

function slider(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

describe('BurnInDialog', () => {
  beforeEach(() => {
    onStart.mockClear();
  });

  it('offers each numeric control across exactly the range the API accepts', () => {
    renderDialog();

    const expected: Array<[string, number, number, number]> = [
      // label, min, max, default
      ['Font size', 16, 120, 48],
      ['Outline width', 0, 6, 2],
      ['Box behind text', 0, 1, 0],
      ['Vertical margin', 0, 400, 60],
      ['Caption speed: fewer words = faster changes', 1, 14, 6],
      ['Longest caption', 0.5, 10, 4],
    ];

    for (const [label, min, max, value] of expected) {
      const input = slider(label);
      expect(input.min, label).toBe(String(min));
      expect(input.max, label).toBe(String(max));
      expect(input.value, label).toBe(String(value));
    }
  });

  it('sends the whole style with the operator changes, and no track for the transcript', async () => {
    renderDialog();

    fireEvent.change(slider('Font size'), { target: { value: '56' } });
    fireEvent.change(slider('Box behind text'), { target: { value: '0.6' } });
    await userEvent.click(screen.getByLabelText('UPPERCASE'));
    await userEvent.click(screen.getByRole('button', { name: /Burn in/ }));

    expect(onStart).toHaveBeenCalledTimes(1);
    const [style, subtitleId] = onStart.mock.calls[0]!;
    expect(style).toEqual({
      ...API_DEFAULTS,
      fontSize: 56,
      backgroundOpacity: 0.6,
      uppercase: true,
    });
    // Nothing sent: the route resolves the version's own transcript.
    expect(subtitleId).toBeUndefined();
    // And whatever the sliders produced has to survive the route's own parse.
    expect(burnInStyleSchema.safeParse(style).success).toBe(true);
  });

  it('sends the id of the caption track the operator picked', async () => {
    renderDialog();

    await userEvent.click(screen.getByRole('combobox', { name: 'Caption source' }));
    await userEvent.click(screen.getByRole('option', { name: 'Turkish (tr)' }));
    await userEvent.click(screen.getByRole('button', { name: /Burn in/ }));

    expect(onStart.mock.calls[0]?.[1]).toBe('sub-tr');
  });

  it('shows the message a refused start returned', async () => {
    onStart.mockResolvedValueOnce('A burn-in is already running for this version');
    renderDialog();

    await userEvent.click(screen.getByRole('button', { name: /Burn in/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A burn-in is already running for this version'
    );
  });

  it('refuses to start, with the reason, when the version has no file to burn into', async () => {
    renderDialog({ canStart: false });

    const button = screen.getByRole('button', { name: /Burn in/ });
    expect(button).toBeDisabled();
    expect(
      screen.getByText('Subtitles can only be burned into an uploaded video file.')
    ).toBeVisible();

    await userEvent.click(button);
    expect(onStart).not.toHaveBeenCalled();
  });
});
