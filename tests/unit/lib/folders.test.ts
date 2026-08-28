import { describe, expect, it } from 'vitest';
import {
  depthAfterMove,
  depthAfterRelocate,
  depthOf,
  folderPath,
  parseFolderName,
  subtreeHeight,
  wouldCreateCycle,
} from '@/lib/folders';

describe('parseFolderName', () => {
  it('trims a usable name', () => {
    expect(parseFolderName('  Dailies  ')).toBe('Dailies');
  });

  it('rejects an empty name', () => {
    expect(parseFolderName('   ')).toBeNull();
    expect(parseFolderName('')).toBeNull();
  });

  it('rejects a name longer than 100 characters', () => {
    expect(parseFolderName('a'.repeat(100))).toBe('a'.repeat(100));
    expect(parseFolderName('a'.repeat(101))).toBeNull();
  });

  it('rejects a non-string', () => {
    expect(parseFolderName(12)).toBeNull();
    expect(parseFolderName(null)).toBeNull();
  });
});

describe('wouldCreateCycle', () => {
  const tree = [
    { id: 'root', parentId: null },
    { id: 'child', parentId: 'root' },
    { id: 'leaf', parentId: 'child' },
  ];

  it('allows moving a leaf to the project root', () => {
    expect(wouldCreateCycle('leaf', null, tree)).toBe(false);
  });

  it('allows moving a leaf under a sibling branch', () => {
    expect(wouldCreateCycle('leaf', 'root', tree)).toBe(false);
  });

  it('rejects making a folder its own parent', () => {
    expect(wouldCreateCycle('child', 'child', tree)).toBe(true);
  });

  it('rejects moving a folder under one of its descendants', () => {
    expect(wouldCreateCycle('root', 'leaf', tree)).toBe(true);
  });
});

describe('depthOf', () => {
  it('counts from the folder up to the root', () => {
    expect(
      depthOf('leaf', [
        { id: 'root', parentId: null },
        { id: 'child', parentId: 'root' },
        { id: 'leaf', parentId: 'child' },
      ])
    ).toBe(3);
  });

  it('is 1 for a root folder', () => {
    expect(depthOf('root', [{ id: 'root', parentId: null }])).toBe(1);
  });
});

describe('depthAfterMove', () => {
  it('is 1 when creating at the project root', () => {
    expect(depthAfterMove(null, [])).toBe(1);
  });

  it('is one below the new parent', () => {
    expect(
      depthAfterMove('child', [
        { id: 'root', parentId: null },
        { id: 'child', parentId: 'root' },
      ])
    ).toBe(3);
  });
});

describe('subtreeHeight and depthAfterRelocate', () => {
  const tree = [
    { id: 'root', parentId: null },
    { id: 'child', parentId: 'root' },
    { id: 'leaf', parentId: 'child' },
    { id: 'other', parentId: null },
  ];

  it('counts a leaf as height 1', () => {
    expect(subtreeHeight('leaf', tree)).toBe(1);
  });

  it('counts the root of a three-deep tree as height 3', () => {
    expect(subtreeHeight('root', tree)).toBe(3);
  });

  it('adds the parent depth when relocating a tree', () => {
    expect(depthAfterRelocate('root', 'other', tree)).toBe(4);
  });

  it('is the subtree height when moving to the project root', () => {
    expect(depthAfterRelocate('child', null, tree)).toBe(2);
  });
});

describe('folderPath', () => {
  it('walks from the leaf to the project root', () => {
    expect(
      folderPath('leaf', [
        { id: 'root', parentId: null, name: 'Dailies' },
        { id: 'child', parentId: 'root', name: 'Cam A' },
        { id: 'leaf', parentId: 'child', name: 'Takes' },
      ])
    ).toEqual([
      { id: 'root', name: 'Dailies' },
      { id: 'child', name: 'Cam A' },
      { id: 'leaf', name: 'Takes' },
    ]);
  });

  it('is a single crumb for a root folder', () => {
    expect(folderPath('root', [{ id: 'root', parentId: null, name: 'Dailies' }])).toEqual([
      { id: 'root', name: 'Dailies' },
    ]);
  });
});
