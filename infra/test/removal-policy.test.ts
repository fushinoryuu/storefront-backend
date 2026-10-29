import { RemovalPolicy } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { stages } from '../lib/config/stages';
import { removalPolicyFor } from '../lib/removal-policy';

describe('removalPolicyFor', () => {
  it('destroys resources in dev', () => {
    expect(removalPolicyFor(stages.dev)).toBe(RemovalPolicy.DESTROY);
  });

  it('returns the configured policy for prod', () => {
    expect(removalPolicyFor(stages.prod)).toBe(stages.prod.removalPolicy);
    expect(removalPolicyFor(stages.prod)).toBe(RemovalPolicy.RETAIN);
  });
});
