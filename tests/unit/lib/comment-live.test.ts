import { describe, expect, it } from 'vitest';
import {
  commentLiveChannel,
  encodeCommentLiveEvent,
  formatSseEvent,
  parseCommentLiveEvent,
} from '@/lib/comment-live';

describe('commentLiveChannel', () => {
  it('prefixes a cuid-shaped version id', () => {
    expect(commentLiveChannel('clabcdefghijk012345678901')).toBe('ofc_clabcdefghijk012345678901');
  });

  it('rejects an id that is not a safe channel name', () => {
    expect(commentLiveChannel('ofc_injected; DROP')).toBeNull();
    expect(commentLiveChannel('')).toBeNull();
    expect(commentLiveChannel('has space')).toBeNull();
    expect(commentLiveChannel('abcdefg')).toBeNull();
    expect(
      commentLiveChannel('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefX')
    ).toBeNull();
  });

  it('accepts ids at the 8 and 64 character bounds', () => {
    expect(commentLiveChannel('abcdefgh')).toBe('ofc_abcdefgh');
    expect(
      commentLiveChannel('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
    ).toBe('ofc_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  });
});

describe('comment live event payload', () => {
  it('round-trips a version id', () => {
    expect(parseCommentLiveEvent(encodeCommentLiveEvent('clabc123'))).toEqual({
      versionId: 'clabc123',
    });
  });

  it('rejects malformed JSON', () => {
    expect(parseCommentLiveEvent('not json')).toBeNull();
    expect(parseCommentLiveEvent('{"versionId":1}')).toBeNull();
    expect(parseCommentLiveEvent('{"versionId":""}')).toBeNull();
  });
});

describe('formatSseEvent', () => {
  it('writes an SSE frame with the event name and JSON data', () => {
    expect(formatSseEvent('comments', { versionId: 'clabc' })).toBe(
      'event: comments\ndata: {"versionId":"clabc"}\n\n'
    );
  });
});
