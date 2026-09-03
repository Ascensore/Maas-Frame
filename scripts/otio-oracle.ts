import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleDecisionList } from '../lib/rough-cut/decision-list';
import { buildFcp7Xml } from '../lib/rough-cut/fcp7-xml';
import { buildOtioFile } from '../lib/rough-cut/otio';
import type { CameraClip, EditDecision } from '../lib/rough-cut/types';

const RATE = { num: 24, den: 1, dropFrame: false };

function clip(role: string, versionId: string, durationSeconds: number): CameraClip {
  return {
    videoId: `video-${versionId}`,
    versionId,
    title: `Cam ${role}`,
    role,
    position: role === 'A' ? 0 : 1,
    offsetSeconds: 0,
    durationSeconds,
    frameRateNum: 24,
    frameRateDen: 1,
    dropFrame: false,
    startTimecode: null,
    originalUrl: '/api/upload/video/clip.mp4',
    versionNumber: 1,
    versionLabel: null,
  };
}

const clips = [clip('A', 'ver-a', 10), clip('B', 'ver-b', 10)];
const edits: EditDecision[] = [
  {
    timelineStartSeconds: 0,
    timelineEndSeconds: 2,
    inSeconds: 1,
    outSeconds: 3,
    sourceVersionId: 'ver-a',
    cameraRole: 'A',
    targetTrack: 1,
  },
  {
    timelineStartSeconds: 2,
    timelineEndSeconds: 5,
    inSeconds: 2,
    outSeconds: 5,
    sourceVersionId: 'ver-b',
    cameraRole: 'B',
    targetTrack: 1,
  },
];

const decisions = assembleDecisionList({
  edits,
  clips,
  fileNames: new Map([
    ['ver-a', '01-Cam A-v1.mp4'],
    ['ver-b', '02-Cam B-v1.mp4'],
  ]),
  mediaPathPrefix: './media/',
  rate: RATE,
});

const options = {
  name: 'Rough Cut',
  decisions,
  clips,
  handleFrames: 0,
};

const fixturesDir = mkdtempSync(join(tmpdir(), 'otio-oracle-'));
mkdirSync(fixturesDir, { recursive: true });
writeFileSync(join(fixturesDir, 'rough-cut.otio'), buildOtioFile(options));
writeFileSync(join(fixturesDir, 'rough-cut.xml'), buildFcp7Xml(options));

const scriptDir = dirname(fileURLToPath(import.meta.url));
const python = spawnSync('python3', [join(scriptDir, 'otio_oracle.py'), fixturesDir], {
  encoding: 'utf8',
});

if (python.stdout) process.stdout.write(python.stdout);
if (python.stderr) process.stderr.write(python.stderr);
if (python.status !== 0) {
  process.exit(python.status ?? 1);
}
