// Per-file setup for the `unit` Vitest project.
//
// One job: put the environment back after every test. The unit project had no setup file
// at all, so each env-stubbing test had to restore its own state, and a forgotten
// `afterEach` leaves the next test reading a value it never set. That is the failure mode
// where a test passes for the wrong reason, which is worse than one that fails.
//
// Restoring centrally does not stop a test from calling `vi.unstubAllEnvs()` itself; it
// only makes forgetting harmless.
import { afterEach, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
});
