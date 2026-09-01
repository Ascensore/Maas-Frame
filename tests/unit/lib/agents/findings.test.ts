import { describe, expect, it } from 'vitest';
import {
  capFindings,
  constrainFindingTimes,
  parseReviewFindings,
  prepareFindingsForPublish,
} from '@/lib/agents/findings';
import { findingFingerprint } from '@/lib/agents/publish-findings';
import type { ReviewFinding } from '@/lib/agents/types';

describe('parseReviewFindings', () => {
  it('accepts a finding with a range and a tag', () => {
    const parsed = parseReviewFindings({
      findings: [
        {
          timestamp: 12.5,
          timestampEnd: 18,
          body: 'Hold on the product shot',
          tagName: 'Creative',
          severity: 'info',
        },
      ],
      summary: 'Looked at the transcript',
    });

    expect(parsed.findings).toEqual([
      {
        timestamp: 12.5,
        timestampEnd: 18,
        body: 'Hold on the product shot',
        tagName: 'Creative',
        severity: 'info',
      },
    ]);
    expect(parsed.summary).toBe('Looked at the transcript');
  });

  it('rejects a twenty-sixth finding', () => {
    const findings = Array.from({ length: 26 }, (_, index) => ({
      timestamp: index,
      body: `Note ${index}`,
    }));

    expect(() => parseReviewFindings({ findings })).toThrow();
  });

  it('accepts twenty-five findings', () => {
    const findings = Array.from({ length: 25 }, (_, index) => ({
      timestamp: index,
      body: `Note ${index}`,
    }));

    expect(parseReviewFindings({ findings }).findings).toHaveLength(25);
  });

  it('rejects an empty body', () => {
    expect(() => parseReviewFindings({ findings: [{ timestamp: 1, body: '   ' }] })).toThrow();
  });
});

describe('capFindings', () => {
  it('keeps the first twenty-five findings', () => {
    const findings: ReviewFinding[] = Array.from({ length: 30 }, (_, index) => ({
      timestamp: index,
      body: `Note ${index}`,
    }));

    expect(capFindings(findings)).toHaveLength(25);
    expect(capFindings(findings)[24]?.body).toBe('Note 24');
  });
});

describe('constrainFindingTimes', () => {
  it('clamps a timestamp past duration and drops a zero-length end', () => {
    expect(constrainFindingTimes({ timestamp: 90, timestampEnd: 90, body: 'late' }, 60)).toEqual({
      timestamp: 60,
      timestampEnd: null,
      body: 'late',
    });
  });

  it('orders a reversed range', () => {
    expect(constrainFindingTimes({ timestamp: 20, timestampEnd: 8, body: 'swap' }, 60)).toEqual({
      timestamp: 8,
      timestampEnd: 20,
      body: 'swap',
    });
  });
});

describe('prepareFindingsForPublish', () => {
  it('caps then clamps', () => {
    const findings: ReviewFinding[] = Array.from({ length: 30 }, (_, index) => ({
      timestamp: 100 + index,
      body: `Note ${index}`,
    }));
    const prepared = prepareFindingsForPublish(findings, 10);
    expect(prepared).toHaveLength(25);
    expect(prepared.every((finding) => finding.timestamp === 10)).toBe(true);
  });
});

describe('findingFingerprint', () => {
  it('is stable for the same finding and changes when the body or time changes', () => {
    const left = findingFingerprint({ timestamp: 4, timestampEnd: 8, body: 'Cut this' });
    const right = findingFingerprint({ timestamp: 4, timestampEnd: 8, body: 'Cut this' });
    const otherBody = findingFingerprint({ timestamp: 4, timestampEnd: 8, body: 'Keep this' });
    const otherTime = findingFingerprint({ timestamp: 9, timestampEnd: 12, body: 'Cut this' });

    expect(left).toBe(right);
    expect(left).not.toBe(otherBody);
    expect(left).not.toBe(otherTime);
    expect(left).toHaveLength(64);
  });
});
