import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoDragDropUploader, VideoUploadProvider } from '@/components/video-drag-drop-uploader';
import { cleanupPendingProjectUpload, uploadProjectVideo } from '@/lib/client/project-video-upload';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/client/project-video-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/client/project-video-upload')>()),
  uploadProjectVideo: vi.fn(),
  cleanupPendingProjectUpload: vi.fn(),
}));

describe('persistent upload cancellation', () => {
  beforeEach(() => {
    vi.mocked(uploadProjectVideo).mockReset();
    vi.mocked(cleanupPendingProjectUpload).mockReset();
  });
  it('allows a new queue after cancelling a stalled transfer and ignores callbacks from the old queue', async () => {
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    vi.mocked(uploadProjectVideo)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecond = resolve;
          })
      );
    render(
      <VideoUploadProvider>
        <VideoDragDropUploader
          fixedProjectId="project"
          fixedProjectName="Project"
          canUpload
          showBinPicker
        />
      </VideoUploadProvider>
    );
    const picker = await screen.findByLabelText('Upload source files');
    fireEvent.change(picker, {
      target: {
        files: [
          new File(['one'], 'First.mp4', { type: 'video/mp4' }),
          new File(['queued'], 'Queued.mp4', { type: 'video/mp4' }),
        ],
      },
    });
    await waitFor(() => expect(uploadProjectVideo).toHaveBeenCalledTimes(1));
    const firstOptions = vi.mocked(uploadProjectVideo).mock.calls[0]![2];
    fireEvent.click(screen.getByRole('button', { name: 'Cancel upload' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Cancel upload',
      })
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    fireEvent.change(picker, {
      target: { files: [new File(['two'], 'Second.mp4', { type: 'video/mp4' })] },
    });
    await waitFor(() => expect(uploadProjectVideo).toHaveBeenCalledTimes(2));
    expect(firstOptions.isCancelled?.()).toBe(true);
    await act(async () => {
      firstOptions.onStatus?.('Old transfer');
      finishFirst();
    });
    expect(screen.queryByText(/Old transfer/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue editing' })).toBeInTheDocument();
    expect(picker).toBeDisabled();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    expect(screen.getByText('Second.mp4', { exact: true })).toBeInTheDocument();
    expect(uploadProjectVideo).toHaveBeenCalledTimes(2); // The cancelled queue's second file never starts.
    await act(async () => {
      finishSecond();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

it('keeps the queue locked until cancellation cleanup completes even if the transfer settles first', async () => {
  vi.mocked(uploadProjectVideo).mockReset();
  let finishUpload!: () => void;
  let finishCleanup!: () => void;
  vi.mocked(uploadProjectVideo).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishUpload = resolve;
      })
  );
  vi.mocked(cleanupPendingProjectUpload).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishCleanup = resolve;
      })
  );
  render(
    <VideoUploadProvider>
      <VideoDragDropUploader
        fixedProjectId="project"
        fixedProjectName="Project"
        canUpload
        showBinPicker
      />
    </VideoUploadProvider>
  );
  const picker = await screen.findByLabelText('Upload source files');
  fireEvent.change(picker, {
    target: { files: [new File(['one'], 'First.mp4', { type: 'video/mp4' })] },
  });
  await waitFor(() => expect(uploadProjectVideo).toHaveBeenCalledTimes(1));
  act(() => {
    vi.mocked(uploadProjectVideo).mock.calls[0]![2].onPendingUpload?.({
      type: 'bunny',
      videoId: 'old-video',
      uploadToken: 'test-token',
    });
  });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel upload' }));
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Cancel upload',
    })
  );
  await waitFor(() =>
    expect(cleanupPendingProjectUpload).toHaveBeenCalledWith(
      'project',
      expect.objectContaining({ videoId: 'old-video', uploadToken: 'test-token' })
    )
  );
  await act(async () => {
    finishUpload();
  });
  expect(picker).toBeDisabled();
  await act(async () => {
    finishCleanup();
  });
  expect(picker).not.toBeDisabled();
});
