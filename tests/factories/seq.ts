// A monotonic counter, shared by every factory in this directory.
//
// Deliberately not random and deliberately not faker: a failing test must
// reproduce byte for byte from its own source, and a randomly generated slug
// that happens to collide once a week is worse than no test. The counter is
// module scoped, so it restarts at 1 for each test file, which is enough because
// resetDb() empties the database between tests.

let counter = 0;

export function nextSeq(): number {
  counter += 1;
  return counter;
}

/** e.g. `uniqueName('project')` -> `'project-1'`. */
export function uniqueName(prefix: string): string {
  return `${prefix}-${nextSeq()}`;
}
