import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getConfiguredMaxVideoUploadBytes,
  getR2MultipartPartSizeBytes,
  getR2MultipartThresholdBytes,
  hasBunnyUploadsConfig,
  hasR2Config,
  hasStripeConfig,
  isBunnyUploadsEnabled,
  isBunnyUploadsFeatureEnabled,
  isDirectFileUploadEnabled,
  isInviteCodeRequired,
  isSignupEmailAllowed,
  getAllowedSignupEmails,
  isS3VideoUploadsEnabled,
  isS3VideoUploadsFeatureEnabled,
  isUsingSupabaseObjectStorage,
  isStripeBillingEnabled,
  isStripeFeatureEnabled,
  isProxyTranscodeEnabled,
  isAgentsFeatureEnabled,
  getAgentModelId,
  isRoughCutFeatureEnabled,
  isDiarizationFeatureEnabled,
  getDiarizationModelId,
} from '@/lib/feature-flags';

const MIB = BigInt(1024) * BigInt(1024);
const GIB = MIB * BigInt(1024);

const MANAGED_ENV = [
  'OPENFRAME_ENABLE_STRIPE',
  'OPENFRAME_ENABLE_BUNNY_UPLOADS',
  'OPENFRAME_ENABLE_S3_VIDEO_UPLOADS',
  'OPENFRAME_ENABLE_PROXY_TRANSCODE',
  'OPENFRAME_ENABLE_AGENTS',
  'OPENFRAME_AGENT_MODEL',
  'OPENFRAME_ENABLE_ROUGH_CUT',
  'OPENFRAME_ENABLE_DIARIZATION',
  'OPENFRAME_DIARIZATION_MODEL',
  'OPENFRAME_REQUIRE_INVITE_CODE',
  'OPENFRAME_ALLOWED_SIGNUP_EMAILS',
  'OPENFRAME_MAX_VIDEO_UPLOAD_BYTES',
  'OPENFRAME_R2_MULTIPART_THRESHOLD_BYTES',
  'OPENFRAME_R2_MULTIPART_PART_SIZE_BYTES',
  'STRIPE_SECRET_KEY',
  'STRIPE_PRICE_ID',
  'BUNNY_STREAM_API_KEY',
  'BUNNY_STREAM_LIBRARY_ID',
  'NEXT_PUBLIC_BUNNY_STREAM_LIBRARY_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_ENDPOINT',
  'R2_ACCOUNT_ID',
  'SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
];

function enableR2Config() {
  vi.stubEnv('R2_ACCESS_KEY_ID', 'key');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'secret');
  vi.stubEnv('R2_BUCKET_NAME', 'bucket');
  vi.stubEnv('R2_ACCOUNT_ID', 'account');
}

function enableBunnyConfig() {
  vi.stubEnv('BUNNY_STREAM_API_KEY', 'bunny-key');
  vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', '12345');
}

// warnIfConflictingDirectUploadFlags() routes through logError, which writes to
// console.error. Capture it so the suite stays quiet and the warning is assertable.
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Start from a blank slate so the host environment cannot decide a default.
  for (const name of MANAGED_ENV) {
    vi.stubEnv(name, undefined);
  }
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  vi.unstubAllEnvs();
});

describe('boolean feature flags', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['  true  ', true],
    ['false', false],
    ['FALSE', false],
    [' False ', false],
  ])('reads OPENFRAME_ENABLE_STRIPE=%s as %s', (raw, expected) => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', raw);
    expect(isStripeFeatureEnabled()).toBe(expected);
  });

  it.each(['yes', 'no', '1', '0', 'on', 'off', 'maybe', ''])(
    'falls back to the default for the unrecognised value %s',
    (raw) => {
      vi.stubEnv('OPENFRAME_ENABLE_STRIPE', raw);
      vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', raw);
      // Stripe defaults to on, S3 video uploads default to off.
      expect(isStripeFeatureEnabled()).toBe(true);
      expect(isS3VideoUploadsFeatureEnabled()).toBe(false);
    }
  );

  it('defaults Stripe, Bunny uploads and the invite code to on when unset', () => {
    expect(isStripeFeatureEnabled()).toBe(true);
    expect(isBunnyUploadsFeatureEnabled()).toBe(true);
    expect(isInviteCodeRequired()).toBe(true);
  });

  it('defaults S3 video uploads to off when unset', () => {
    expect(isS3VideoUploadsFeatureEnabled()).toBe(false);
  });

  it('defaults review-proxy transcode to on when unset', () => {
    expect(isProxyTranscodeEnabled()).toBe(true);
  });

  it('turns review-proxy transcode off when the env is false', () => {
    vi.stubEnv('OPENFRAME_ENABLE_PROXY_TRANSCODE', 'false');
    expect(isProxyTranscodeEnabled()).toBe(false);
  });

  it('defaults agents to off and the model to mock', () => {
    expect(isAgentsFeatureEnabled()).toBe(false);
    expect(getAgentModelId()).toBe('mock');
  });

  it('reads OPENFRAME_ENABLE_AGENTS and OPENFRAME_AGENT_MODEL', () => {
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');
    vi.stubEnv('OPENFRAME_AGENT_MODEL', 'anthropic/claude-sonnet-4.5');
    expect(isAgentsFeatureEnabled()).toBe(true);
    expect(getAgentModelId()).toBe('anthropic/claude-sonnet-4.5');
  });

  it('defaults rough cuts and diarization to off', () => {
    expect(isRoughCutFeatureEnabled()).toBe(false);
    expect(isDiarizationFeatureEnabled()).toBe(false);
    expect(getDiarizationModelId()).toBe('pyannote/speaker-diarization-3.1');
  });

  it('reads OPENFRAME_ENABLE_ROUGH_CUT and OPENFRAME_ENABLE_DIARIZATION', () => {
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');
    vi.stubEnv('OPENFRAME_ENABLE_DIARIZATION', 'true');
    vi.stubEnv('OPENFRAME_DIARIZATION_MODEL', 'pyannote/speaker-diarization-community-1');
    expect(isRoughCutFeatureEnabled()).toBe(true);
    expect(isDiarizationFeatureEnabled()).toBe(true);
    expect(getDiarizationModelId()).toBe('pyannote/speaker-diarization-community-1');
  });

  it('lets OPENFRAME_REQUIRE_INVITE_CODE=false open registration', () => {
    vi.stubEnv('OPENFRAME_REQUIRE_INVITE_CODE', 'false');
    expect(isInviteCodeRequired()).toBe(false);
  });
});

describe('signup email allowlist', () => {
  it('allows every address when the env is unset', () => {
    expect(getAllowedSignupEmails()).toEqual([]);
    expect(isSignupEmailAllowed('anyone@example.com')).toBe(true);
  });

  it('treats blank and whitespace as unset', () => {
    vi.stubEnv('OPENFRAME_ALLOWED_SIGNUP_EMAILS', '   ');
    expect(getAllowedSignupEmails()).toEqual([]);
    expect(isSignupEmailAllowed('anyone@example.com')).toBe(true);
  });

  it('allows only the listed addresses, case-insensitively', () => {
    vi.stubEnv('OPENFRAME_ALLOWED_SIGNUP_EMAILS', 'ciao@tdistefano.com');
    expect(getAllowedSignupEmails()).toEqual(['ciao@tdistefano.com']);
    expect(isSignupEmailAllowed('ciao@tdistefano.com')).toBe(true);
    expect(isSignupEmailAllowed('  Ciao@Tdistefano.COM  ')).toBe(true);
    expect(isSignupEmailAllowed('alex@flame-labs.com')).toBe(false);
  });

  it('splits a comma-separated list and drops empty entries', () => {
    vi.stubEnv('OPENFRAME_ALLOWED_SIGNUP_EMAILS', 'a@x.com, , B@Y.com');
    expect(getAllowedSignupEmails()).toEqual(['a@x.com', 'b@y.com']);
    expect(isSignupEmailAllowed('a@x.com')).toBe(true);
    expect(isSignupEmailAllowed('b@y.com')).toBe(true);
    expect(isSignupEmailAllowed('c@z.com')).toBe(false);
  });
});

describe('hasStripeConfig', () => {
  it('requires both the secret key and the price id', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    expect(hasStripeConfig()).toBe(false);

    vi.stubEnv('STRIPE_PRICE_ID', 'price_1');
    expect(hasStripeConfig()).toBe(true);
  });

  it('treats an empty secret key as missing', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    vi.stubEnv('STRIPE_PRICE_ID', 'price_1');
    expect(hasStripeConfig()).toBe(false);
  });
});

describe('isStripeBillingEnabled', () => {
  it('needs the flag on and the config present', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('STRIPE_PRICE_ID', 'price_1');
    expect(isStripeBillingEnabled()).toBe(true);

    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'false');
    expect(isStripeBillingEnabled()).toBe(false);
  });

  it('is off when the flag is on but the config is missing', () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    expect(isStripeBillingEnabled()).toBe(false);
  });
});

describe('hasR2Config', () => {
  it('accepts an explicit endpoint without an account id', () => {
    vi.stubEnv('R2_ACCESS_KEY_ID', 'key');
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 'secret');
    vi.stubEnv('R2_BUCKET_NAME', 'bucket');
    vi.stubEnv('R2_ENDPOINT', 'http://localhost:9000');
    expect(hasR2Config()).toBe(true);
  });

  it('accepts an account id without an explicit endpoint', () => {
    enableR2Config();
    expect(hasR2Config()).toBe(true);
  });

  it.each(['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'])(
    'is incomplete without %s',
    (missing) => {
      enableR2Config();
      vi.stubEnv(missing, undefined);
      expect(hasR2Config()).toBe(false);
    }
  );

  it('is incomplete when neither an endpoint nor an account id is set', () => {
    vi.stubEnv('R2_ACCESS_KEY_ID', 'key');
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 'secret');
    vi.stubEnv('R2_BUCKET_NAME', 'bucket');
    expect(hasR2Config()).toBe(false);
  });

  it('is incomplete without a Supabase url', () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');
    expect(hasR2Config()).toBe(false);
  });

  it('is incomplete without a Supabase service role or secret key', () => {
    vi.stubEnv('SUPABASE_URL', 'https://abc.supabase.co');
    expect(hasR2Config()).toBe(false);
  });

  it('treats a configured Supabase project as object storage', () => {
    vi.stubEnv('SUPABASE_URL', 'https://abc.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');
    expect(hasR2Config()).toBe(true);
  });

  it('accepts the secret key as a substitute for the service role key', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://xyz.supabase.co');
    vi.stubEnv('SUPABASE_SECRET_KEY', 'secret-key');
    expect(hasR2Config()).toBe(true);
  });
});

describe('hasBunnyUploadsConfig', () => {
  it('accepts the server-side library id', () => {
    enableBunnyConfig();
    expect(hasBunnyUploadsConfig()).toBe(true);
  });

  it('accepts the public library id as a substitute', () => {
    vi.stubEnv('BUNNY_STREAM_API_KEY', 'bunny-key');
    vi.stubEnv('NEXT_PUBLIC_BUNNY_STREAM_LIBRARY_ID', '12345');
    expect(hasBunnyUploadsConfig()).toBe(true);
  });

  it('is incomplete without an api key', () => {
    vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', '12345');
    expect(hasBunnyUploadsConfig()).toBe(false);
  });

  it('is incomplete without any library id', () => {
    vi.stubEnv('BUNNY_STREAM_API_KEY', 'bunny-key');
    expect(hasBunnyUploadsConfig()).toBe(false);
  });
});

describe('direct upload precedence', () => {
  it('gives S3 precedence over Bunny when both are fully configured', () => {
    vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'true');
    enableR2Config();
    enableBunnyConfig();

    expect(isS3VideoUploadsEnabled()).toBe(true);
    expect(isBunnyUploadsEnabled()).toBe(false);
    expect(isDirectFileUploadEnabled()).toBe(true);
  });

  it('falls back to Bunny when the S3 flag is on but R2 is not configured', () => {
    vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'true');
    enableBunnyConfig();

    expect(isS3VideoUploadsEnabled()).toBe(false);
    expect(isBunnyUploadsEnabled()).toBe(true);
    expect(isDirectFileUploadEnabled()).toBe(true);
  });

  it('enables S3 uploads through Supabase when Cloudflare R2 keys are absent', () => {
    vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'true');
    vi.stubEnv('SUPABASE_URL', 'https://abc.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');

    expect(isUsingSupabaseObjectStorage()).toBe(true);
    expect(isS3VideoUploadsEnabled()).toBe(true);
    expect(isDirectFileUploadEnabled()).toBe(true);
  });

  it('prefers Cloudflare R2 over Supabase when both are configured', () => {
    vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'true');
    enableR2Config();
    vi.stubEnv('SUPABASE_URL', 'https://abc.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');

    expect(isUsingSupabaseObjectStorage()).toBe(false);
    expect(isS3VideoUploadsEnabled()).toBe(true);
    expect(hasR2Config()).toBe(true);
  });

  it('leaves S3 off when R2 is configured but the flag is not set', () => {
    enableR2Config();
    enableBunnyConfig();

    expect(isS3VideoUploadsEnabled()).toBe(false);
    expect(isBunnyUploadsEnabled()).toBe(true);
  });

  it('disables Bunny when its flag is off even with valid config', () => {
    vi.stubEnv('OPENFRAME_ENABLE_BUNNY_UPLOADS', 'false');
    enableBunnyConfig();

    expect(isBunnyUploadsEnabled()).toBe(false);
    expect(isDirectFileUploadEnabled()).toBe(false);
  });

  it('reports no direct upload path when nothing is configured', () => {
    expect(isS3VideoUploadsEnabled()).toBe(false);
    expect(isBunnyUploadsEnabled()).toBe(false);
    expect(isDirectFileUploadEnabled()).toBe(false);
  });

  it('warns at most once when both direct upload backends are fully enabled', async () => {
    // A fresh module instance resets the module-scoped "already warned" latch.
    vi.resetModules();
    vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'true');
    enableR2Config();
    enableBunnyConfig();

    const flags = await import('@/lib/feature-flags');
    flags.isS3VideoUploadsEnabled();
    flags.isS3VideoUploadsEnabled();
    flags.isDirectFileUploadEnabled();

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain('take precedence');
  });

  it('does not warn when only one direct upload backend is configured', async () => {
    vi.resetModules();
    vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'true');
    enableR2Config();

    const flags = await import('@/lib/feature-flags');
    flags.isDirectFileUploadEnabled();

    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('getConfiguredMaxVideoUploadBytes', () => {
  it('is null when unset, leaving the ceiling to the account quota', () => {
    expect(getConfiguredMaxVideoUploadBytes()).toBeNull();
  });

  it('uses a valid explicit byte count', () => {
    vi.stubEnv('OPENFRAME_MAX_VIDEO_UPLOAD_BYTES', '1073741824');
    expect(getConfiguredMaxVideoUploadBytes()).toBe(GIB);
  });

  it('trims surrounding whitespace before parsing', () => {
    vi.stubEnv('OPENFRAME_MAX_VIDEO_UPLOAD_BYTES', '  1073741824  ');
    expect(getConfiguredMaxVideoUploadBytes()).toBe(GIB);
  });

  it.each(['0', '-1', '-1073741824', 'abc', '1.5', '1e9', '1_000', '  '])(
    'reads the invalid value %s as no ceiling rather than as a number',
    (raw) => {
      vi.stubEnv('OPENFRAME_MAX_VIDEO_UPLOAD_BYTES', raw);
      expect(getConfiguredMaxVideoUploadBytes()).toBeNull();
    }
  );
});

describe('getR2MultipartThresholdBytes', () => {
  it('defaults to 90 MiB so a single PUT stays under the 100 MB proxy cap', () => {
    expect(getR2MultipartThresholdBytes()).toBe(BigInt(90) * MIB);
  });

  it('uses a valid explicit threshold', () => {
    vi.stubEnv('OPENFRAME_R2_MULTIPART_THRESHOLD_BYTES', '52428800');
    expect(getR2MultipartThresholdBytes()).toBe(BigInt(50) * MIB);
  });

  it.each(['0', '-5', 'nonsense'])('falls back to 90 MiB for %s', (raw) => {
    vi.stubEnv('OPENFRAME_R2_MULTIPART_THRESHOLD_BYTES', raw);
    expect(getR2MultipartThresholdBytes()).toBe(BigInt(90) * MIB);
  });

  it('has no lower clamp, unlike the part size', () => {
    vi.stubEnv('OPENFRAME_R2_MULTIPART_THRESHOLD_BYTES', '1024');
    expect(getR2MultipartThresholdBytes()).toBe(BigInt(1024));
  });
});

describe('getR2MultipartPartSizeBytes', () => {
  it('defaults to 32 MiB', () => {
    expect(getR2MultipartPartSizeBytes()).toBe(BigInt(32) * MIB);
  });

  it('clamps a value below the S3 minimum up to 5 MiB', () => {
    vi.stubEnv('OPENFRAME_R2_MULTIPART_PART_SIZE_BYTES', '1024');
    expect(getR2MultipartPartSizeBytes()).toBe(BigInt(5) * MIB);
  });

  it('accepts exactly 5 MiB without clamping', () => {
    vi.stubEnv('OPENFRAME_R2_MULTIPART_PART_SIZE_BYTES', String(BigInt(5) * MIB));
    expect(getR2MultipartPartSizeBytes()).toBe(BigInt(5) * MIB);
  });

  it('accepts a value above the minimum unchanged', () => {
    vi.stubEnv('OPENFRAME_R2_MULTIPART_PART_SIZE_BYTES', String(BigInt(100) * MIB));
    expect(getR2MultipartPartSizeBytes()).toBe(BigInt(100) * MIB);
  });

  it.each(['0', '-104857600', 'abc'])(
    'falls back to 32 MiB rather than the 5 MiB floor for %s',
    (raw) => {
      vi.stubEnv('OPENFRAME_R2_MULTIPART_PART_SIZE_BYTES', raw);
      expect(getR2MultipartPartSizeBytes()).toBe(BigInt(32) * MIB);
    }
  );
});
