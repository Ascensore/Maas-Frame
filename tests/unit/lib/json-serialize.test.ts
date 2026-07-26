import { describe, expect, it } from 'vitest';
import { bigIntReplacer, toJsonSafe } from '@/lib/json-serialize';

describe('bigIntReplacer', () => {
  it.each([
    [BigInt(0), '0'],
    [BigInt(1), '1'],
    [BigInt(-5), '-5'],
    [BigInt('9007199254740993'), '9007199254740993'],
    [BigInt('-9007199254740993'), '-9007199254740993'],
  ])('renders the BigInt %s as the string %s', (value, expected) => {
    expect(bigIntReplacer('sizeBytes', value)).toBe(expected);
  });

  it.each([
    ['a number', 42],
    ['a string', 'hello'],
    ['null', null],
    ['undefined', undefined],
    ['a boolean', false],
  ])('passes %s through unchanged', (_label, value) => {
    expect(bigIntReplacer('key', value)).toBe(value);
  });

  it('passes an object through by reference so JSON.stringify can keep walking it', () => {
    const nested = { a: 1 };
    expect(bigIntReplacer('key', nested)).toBe(nested);
  });

  it('ignores the key argument entirely', () => {
    expect(bigIntReplacer('', BigInt(7))).toBe('7');
    expect(bigIntReplacer('anything', BigInt(7))).toBe('7');
  });

  it('lets JSON.stringify serialise a payload that would otherwise throw', () => {
    const payload = { sizeBytes: BigInt(1024) };

    expect(() => JSON.stringify(payload)).toThrow(TypeError);
    expect(JSON.stringify(payload, bigIntReplacer)).toBe('{"sizeBytes":"1024"}');
  });

  it('converts BigInt values nested in objects and arrays', () => {
    const payload = {
      versions: [{ sizeBytes: BigInt(0) }, { sizeBytes: BigInt(-1) }],
      quota: { used: BigInt(2048), nested: { deep: BigInt(3) } },
    };

    expect(JSON.parse(JSON.stringify(payload, bigIntReplacer))).toEqual({
      versions: [{ sizeBytes: '0' }, { sizeBytes: '-1' }],
      quota: { used: '2048', nested: { deep: '3' } },
    });
  });

  it('converts a bare BigInt at the root of the payload', () => {
    expect(JSON.stringify(BigInt(9), bigIntReplacer)).toBe('"9"');
  });
});

describe('toJsonSafe', () => {
  it('replaces BigInt values with strings across a nested structure', () => {
    const input = {
      id: 'v1',
      sizeBytes: BigInt('5368709120'),
      assets: [{ sizeBytes: BigInt(0) }],
    };

    expect(toJsonSafe(input)).toEqual({
      id: 'v1',
      sizeBytes: '5368709120',
      assets: [{ sizeBytes: '0' }],
    });
  });

  it('returns a detached copy rather than the input object', () => {
    const input = { nested: { count: 1 } };
    const output = toJsonSafe(input);

    expect(output).not.toBe(input);
    expect(output.nested).not.toBe(input.nested);
  });

  it('turns a Date into its ISO string, matching JSON.stringify', () => {
    const output = toJsonSafe({ createdAt: new Date('2026-01-15T00:00:00.000Z') });

    expect(output.createdAt).toEqual('2026-01-15T00:00:00.000Z' as unknown as Date);
  });

  it('drops properties whose value is undefined', () => {
    const output = toJsonSafe({ a: 1, b: undefined }) as Record<string, unknown>;

    expect('b' in output).toBe(false);
  });

  it('preserves null but not undefined inside arrays', () => {
    expect(toJsonSafe([null, undefined, BigInt(1)])).toEqual([null, null, '1']);
  });

  it('handles a value with no BigInt at all', () => {
    expect(toJsonSafe({ a: 1, b: 'two', c: [true, null] })).toEqual({
      a: 1,
      b: 'two',
      c: [true, null],
    });
  });

  it('throws on a circular structure, as JSON.stringify does', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => toJsonSafe(circular)).toThrow(TypeError);
  });
});
