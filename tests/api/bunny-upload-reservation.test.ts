// The Bunny init routes used to ask the quota about zero bytes, which meant two
// things at once: an upload that could never fit was only discovered after it had
// been sent, and nothing an upload was about to consume was visible to the next
// request. Bunny reports its own storage on a delay and the figure is cached for
// two minutes on top, so every init inside that window read the same stale total
// and every one of them passed.
//
// These tests pin the two halves of the fix: the declared size is checked before
// a byte moves, and it is held as a reservation the next init has to see.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  DELETE as cancelProjectBunnyUpload,
  POST as initProjectBunnyUpload,
} from '@/app/api/projects/[projectId]/videos/bunny-init/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs } from '../helpers/session';
import { seedProject } from '../factories';

const GIB = BigInt(1024) * BigInt(1024) * BigInt(1024);

/**
 * Bunny answers every call the same way, with a fresh video id each time so two
 * inits in one test are distinguishable. The cancel path talks to Bunny too, so
 * the stub has to cover it rather than just the creation call.
 */
function stubBunnyApi(): void {
  let created = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      created += 1;
      return new Response(JSON.stringify({ guid: `bunnyvideo-${created}-abcdefgh` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    })
  );
}

beforeEach(() => {
  vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
  vi.stubEnv('OPENFRAME_ENABLE_BUNNY_UPLOADS', 'true');
  vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'false');
  vi.stubEnv('BUNNY_STREAM_API_KEY', 'test-bunny-key');
  vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', '999999');
  vi.stubEnv('BUNNY_UPLOAD_TOKEN_SECRET', 'test-bunny-upload-token-secret');
  stubBunnyApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function initRequest(projectId: string, body: Record<string, unknown>) {
  return apiRequest(`/api/projects/${projectId}/videos/bunny-init`, { body });
}

async function initUpload(projectId: string, sizeBytes: bigint) {
  return callRoute(
    initProjectBunnyUpload,
    initRequest(projectId, { title: 'A clip', sizeBytes: sizeBytes.toString() }),
    { projectId }
  );
}

describe('POST /api/projects/[projectId]/videos/bunny-init', () => {
  it('refuses an init that does not say how big the upload is', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      initProjectBunnyUpload,
      initRequest(scenario.project.id, { title: 'A clip' }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('sizeBytes');
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it('refuses a size beyond the host per-file ceiling', async () => {
    vi.stubEnv('OPENFRAME_MAX_VIDEO_UPLOAD_BYTES', '1024');
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await initUpload(scenario.project.id, BigInt(2048));

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('maximum allowed upload size');
  });

  // The trial ceiling is 3 GiB, so this is refused on the way in rather than
  // after four gigabytes have been pushed to Bunny.
  it('refuses an upload the remaining quota cannot hold', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await initUpload(scenario.project.id, BigInt(4) * GIB);

    expect(response.status).toBe(507);
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it('holds the declared size as a reservation for the workspace owner', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await initUpload(scenario.project.id, BigInt(2) * GIB);

    expect(response.status).toBe(200);
    const reservations = await db.uploadReservation.findMany();
    expect(reservations).toHaveLength(1);
    expect(reservations[0].billedUserId).toBe(scenario.owner.id);
    expect(reservations[0].sizeBytes).toBe(BigInt(2) * GIB);
  });

  // The regression this whole change exists for. Both of these used to be
  // granted, because neither could see what the other was about to upload.
  it('refuses a second upload that no longer fits beside the first', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const first = await initUpload(scenario.project.id, BigInt(2) * GIB);
    const second = await initUpload(scenario.project.id, BigInt(2) * GIB);

    expect(first.status).toBe(200);
    expect(second.status).toBe(507);
    expect(await db.uploadReservation.count()).toBe(1);
  });
});

describe('DELETE /api/projects/[projectId]/videos/bunny-init', () => {
  it('gives the quota back when a pending upload is cancelled', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const init = await initUpload(scenario.project.id, BigInt(2) * GIB);
    const { videoId, uploadToken } = await readData(init);

    const response = await callRoute(
      cancelProjectBunnyUpload,
      initRequest(scenario.project.id, { videoId, uploadToken }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(200);
    expect(await db.uploadReservation.count()).toBe(0);
  });

  // Why the reservation id travels inside the signed token instead of being
  // handed to the client as a field of its own: a caller who could name a
  // reservation could start two uploads, cancel the cheap one while quoting the
  // expensive one's reservation, and keep uploading against quota it no longer
  // holds.
  it('will not let one upload cancel release another upload reservation', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const first = await initUpload(scenario.project.id, BigInt(1) * GIB);
    const second = await initUpload(scenario.project.id, BigInt(1) * GIB);
    const firstData = await readData(first);
    const secondData = await readData(second);

    const response = await callRoute(
      cancelProjectBunnyUpload,
      initRequest(scenario.project.id, {
        videoId: secondData.videoId,
        uploadToken: firstData.uploadToken,
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(await db.uploadReservation.count()).toBe(2);
  });
});
