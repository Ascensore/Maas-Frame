import { describe, it, expect } from 'vitest';
import { conversionRates } from '@/lib/analytics/scoreboard';

const WEEK = {
  visitors: 200,
  signups: 20,
  firstVideo: 10,
  shareLinks: 5,
  externalFeedback: 1,
  trials: 4,
  newPaid: 1,
};

describe('conversionRates', () => {
  it('divides each step by the one above it', () => {
    const rates = conversionRates(WEEK);
    expect(rates.visitorToSignup).toBeCloseTo(0.1);
    expect(rates.signupToFirstVideo).toBeCloseTo(0.5);
    expect(rates.firstVideoToShare).toBeCloseTo(0.5);
    expect(rates.shareToFeedback).toBeCloseTo(0.2);
    expect(rates.trialToPaid).toBeCloseTo(0.25);
  });

  it('returns null rather than zero when the denominator is zero', () => {
    const rates = conversionRates({ ...WEEK, visitors: 0, trials: 0 });
    expect(rates.visitorToSignup).toBeNull();
    expect(rates.trialToPaid).toBeNull();
    // "nobody arrived" and "nobody converted" are different facts, and the rest
    // of the funnel still has to report normally.
    expect(rates.signupToFirstVideo).toBeCloseTo(0.5);
  });

  it('reports a step where nobody converted as zero, not as missing', () => {
    expect(conversionRates({ ...WEEK, newPaid: 0 }).trialToPaid).toBe(0);
  });
});
