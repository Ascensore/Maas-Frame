import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EditPresetLibrary } from '@/components/video-page/edit-preset-library';
import { GRAPHIC_PRESETS } from '@/lib/rough-cut/effects';
afterEach(() => vi.unstubAllGlobals());
describe('preset library controls', () => {
  it('updates the selected custom revision and archives it without adding a duplicate', async () => {
    const preset = { ...GRAPHIC_PRESETS[0], id: 'custom', version: 2, name: 'Saved brand' };
    const fetch = vi.fn<(url: string, init: { method: string; body: string }) => Promise<Response>>(
      async (_url, init) => {
        void _url;
        return new Response(
          JSON.stringify({
            data: { preset: { ...preset, version: 3 }, archived: init.method === 'DELETE' },
          })
        );
      }
    );
    vi.stubGlobal('fetch', fetch);
    const onSelect = vi.fn();
    const props = {
      library: {
        workspaceId: 'workspace',
        canManagePresets: true,
        presets: [...GRAPHIC_PRESETS, preset],
        assets: [],
      },
      selected: 'custom',
      onSelect,
    };
    render(<EditPresetLibrary {...props} />);
    fireEvent.click(screen.getByText('Customize workspace presets'));
    fireEvent.click(screen.getByText('Update preset'));
    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'custom', version: 3 }))
    );
    expect(fetch.mock.calls[0][1].method).toBe('PATCH');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ id: 'custom', revision: 2 });
    expect(screen.getAllByRole('option', { name: 'Saved brand' })).toHaveLength(1);
    fireEvent.click(screen.getByText('Customize workspace presets'));
    fireEvent.click(screen.getByText('Archive preset'));
    await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith());
    expect(fetch.mock.calls[1][1].method).toBe('DELETE');
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ id: 'custom', revision: 3 });
    expect(screen.queryByRole('option', { name: 'Saved brand' })).not.toBeInTheDocument();
  });
  it('saves a reusable custom preset and selects the persisted revision', async () => {
    const preset = { ...GRAPHIC_PRESETS[0], id: 'saved', version: 1, name: 'Client brand' };
    const fetch = vi.fn<(url: string, init: { body: string }) => Promise<Response>>(
      async () => new Response(JSON.stringify({ data: { preset } }), { status: 201 })
    );
    vi.stubGlobal('fetch', fetch);
    const onSelect = vi.fn();
    render(
      <EditPresetLibrary
        library={{
          workspaceId: 'workspace',
          canManagePresets: true,
          presets: GRAPHIC_PRESETS,
          assets: [],
        }}
        selected=""
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByText('Customize workspace presets'));
    fireEvent.change(screen.getByLabelText('Preset name'), { target: { value: 'Client brand' } });
    fireEvent.click(screen.getByText('Save as new preset'));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(preset));
    expect(fetch).toHaveBeenCalledWith(
      '/api/workspaces/workspace/edit-presets',
      expect.objectContaining({ method: 'POST' })
    );
    expect(JSON.parse(fetch.mock.calls[0][1]!.body)).toMatchObject({
      name: 'Client brand',
      template: 'lower-third',
    });
  });
  it('keeps failed edits visible and never exposes management to a non-manager', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Preset changed' }), { status: 409 }))
    );
    const props = {
      library: {
        workspaceId: 'workspace',
        canManagePresets: true,
        presets: GRAPHIC_PRESETS,
        assets: [],
      },
      selected: '',
      onSelect: vi.fn(),
    };
    const rendered = render(<EditPresetLibrary {...props} />);
    fireEvent.click(screen.getByText('Customize workspace presets'));
    fireEvent.click(screen.getByText('Save as new preset'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Preset changed');
    expect(props.onSelect).not.toHaveBeenCalled();
    rendered.unmount();
    render(
      <EditPresetLibrary {...props} library={{ ...props.library, canManagePresets: false }} />
    );
    expect(screen.queryByText('Customize workspace presets')).not.toBeInTheDocument();
  });
});
