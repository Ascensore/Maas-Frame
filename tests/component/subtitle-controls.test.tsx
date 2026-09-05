import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import {
  SubtitleControls,
  isPlayerSubtitleUpload,
} from '@/components/video-page/subtitle-controls';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const noopUpload = vi.fn(async () => null);
const noopDelete = vi.fn(async () => null);
const noopGenerate = vi.fn(async () => null);

function renderControls(overrides: Partial<ComponentProps<typeof SubtitleControls>> = {}) {
  return render(
    <SubtitleControls
      subtitles={[]}
      activeSubtitleLanguage={null}
      onSelectSubtitleLanguage={vi.fn()}
      canManageSubtitles
      canGenerateSubtitles
      alwaysShow
      onUploadSubtitle={noopUpload}
      onDeleteSubtitle={noopDelete}
      onGenerateSubtitles={noopGenerate}
      isUploadingSubtitle={false}
      isGeneratingSubtitles={false}
      {...overrides}
    />
  );
}

describe('isPlayerSubtitleUpload', () => {
  it('accepts caption and transcript text files and rejects other names', () => {
    expect(isPlayerSubtitleUpload('cut.en.srt')).toBe(true);
    expect(isPlayerSubtitleUpload('cut.vtt')).toBe(true);
    expect(isPlayerSubtitleUpload('script.txt')).toBe(true);
    expect(isPlayerSubtitleUpload('script.docx')).toBe(true);
    expect(isPlayerSubtitleUpload('poster.png')).toBe(false);
    expect(isPlayerSubtitleUpload('clip.mp4')).toBe(false);
    expect(isPlayerSubtitleUpload('track.ass')).toBe(false);
    expect(isPlayerSubtitleUpload('cut.srt.exe')).toBe(false);
  });
});

describe('SubtitleControls', () => {
  beforeEach(() => {
    noopUpload.mockClear();
    noopDelete.mockClear();
    noopGenerate.mockClear();
  });

  it('shows Upload file and Generate AI on the player without opening a menu', () => {
    renderControls();

    expect(screen.getByRole('button', { name: 'Upload file' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Generate AI' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Captions' })).toBeVisible();
  });

  it('hides upload and generate for a viewer who cannot manage captions', async () => {
    const user = userEvent.setup();
    renderControls({ canManageSubtitles: false, alwaysShow: true });

    expect(screen.queryByRole('button', { name: 'Upload file' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate AI' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Captions' }));
    expect(screen.queryByRole('menuitem', { name: 'Upload text file' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Generate with AI' })).not.toBeInTheDocument();
  });

  it('offers burn-in in the menu only when the page passes a handler', async () => {
    const user = userEvent.setup();
    const onBurnIn = vi.fn();
    const { unmount } = renderControls({ onBurnIn });

    await user.click(screen.getByRole('button', { name: 'Captions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Burn subtitles into a new version' }));
    expect(onBurnIn).toHaveBeenCalledTimes(1);
    unmount();

    renderControls();
    await user.click(screen.getByRole('button', { name: 'Captions' }));
    expect(
      screen.queryByRole('menuitem', { name: 'Burn subtitles into a new version' })
    ).not.toBeInTheDocument();
  });

  it('hides burn-in from a viewer who cannot manage captions', async () => {
    const user = userEvent.setup();
    const onBurnIn = vi.fn();
    renderControls({ onBurnIn, canManageSubtitles: false, alwaysShow: true });

    await user.click(screen.getByRole('button', { name: 'Captions' }));
    expect(
      screen.queryByRole('menuitem', { name: 'Burn subtitles into a new version' })
    ).not.toBeInTheDocument();
  });

  it('disables burn-in and says so while one is running', async () => {
    const user = userEvent.setup();
    const onBurnIn = vi.fn();
    renderControls({ onBurnIn, burnInRunning: true });

    await user.click(screen.getByRole('button', { name: 'Captions' }));
    const item = screen.getByRole('menuitem', { name: 'Burning in…' });
    expect(item).toHaveAttribute('aria-disabled', 'true');

    await user.click(item);
    expect(onBurnIn).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('menuitem', { name: 'Burn subtitles into a new version' })
    ).not.toBeInTheDocument();
  });

  it('opens a generate dialog whose confirm button starts AI subtitles', async () => {
    const user = userEvent.setup();
    renderControls();

    await user.click(screen.getByRole('button', { name: 'Generate AI' }));
    expect(screen.getByRole('heading', { name: 'Generate subtitles with AI' })).toBeVisible();

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Turkish' }));
    await user.click(screen.getByRole('button', { name: 'Generate subtitles' }));
    expect(noopGenerate).toHaveBeenCalledWith('tr');
  });
});
