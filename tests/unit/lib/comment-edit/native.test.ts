import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { buildNativeEditPackage } from '@/lib/comment-edit/native';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as {
  JSDOM: new (xml: string, options: { contentType: string }) => { window: { document: Document } };
};
const native = require('../../../../nle/core/native-edit.cjs');
const importResolve = require('../../../../nle/resolve/import-draft.cjs');
const importPremiere = require('../../../../nle/premiere/import-draft.cjs');
const media = ['source', 'cover', 'draft'].map((versionId) => ({
  versionId,
  title: versionId,
  fileName: `${versionId}.mp4`,
  duration: 10,
  downloadPath: `/api/v1/comments/comment/edit-draft?source=${versionId}`,
}));
function draft() {
  return buildNativeEditPackage({
    id: 'run1',
    name: 'Cut <one>',
    outputVersionId: 'draft',
    media,
    decisions: {
      version: 1,
      rate: { num: 25, den: 1, dropFrame: false },
      clips: [],
      edits: [
        {
          sourceVersionId: 'source',
          cameraRole: 'A',
          targetTrack: 1,
          timelineStartSeconds: 0,
          timelineEndSeconds: 3,
          inSeconds: 2,
          outSeconds: 5,
        },
      ],
      effects: [
        {
          kind: 'broll',
          start: 1,
          end: 2,
          sourceVersionId: 'cover',
          sourceIn: 4,
          preset: 'cover-muted-v1',
        },
        {
          kind: 'graphic',
          start: 1,
          end: 2,
          title: 'Hi',
          subtitle: '',
          preset: {
            id: 'lower-third',
            version: 1,
            name: 'Brand',
            accent: '#000000',
            foreground: '#FFFFFF',
            background: '#000000',
          },
        },
      ],
    },
  });
}
afterEach(() => vi.unstubAllGlobals());

describe('native editing package', () => {
  it('boots the registered Resolve workflow module and releases it on exit', async () => {
    const resolve = { GetProjectManager: vi.fn() };
    const workflow = {
      Initialize: vi.fn(() => true),
      GetResolve: vi.fn(() => resolve),
      CleanUp: vi.fn(),
    };
    const events = new Map<string, () => void>();
    const handlers = new Map<string, unknown>();
    const app = {
      resolve: undefined as unknown,
      whenReady: () => Promise.resolve(),
      on: (event: string, callback: () => void) => events.set(event, callback),
    };
    const loaded = vi.fn(async () => undefined);
    const folder = join(process.cwd(), 'nle/resolve');
    const manifest = new JSDOM(readFileSync(join(folder, 'manifest.xml'), 'utf8'), {
      contentType: 'text/xml',
    }).window.document;
    const entry = manifest.querySelector('FilePath')!.textContent!;
    const packageJson = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
    expect(packageJson.type).toBe('commonjs');
    expect(packageJson.main).toBe(entry);
    runInNewContext(readFileSync(join(folder, entry), 'utf8'), {
      __dirname: folder,
      console,
      require: (name: string) => {
        if (name === 'electron')
          return {
            app,
            BrowserWindow: class {
              loadFile = loaded;
            },
            ipcMain: {
              handle: (channel: string, handler: unknown) => handlers.set(channel, handler),
            },
            dialog: {},
          };
        if (name === './WorkflowIntegration.node') return workflow;
        if (name === './nle-core.cjs' || name === './import-draft.cjs') return {};
        return require(name);
      },
    });
    await vi.waitFor(() => expect(handlers.has('import-ai-draft')).toBe(true));
    expect(workflow.Initialize).toHaveBeenCalledWith('com.ascensore.openframe');
    expect(manifest.querySelector('Id')!.textContent).toBe('com.ascensore.openframe');
    expect(app.resolve).toBe(resolve);
    expect(loaded).toHaveBeenCalledWith(join(folder, 'index.html'));
    events.get('before-quit')!();
    expect(workflow.CleanUp).toHaveBeenCalledOnce();
  });

  it('uses source frame rates for media trims and the timeline rate for placement', () => {
    const source = draft();
    const modified = buildNativeEditPackage({
      id: 'mixed',
      name: 'Mixed rates',
      outputVersionId: 'draft',
      media: source.media.map((m) => ({
        ...m,
        frameRateNum: m.versionId === 'source' ? 30 : 25,
        frameRateDen: 1,
      })),
      decisions: {
        version: 1,
        rate: { num: 25, den: 1, dropFrame: false },
        clips: [],
        edits: [
          {
            sourceVersionId: 'source',
            cameraRole: 'A',
            targetTrack: 1,
            timelineStartSeconds: 0,
            timelineEndSeconds: 3,
            inSeconds: 2,
            outSeconds: 5,
          },
        ],
      },
    });
    const doc = new JSDOM(modified.xml, { contentType: 'text/xml' }).window.document;
    const clip = doc.querySelector('sequence > media > video > track > clipitem')!;
    expect(
      ['start', 'end', 'in', 'out'].map((key) => clip.querySelector(key)?.textContent)
    ).toEqual(['0', '75', '60', '150']);
    expect(clip.querySelector('rate > timebase')?.textContent).toBe('30');
  });
  it('exports editable video and stereo speech with B-roll and pinned graphic composites on higher tracks', () => {
    const result = draft();
    const doc = new JSDOM(result.xml, { contentType: 'text/xml' }).window.document;
    expect(doc.querySelector('sequence > name')?.textContent).toBe('Cut <one> [OpenFrame run1]');
    const tracks = [...doc.querySelectorAll('sequence > media > video > track')];
    expect(tracks).toHaveLength(3);
    expect(
      tracks.map((t) =>
        ['start', 'end', 'in', 'out'].map(
          (key) => t.querySelector(`clipitem > ${key}`)?.textContent
        )
      )
    ).toEqual([
      ['0', '75', '50', '125'],
      ['25', '50', '100', '125'],
      ['25', '50', '25', '50'],
    ]);
    expect(tracks[2].querySelector('file > name')?.textContent).toBe('draft.mp4');
    const audio = [...doc.querySelectorAll('sequence > media > audio > track')];
    expect(audio).toHaveLength(2);
    expect(audio.map((t) => t.querySelector('sourcetrack > trackindex')?.textContent)).toEqual([
      '1',
      '2',
    ]);
    expect(audio.every((t) => t.querySelector('clipitem > name')?.textContent === 'draft')).toBe(
      true
    );
    expect(
      audio.map((t) => [
        t.querySelector('clipitem > in')?.textContent,
        t.querySelector('clipitem > out')?.textContent,
      ])
    ).toEqual([
      ['0', '75'],
      ['0', '75'],
    ]);
  });
  it('keeps standalone panel helpers identical and only accepts same-endpoint source downloads', () => {
    const core = readFileSync(join(process.cwd(), 'nle/core/native-edit.cjs'), 'utf8');
    expect(readFileSync(join(process.cwd(), 'nle/resolve/native-edit.cjs'), 'utf8')).toBe(core);
    expect(readFileSync(join(process.cwd(), 'nle/premiere/native-edit.cjs'), 'utf8')).toBe(core);
    expect(native.validateDraft(draft(), 'comment').id).toBe('run1');
    expect(() =>
      native.validateDraft(
        { ...draft(), media: [{ ...media[0], downloadPath: 'https://foreign.test/steal' }] },
        'comment'
      )
    ).toThrow('download location');
    expect(() =>
      native.validateDraft(
        { ...draft(), media: [{ ...media[0], fileName: '../escape.mp4' }] },
        'comment'
      )
    ).toThrow('filename');
    const xml = native.relocateXml(draft(), '/Users/editor/Project & media');
    expect(xml).toContain('file://localhost/Users/editor/Project%20%26%20media/source.mp4');
    expect(xml).not.toContain('OPENFRAME_MEDIA');
  });
  it('assembles bounded media chunks and refuses short responses before writing them', async () => {
    const write = vi
      .fn<(bytes: ArrayBuffer, append: boolean) => Promise<void>>()
      .mockResolvedValue(undefined);
    const fetchRange = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array(16 * 1024 * 1024), {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-16777215/16777219', etag: '"same"' },
        })
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 206,
          headers: { 'Content-Range': 'bytes 16777216-16777218/16777219', etag: '"same"' },
        })
      );
    expect(await native.downloadChunks(fetchRange, write)).toBe(16777219);
    expect(write.mock.calls.map((c) => c[1])).toEqual([false, true]);
    expect(fetchRange.mock.calls[1]).toEqual([16777216, 33554431, '"same"']);
    write.mockClear();
    await expect(
      native.downloadChunks(
        async () =>
          new Response(new Uint8Array([1]), {
            status: 206,
            headers: { 'Content-Range': 'bytes 0-2/3' },
          }),
        write
      )
    ).rejects.toThrow('Incomplete');
    expect(write).not.toHaveBeenCalled();
  });
  it('rejects changed source identity across chunks', async () => {
    const fetchRange = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array(16 * 1024 * 1024), {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-16777215/16777217', etag: '"one"' },
        })
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), {
          status: 206,
          headers: { 'Content-Range': 'bytes 16777216-16777216/16777217', etag: '"two"' },
        })
      );
    await expect(native.downloadChunks(fetchRange, async () => {})).rejects.toThrow('changed');
  });
});

describe('native editor import execution', () => {
  function stubDownloads() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('?source=')
          ? new Response(new Uint8Array([1, 2]), {
              status: 206,
              headers: { 'Content-Range': 'bytes 0-1/2' },
            })
          : new Response(JSON.stringify({ data: { draft: draft() } }), { status: 200 })
      )
    );
  }
  it('imports a new Resolve timeline from downloaded media and leaves the existing timeline intact', async () => {
    stubDownloads();
    const directory = mkdtempSync(join(tmpdir(), 'of-native-test-'));
    const timeline = {};
    const importTimeline = vi
      .fn<(path: string, options: unknown) => object>()
      .mockReturnValue(timeline);
    const setCurrent = vi.fn();
    const original = { GetName: () => 'Original' };
    const project = {
      GetUniqueId: () => 'project',
      GetTimelineCount: () => 1,
      GetTimelineByIndex: () => original,
      GetMediaPool: () => ({ ImportTimelineFromFile: importTimeline }),
      SetCurrentTimeline: setCurrent,
    };
    try {
      await importResolve({
        resolve: { GetProjectManager: () => ({ GetCurrentProject: () => project }) },
        chooseDirectory: async () => directory,
        baseUrl: 'https://review.test',
        token: 'token',
        commentId: 'comment',
      });
      expect(importTimeline).toHaveBeenCalledTimes(1);
      const xml = readFileSync(importTimeline.mock.calls[0][0], 'utf8');
      expect(xml).toContain('<in>50</in><out>125</out>');
      expect(xml).not.toContain('OPENFRAME_MEDIA');
      expect(setCurrent).toHaveBeenCalledWith(timeline);
      expect(original.GetName()).toBe('Original');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('does not import the same Resolve draft twice', async () => {
    stubDownloads();
    const choose = vi.fn();
    const project = {
      GetUniqueId: () => 'p',
      GetTimelineCount: () => 1,
      GetTimelineByIndex: () => ({ GetName: () => draft().name }),
    };
    const result = await importResolve({
      resolve: { GetProjectManager: () => ({ GetCurrentProject: () => project }) },
      chooseDirectory: choose,
      baseUrl: 'https://review.test',
      token: 'token',
      commentId: 'comment',
    });
    expect(result.message).toContain('already imported');
    expect(choose).not.toHaveBeenCalled();
  });
  it('does not import into a different Resolve project if the editor switches while downloading', async () => {
    stubDownloads();
    const directory = mkdtempSync(join(tmpdir(), 'of-native-switch-'));
    const importTimeline = vi.fn();
    const project = {
      GetUniqueId: () => 'original',
      GetTimelineCount: () => 0,
      GetMediaPool: () => ({ ImportTimelineFromFile: importTimeline }),
    };
    const manager = {
      GetCurrentProject: vi
        .fn()
        .mockReturnValueOnce(project)
        .mockReturnValue({ GetUniqueId: () => 'different' }),
    };
    try {
      await expect(
        importResolve({
          resolve: { GetProjectManager: () => manager },
          chooseDirectory: async () => directory,
          baseUrl: 'https://review.test',
          token: 'token',
          commentId: 'comment',
        })
      ).rejects.toThrow('project changed');
      expect(importTimeline).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('does not call Resolve when any media download fails', async () => {
    stubDownloads();
    const fetchMock = vi.mocked(fetch);
    const valid = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) =>
      String(input).includes('?source=cover')
        ? new Response('refused', { status: 403 })
        : valid(input, init)
    );
    const directory = mkdtempSync(join(tmpdir(), 'of-native-fail-'));
    const importTimeline = vi.fn();
    const project = {
      GetUniqueId: () => 'original',
      GetTimelineCount: () => 0,
      GetMediaPool: () => ({ ImportTimelineFromFile: importTimeline }),
    };
    try {
      await expect(
        importResolve({
          resolve: { GetProjectManager: () => ({ GetCurrentProject: () => project }) },
          chooseDirectory: async () => directory,
          baseUrl: 'https://review.test',
          token: 'token',
          commentId: 'comment',
        })
      ).rejects.toThrow('HTTP 403');
      expect(importTimeline).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('uses the documented Premiere import API and verifies a new sequence was created', async () => {
    stubDownloads();
    const writes: Record<string, unknown[]> = {};
    const directory = {
      nativePath: '/media/draft',
      createFile: async (name: string) => ({
        nativePath: `/media/draft/${name}`,
        write: async (bytes: unknown) => {
          (writes[name] ??= []).push(bytes);
        },
      }),
    };
    const project = {
      guid: 'p',
      getSequences: vi
        .fn()
        .mockResolvedValueOnce([{ name: 'Original' }])
        .mockResolvedValueOnce([{ name: 'Original' }, { name: draft().name }]),
      getInsertionBin: async () => 'bin',
      importFiles: vi.fn(async () => true),
    };
    const result = await importPremiere({
      ppro: { Project: { getActiveProject: async () => project } },
      storage: {
        formats: { binary: 'binary' },
        localFileSystem: { getFolder: async () => ({ createFolder: async () => directory }) },
      },
      baseUrl: 'https://review.test',
      token: 'token',
      commentId: 'comment',
      progress: () => {},
    });
    expect(project.importFiles).toHaveBeenCalledWith(
      ['/media/draft/draft.xml'],
      true,
      'bin',
      false
    );
    expect(writes['source.mp4'][0]).toEqual(new Uint8Array([1, 2]).buffer);
    expect(writes['draft.xml'][0]).toContain('file://localhost/media/draft/source.mp4');
    expect(result).toContain('Imported a new AI draft sequence');
  });
  it.each(['download', 'project', 'sequence'])(
    'refuses a Premiere import when %s validation fails',
    async (failure) => {
      stubDownloads();
      if (failure === 'download') {
        const fetchMock = vi.mocked(fetch);
        const valid = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(async (input, init) =>
          String(input).includes('?source=cover')
            ? new Response('refused', { status: 403 })
            : valid(input, init)
        );
      }
      const directory = {
        nativePath: '/media/draft',
        createFile: async (name: string) => ({
          nativePath: `/media/draft/${name}`,
          write: async () => {},
        }),
      };
      const project = {
        guid: 'original',
        getSequences: vi.fn().mockResolvedValue([{ name: 'Original' }]),
        getInsertionBin: async () => 'bin',
        importFiles: vi.fn(async () => true),
      };
      const getActiveProject = vi
        .fn()
        .mockResolvedValueOnce(project)
        .mockResolvedValue(failure === 'project' ? { guid: 'different' } : project);
      await expect(
        importPremiere({
          ppro: { Project: { getActiveProject } },
          storage: {
            formats: { binary: 'binary' },
            localFileSystem: { getFolder: async () => ({ createFolder: async () => directory }) },
          },
          baseUrl: 'https://review.test',
          token: 'token',
          commentId: 'comment',
          progress: () => {},
        })
      ).rejects.toThrow(
        failure === 'download'
          ? 'HTTP 403'
          : failure === 'project'
            ? 'project changed'
            : 'expected sequence'
      );
      expect(project.importFiles).toHaveBeenCalledTimes(failure === 'sequence' ? 1 : 0);
    }
  );
});
