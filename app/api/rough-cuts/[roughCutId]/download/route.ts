import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { apiErrors, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';
import { canDownloadProjectMedia } from '@/lib/project-download';
import { parseRoughCutDecisionList } from '@/lib/rough-cut/decision-list';
import { buildFcp7Xml } from '@/lib/rough-cut/fcp7-xml';
import { buildOtioFile } from '@/lib/rough-cut/otio';
import { profileFromSnapshot } from '@/lib/rough-cut/profile';
import { rateLimit } from '@/lib/rate-limit';
import type { CameraClip } from '@/lib/rough-cut/types';

type RouteParams = { params: Promise<{ roughCutId: string }> };

function sanitizeExportName(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'rough-cut';
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'project-download');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { roughCutId } = await params;
    const format = (request.nextUrl.searchParams.get('format') || 'otio').toLowerCase();
    if (format !== 'otio' && format !== 'xml') {
      return apiErrors.badRequest('Invalid format. Use "otio" or "xml"');
    }
    // Cut islands are only exported as markers on request; the default file
    // carries the program and its placeholder markers.
    const includeCuts = request.nextUrl.searchParams.get('cuts') === '1';

    const row = await db.roughCut.findUnique({
      where: { id: roughCutId },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            ownerId: true,
            workspaceId: true,
            visibility: true,
            allowDownloads: true,
          },
        },
        folder: { select: { name: true } },
      },
    });
    if (!row) return apiErrors.notFound('Rough cut');

    const access = await checkProjectAccess(row.project, session.user.id);
    if (!canDownloadProjectMedia(row.project, access)) {
      return apiErrors.forbidden('Project downloads are disabled for viewers');
    }

    if (row.status !== 'READY') {
      return apiErrors.badRequest('Rough cut is not ready to download');
    }

    const decisions = parseRoughCutDecisionList(row.decisions);
    if (!decisions) {
      return apiErrors.internalError('Rough cut decisions are missing or invalid');
    }

    const clips: CameraClip[] = decisions.clips.map((clip) => ({
      videoId: clip.videoId,
      versionId: clip.versionId,
      title: clip.role,
      role: clip.role,
      position: clip.track,
      offsetSeconds: clip.offsetSeconds,
      durationSeconds: clip.durationSeconds,
      frameRateNum: decisions.rate.num,
      frameRateDen: decisions.rate.den,
      dropFrame: decisions.rate.dropFrame,
      startTimecode: null,
      originalUrl: clip.targetUrl,
      versionNumber: 1,
      versionLabel: null,
    }));

    const profile = profileFromSnapshot(row.profileSnapshot);
    const name = `${row.folder?.name || row.project.name} rough cut`;
    const body =
      format === 'xml'
        ? buildFcp7Xml({
            name,
            decisions,
            clips,
            handleFrames: profile.handleFrames,
            includeCuts,
          })
        : buildOtioFile({
            name,
            decisions,
            clips,
            handleFrames: profile.handleFrames,
            includeCuts,
          });

    const fileBase = sanitizeExportName(row.folder?.name || row.project.name);
    const filename = `${fileBase}-rough-cut.${format === 'xml' ? 'xml' : 'otio'}`;
    const contentType =
      format === 'xml' ? 'application/xml; charset=utf-8' : 'application/json; charset=utf-8';

    const response = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error downloading rough cut:', error);
    return apiErrors.internalError('Failed to download rough cut');
  }
}
