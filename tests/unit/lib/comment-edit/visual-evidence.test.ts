import { beforeEach, describe, it, expect, vi } from 'vitest';
import { loadBrollImages } from '@/lib/comment-edit/visual-evidence';
import { createAiSdkAgentModel } from '@/lib/agents/ai-sdk-model';
import type { CommentEditSnapshot } from '@/lib/comment-edit/plan';
import type { AgentContext } from '@/lib/agents/types';
const { findMany, readBytes, generateText } = vi.hoisted(() => ({
  findMany: vi.fn(),
  readBytes: vi.fn(),
  generateText: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db: { videoVersion: { findMany } } }));
vi.mock('@/lib/r2', () => ({ readVideoObjectBytes: readBytes }));
vi.mock('ai', () => ({ generateText, Output: { object: vi.fn() } }));
const evidence = {
  version: 1,
  frames: [0, 1, 2].map((i) => ({
    key: 'videos/broll-evidence/asset/generation/' + i + '.jpg',
    seconds: i + 1,
  })),
};
const snapshot = {
  assets: [{ versionId: 'asset', visualEvidence: evidence }],
} as CommentEditSnapshot;
beforeEach(() => {
  findMany.mockReset().mockResolvedValue([{ id: 'asset' }]);
  readBytes.mockReset().mockResolvedValue(new Uint8Array([255, 216, 255, 217]));
  generateText.mockReset().mockResolvedValue({ output: { version: 1, operations: [] } });
});
describe('visual planning evidence', () => {
  it('loads only snapshotted same-project frames and labels their source times in the AI request', async () => {
    readBytes
      .mockResolvedValueOnce(new Uint8Array([255, 216, 0, 255, 217]))
      .mockResolvedValueOnce(new Uint8Array([255, 216, 1, 255, 217]))
      .mockResolvedValueOnce(new Uint8Array([255, 216, 2, 255, 217]));
    const images = await loadBrollImages(snapshot, 'project');
    expect(images.map((i) => [i.versionId, i.seconds])).toEqual([
      ['asset', 1],
      ['asset', 2],
      ['asset', 3],
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['asset'] }, providerId: 'r2', video: { projectId: 'project' } },
      })
    );
    expect(readBytes.mock.calls.map((c) => c[0])).toEqual([
      'videos/broll-evidence/asset/generation/0.jpg',
      'videos/broll-evidence/asset/generation/1.jpg',
      'videos/broll-evidence/asset/generation/2.jpg',
    ]);
    await createAiSdkAgentModel('test').generateEditPlan({
      system: 'Edit',
      context: {} as AgentContext,
      images,
    });
    const request = generateText.mock.calls[0][0];
    expect(request.prompt).toBeUndefined();
    expect(request.messages[0].content.filter((p: { type: string }) => p.type === 'image')).toEqual(
      [
        { type: 'image', mediaType: 'image/jpeg', image: new Uint8Array([255, 216, 0, 255, 217]) },
        { type: 'image', mediaType: 'image/jpeg', image: new Uint8Array([255, 216, 1, 255, 217]) },
        { type: 'image', mediaType: 'image/jpeg', image: new Uint8Array([255, 216, 2, 255, 217]) },
      ]
    );
    expect(request.messages[0].content).toContainEqual({
      type: 'text',
      text: 'Sampled source frame: asset at 2 seconds',
    });
  });
  it('refuses moved sources, forged object keys, and truncated or oversized bytes before model use', async () => {
    findMany.mockResolvedValue([]);
    await expect(loadBrollImages(snapshot, 'other')).rejects.toThrow('no longer available');
    expect(readBytes).not.toHaveBeenCalled();
    findMany.mockResolvedValue([{ id: 'asset' }]);
    const forged = {
      assets: [
        {
          versionId: 'asset',
          visualEvidence: {
            ...evidence,
            frames: evidence.frames.map((f) => ({
              ...f,
              key: f.key.replace('/asset/', '/foreign/'),
            })),
          },
        },
      ],
    } as CommentEditSnapshot;
    await expect(loadBrollImages(forged, 'project')).rejects.toThrow('Invalid visual');
    expect(readBytes).not.toHaveBeenCalled();
    for (const bytes of [null, new Uint8Array([255, 216, 0, 0]), new Uint8Array(262145)]) {
      readBytes.mockResolvedValue(bytes);
      await expect(loadBrollImages(snapshot, 'project')).rejects.toThrow('unavailable');
    }
  });
});
