import { RemovalPolicy } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { stages } from '../lib/config/stages';
import { removalPolicyFor } from '../lib/removal-policy';

describe('removalPolicyFor', () => {
  it('destroys resources in dev', () => {
    expect(removalPolicyFor(stages.dev)).toBe(RemovalPolicy.DESTROY);
  });

  it('returns the configured policy for staging', () => {
    expect(removalPolicyFor(stages.staging)).toBe(stages.staging.removalPolicy);
    expect(removalPolicyFor(stages.staging)).toBe(RemovalPolicy.RETAIN);
  });
});
