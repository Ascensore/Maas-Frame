import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function prismaModelDbColumns(schema: string, modelName: string): string[] {
  const match = schema.match(new RegExp(`model ${modelName} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`model ${modelName} not found`);

  const columns: string[] = [];
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('///') ||
      trimmed.startsWith('@@') ||
      trimmed.includes('@relation')
    ) {
      continue;
    }
    const fieldMatch = trimmed.match(/^(\w+)\s+/);
    if (!fieldMatch) continue;
    const mapMatch = trimmed.match(/@map\("([^"]+)"\)/);
    columns.push(mapMatch ? mapMatch[1] : fieldMatch[1]);
  }
  return columns;
}

describe('RoughCut Prisma column names', () => {
  it('maps camelCase fields onto the snake_case columns the migrations created', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');

    expect(prismaModelDbColumns(schema, 'RoughCut')).toEqual([
      'id',
      'status',
      'project_id',
      'folder_id',
      'profile_id',
      'brief_id',
      'requested_by_id',
      'layout',
      'frame_rate_num',
      'frame_rate_den',
      'drop_frame',
      'profile_snapshot',
      'brief_snapshot',
      'sync_report',
      'decisions',
      'warnings',
      'script',
      'overrides',
      'rendered_overrides',
      'rendered_decisions',
      'error',
      'output_video_id',
      'created_at',
      'updated_at',
    ]);
  });
});
