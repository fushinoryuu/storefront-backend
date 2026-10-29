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

  it('destroys every dev stack after a run and keeps every prod stack', () => {
    for (const service of serviceNames) {
      expect(stages.dev.stacks[service]).toBe(service === 'Database' ? 'external' : 'per-run');
      expect(stages.prod.stacks[service]).toBe('persistent');
    }
  });

  it('shares one Aurora cluster, owned by the stage that deploys the Database stack', () => {
    for (const name of stageNames) {
      const owner = stages[stages[name].databaseStage];
      expect(owner.stacks.Database).toBe('persistent');
      expect(owner.aurora).not.toBeNull();
      // A stage has its own capacity settings only if it owns the cluster.
      expect(stages[name].aurora === null).toBe(stages[name].stacks.Database === 'external');
    }
  });

  it('keeps dev destroyable and prod protected', () => {
    expect(stages.dev.removalPolicy).toBe(RemovalPolicy.DESTROY);
    expect(stages.dev.deletionProtection).toBe(false);
    expect(stages.prod.deletionProtection).toBe(true);
    expect(stages.prod.removalPolicy).not.toBe(RemovalPolicy.DESTROY);
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
    expect(getStageConfig('prod')).toBe(stages.prod);
  });

  it('rejects an unknown or missing stage', () => {
    expect(() => getStageConfig('staging')).toThrow(UnknownStageError);
    expect(() => getStageConfig('staging')).toThrow(/Unknown stage "staging".*dev, prod/);
    expect(() => getStageConfig(undefined)).toThrow(/Unknown stage "undefined"/);
  });
});
