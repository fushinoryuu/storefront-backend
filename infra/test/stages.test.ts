import { RemovalPolicy } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import {
  UnknownStageError,
  getStageConfig,
  serviceNames,
  stageNames,
  stages,
} from '../lib/config/stages';

describe('stage config', () => {
  it('defines every stage under its own name', () => {
    for (const name of stageNames) {
      expect(stages[name].name).toBe(name);
    }
  });

  it('marks only the database stack as persistent', () => {
    for (const name of stageNames) {
      for (const service of serviceNames) {
        const expected = service === 'Database' ? 'persistent' : 'per-run';
        expect(stages[name].stacks[service]).toBe(expected);
      }
    }
  });

  it('keeps dev destroyable and staging protected', () => {
    expect(stages.dev.deletionProtection).toBe(false);
    expect(stages.dev.aurora.minCapacity).toBe(0);
    expect(stages.staging.deletionProtection).toBe(true);
    expect(stages.staging.removalPolicy).not.toBe(RemovalPolicy.DESTROY);
  });

  it('keeps the carrier timings in order', () => {
    for (const name of stageNames) {
      const { pickedAfterSeconds, shippedAfterSeconds, deliveredAfterSeconds } =
        stages[name].carrierTimings;
      expect(pickedAfterSeconds).toBeGreaterThan(0);
      expect(shippedAfterSeconds).toBeGreaterThan(pickedAfterSeconds);
      expect(deliveredAfterSeconds).toBeGreaterThan(shippedAfterSeconds);
    }
  });

  it('looks up a stage by name', () => {
    expect(getStageConfig('staging')).toBe(stages.staging);
  });

  it('rejects an unknown or missing stage', () => {
    expect(() => getStageConfig('prod')).toThrow(UnknownStageError);
    expect(() => getStageConfig('prod')).toThrow(/Unknown stage "prod".*dev, staging/);
    expect(() => getStageConfig(undefined)).toThrow(/Unknown stage "undefined"/);
  });
});
