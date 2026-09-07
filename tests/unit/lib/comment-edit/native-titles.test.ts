import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const resolveAdapter = require('../../../../nle/resolve/editable-graphics.cjs');
const availableFonts = {
  'DejaVu Sans': { Bold: '/fonts/bold.ttf', Regular: '/fonts/regular.ttf' },
};
const resolveTitles = (timeline: unknown, draft: unknown, fonts: unknown = availableFonts) =>
  resolveAdapter(timeline, draft, fonts);
const premiereTitles = require('../../../../nle/premiere/editable-graphics.cjs');
const graphic = {
  kind: 'graphic',
  start: 1,
  end: 3,
  startFrame: 25,
  endFrame: 75,
  title: 'Actual title',
  subtitle: 'Actual subtitle',
  preset: {
    id: 'lower-third',
    version: 1,
    accent: '#FF0000',
    foreground: '#FFFFFF',
    background: '#000000',
  },
};
function resolveFixture(fail = false) {
  const tools: Array<{
    kind: string;
    inputs: Record<string, unknown>;
    connections: Record<string, unknown>;
    SetInput: ReturnType<typeof vi.fn>;
    ConnectInput: ReturnType<typeof vi.fn>;
  }> = [];
  const make = (kind: string) => {
    const t = {
      kind,
      inputs: {} as Record<string, unknown>,
      connections: {} as Record<string, unknown>,
      SetInput: vi.fn((key: string, value: unknown) => {
        if (fail && key === 'StyledText') return false;
        t.inputs[key] = value;
        return true;
      }),
      ConnectInput: vi.fn((key: string, source: unknown) => {
        t.connections[key] = source;
        return true;
      }),
    };
    tools.push(t);
    return t;
  };
  const comp = { AddTool: vi.fn(make), GetToolList: vi.fn(() => ({})) };
  const names: string[] = [];
  const item = {
    GetStart: () => 125,
    GetEnd: () => 175,
    GetFusionCompNameList: () => [...names],
    AddFusionComp: () => {
      names.push('new');
      return comp;
    },
    LoadFusionCompByName: vi.fn(() => comp),
    DeleteFusionCompByName: vi.fn((name: string) => {
      names.splice(names.indexOf(name), 1);
      return true;
    }),
  };
  const timeline = { GetStartFrame: () => 100, GetItemListInTrack: vi.fn(() => [item]) };
  return { timeline, item, tools, names };
}
function premiereFixture(missing = false) {
  const values: Record<string, unknown> = {};
  let disabled = false;
  let plateDisabled = false;
  let end = 50;
  const action = (fn: () => void) => fn;
  const params = [
    'Title',
    'Subtitle',
    'Accent',
    'Foreground',
    'Background',
    'Font',
    'TitleSize',
    'SubtitleSize',
  ]
    .filter((k) => !missing || k !== 'Subtitle')
    .map((key) => ({
      displayName: 'OpenFrame ' + key,
      createKeyframe: (v: unknown) => v,
      createSetValueAction: (v: unknown) =>
        action(() => {
          values[key] = v;
        }),
    }));
  const item = {
    getComponentChain: async () => ({
      getComponentCount: () => 1,
      getComponentAtIndex: () => ({
        getParamCount: () => params.length,
        getParam: (i: number) => params[i],
      }),
    }),
    createSetEndAction: (time: { seconds: number }) =>
      action(() => {
        end = time.seconds;
      }),
    getEndTime: async () => ({ seconds: end }),
    createSetDisabledAction: (value: boolean) =>
      action(() => {
        disabled = value;
      }),
  };
  const plate = {
    getStartTime: async () => ({ seconds: 1 }),
    getEndTime: async () => ({ seconds: 3 }),
    createSetDisabledAction: (value: boolean) =>
      action(() => {
        plateDisabled = value;
      }),
  };
  const project = {
    guid: 'project',
    lockedAccess: (fn: () => void) => fn(),
    executeTransaction: vi.fn((fn: (c: { addAction: (a: () => void) => void }) => void) => {
      const actions: Array<() => void> = [];
      fn({ addAction: (a) => actions.push(a) });
      actions.forEach((a) => a());
      return true;
    }),
  };
  const insert = vi.fn(async () => [item]);
  const ppro = {
    Project: { getActiveProject: async () => project },
    SequenceEditor: { getEditor: () => ({ insertMogrtFromPath: insert }) },
    TickTime: { createWithSeconds: (seconds: number) => ({ seconds }) },
    Color: class {
      constructor(
        public r: number,
        public g: number,
        public b: number,
        public a: number
      ) {}
    },
  };
  const sequence = { getVideoTrack: vi.fn(async () => ({ getTrackItems: async () => [plate] })) };
  const folder = { getEntry: vi.fn(async () => ({ nativePath: '/templates/lower-third.mogrt' })) };
  return {
    ppro,
    project,
    sequence,
    folder,
    insert,
    values,
    item,
    plate,
    getState: () => ({ disabled, plateDisabled, end }),
  };
}
describe('editable native title adapters', () => {
  it('refuses missing fonts and styles before creating any Fusion compositions', () => {
    for (const fonts of [
      {},
      { 'DejaVu Sans': { Regular: '/font.ttf' } },
      { 'DejaVu Sans': { Bold: '/font.ttf' } },
    ]) {
      const f = resolveFixture();
      expect(() => resolveTitles(f.timeline, { graphics: [graphic] }, fonts)).toThrow(
        'DejaVu Sans'
      );
      expect(f.names).toEqual([]);
      expect(f.tools).toEqual([]);
    }
  });
  it('preflights the font of a later title before converting the first', () => {
    const f = resolveFixture();
    expect(() =>
      resolveTitles(f.timeline, {
        graphics: [graphic, { ...graphic, preset: { ...graphic.preset, font: 'Roboto' } }],
      })
    ).toThrow('Roboto');
    expect(f.names).toEqual([]);
    expect(f.tools).toEqual([]);
  });
  it('uses the live TextPlus anchor controls and a fixed 1080p canvas', () => {
    const f = resolveFixture();
    resolveTitles(f.timeline, { graphics: [graphic] });
    for (const tool of f.tools.filter((t) => ['TextPlus', 'Background'].includes(t.kind))) {
      expect(tool.inputs).toMatchObject({ UseFrameFormatSettings: 0, Width: 1920, Height: 1080 });
    }
    const title = f.tools.find((t) => t.kind === 'TextPlus')!;
    expect(title.inputs).toMatchObject({
      HorizontalLeftCenterRight: -1,
      VerticalTopCenterBottom: -1,
      Size: 48 / 1920,
    });
  });

  it('keeps both rendered plates when the second MOGRT fails after the first succeeds', async () => {
    const first = premiereFixture();
    const second = premiereFixture(true);
    second.plate.getStartTime = async () => ({ seconds: 4 });
    second.plate.getEndTime = async () => ({ seconds: 5 });
    first.sequence.getVideoTrack.mockResolvedValue({
      getTrackItems: async () => [first.plate, second.plate],
    });
    first.insert.mockResolvedValueOnce([first.item]).mockResolvedValueOnce([second.item]);
    await expect(
      premiereTitles({
        ...first,
        draft: {
          graphics: [graphic, { ...graphic, start: 4, end: 5, startFrame: 100, endFrame: 125 }],
          frameRate: { num: 25, den: 1 },
        },
      })
    ).rejects.toThrow('Subtitle');
    expect(first.getState()).toEqual({ disabled: true, plateDisabled: false, end: 3 });
    expect(second.getState()).toMatchObject({ disabled: true, plateDisabled: false });
  });
  it('rolls back the first Fusion title when the second fails', () => {
    const first = resolveFixture();
    const second = resolveFixture(true);
    second.item.GetStart = () => 200;
    second.item.GetEnd = () => 225;
    const timeline = {
      GetStartFrame: () => 100,
      GetItemListInTrack: () => [first.item, second.item],
    };
    expect(() =>
      resolveTitles(timeline, {
        graphics: [graphic, { ...graphic, start: 4, end: 5, startFrame: 100, endFrame: 125 }],
      })
    ).toThrow('StyledText');
    expect(first.names).toEqual([]);
    expect(second.names).toEqual([]);
    expect(first.item.DeleteFusionCompByName).toHaveBeenCalledWith('new');
  });
  it('builds editable Fusion text/color nodes on the exact graphic carrier', () => {
    const f = resolveFixture();
    resolveTitles(f.timeline, { graphics: [graphic] });
    expect(f.timeline.GetItemListInTrack).toHaveBeenCalledWith('video', 3);
    expect(f.tools.filter((t) => t.kind === 'TextPlus').map((t) => t.inputs.StyledText)).toEqual([
      'Actual title',
      'Actual subtitle',
    ]);
    expect(f.tools.filter((t) => t.kind === 'TextPlus')[0].inputs.Center).toEqual({
      1: 128 / 1920,
      2: 1 - 844 / 1080,
    });
    expect(
      f.tools.some(
        (t) => t.kind === 'Background' && t.inputs.TopLeftRed === 1 && t.inputs.TopLeftGreen === 0
      )
    ).toBe(true);
    const connectedText: string[] = [];
    const visit = (tool: (typeof f.tools)[number]) => {
      if (tool.kind === 'TextPlus') connectedText.push(String(tool.inputs.StyledText));
      Object.values(tool.connections).forEach((t) => visit(t as typeof tool));
    };
    visit(f.tools.find((t) => t.kind === 'MediaOut')!);
    expect(connectedText).toEqual(['Actual title', 'Actual subtitle']);
    expect(f.item.LoadFusionCompByName).toHaveBeenCalledWith('new');
    expect(f.names).toEqual(['new']);
  });
  it('rolls back created Fusion comps on failure and refuses mismatched timing before mutation', () => {
    const f = resolveFixture(true);
    expect(() => resolveTitles(f.timeline, { graphics: [graphic] })).toThrow('StyledText');
    expect(f.names).toEqual([]);
    expect(f.item.DeleteFusionCompByName).toHaveBeenCalledWith('new');
    const timing = resolveFixture();
    expect(() =>
      resolveTitles(timing.timeline, { graphics: [{ ...graphic, startFrame: 26 }] })
    ).toThrow('timing');
    expect(timing.names).toEqual([]);
  });
  it('sets MOGRT controls and duration before disabling the rendered plate', async () => {
    const f = premiereFixture();
    await premiereTitles({ ...f, draft: { graphics: [graphic], frameRate: { num: 25, den: 1 } } });
    expect(f.folder.getEntry).toHaveBeenCalledWith('lower-third.mogrt');
    expect(f.insert).toHaveBeenCalledWith('/templates/lower-third.mogrt', { seconds: 1 }, 3, 2);
    expect(f.values).toMatchObject({
      Title: 'Actual title',
      Subtitle: 'Actual subtitle',
      Font: 'DejaVu Sans',
      TitleSize: 48,
      SubtitleSize: 32,
      Accent: { r: 1, g: 0, b: 0, a: 1 },
    });
    expect(f.getState()).toEqual({ disabled: false, plateDisabled: true, end: 3 });
  });
  it('hides an incomplete MOGRT and leaves the rendered plate enabled', async () => {
    const f = premiereFixture(true);
    await expect(
      premiereTitles({ ...f, draft: { graphics: [graphic], frameRate: { num: 25, den: 1 } } })
    ).rejects.toThrow('Subtitle');
    expect(f.getState()).toMatchObject({ disabled: true, plateDisabled: false });
  });
});
