import { RemovalPolicy } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { stageNames, stages } from '../lib/config/stages';
import { removalPolicyFor } from '../lib/removal-policy';

describe('removalPolicyFor', () => {
    it.each(stageNames)('destroys resources in %s', (name) => {
        expect(removalPolicyFor(stages[name])).toBe(RemovalPolicy.DESTROY);
    });
});
