import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSupabaseSignedUploadUrl,
  getSupabaseStorageApi,
  supabaseStorageConnectOrigins,
} from '@/lib/supabase-object-storage';

const SIGN_URL =
  'https://abc.storage.supabase.co/storage/v1/object/upload/sign/maas-frame/videos/clip.mp4';

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'https://abc.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('getSupabaseStorageApi', () => {
  it('derives the storage origin from the project url', () => {
    expect(getSupabaseStorageApi()).toEqual({
      origin: 'https://abc.supabase.co',
      storageOrigin: 'https://abc.storage.supabase.co',
      key: 'service-role-key',
    });
  });

  it('is missing when the service role key is absent', () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', undefined);
    vi.stubEnv('SUPABASE_SECRET_KEY', undefined);
    expect(getSupabaseStorageApi()).toBeNull();
  });
});

describe('supabaseStorageConnectOrigins', () => {
  it('lists both the API origin and the storage origin', () => {
    expect(supabaseStorageConnectOrigins()).toEqual([
      'https://abc.supabase.co',
      'https://abc.storage.supabase.co',
    ]);
  });
});

describe('createSupabaseSignedUploadUrl', () => {
  it('posts to the storage host and prefixes a relative url', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: '/object/upload/sign/maas-frame/videos/clip.mp4?token=abc' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createSupabaseSignedUploadUrl('maas-frame', 'videos/clip.mp4')).resolves.toBe(
      'https://abc.storage.supabase.co/storage/v1/object/upload/sign/maas-frame/videos/clip.mp4?token=abc'
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SIGN_URL);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ upsert: true }));
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer service-role-key');
    expect(headers.get('apikey')).toBe('service-role-key');
  });

  it('encodes each object-key segment in the sign url', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: '/object/upload/sign/maas-frame/videos/clip%201.mp4?token=abc' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await createSupabaseSignedUploadUrl('maas-frame', 'videos/clip 1.mp4');

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://abc.storage.supabase.co/storage/v1/object/upload/sign/maas-frame/videos/clip%201.mp4'
    );
  });

  it('rejects when the sign endpoint fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'unauthorized',
      })
    );

    await expect(createSupabaseSignedUploadUrl('maas-frame', 'videos/clip.mp4')).rejects.toThrow(
      'Failed to sign Supabase upload (401)'
    );
  });
});
