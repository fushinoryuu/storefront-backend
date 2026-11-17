import { describe, expect, it } from 'vitest';
import { stages } from '../lib/config/stages';
import { databaseStackName, launchDarklySdkKeySecretName, sharedStackName, stackName } from '../lib/naming';

describe('stackName', () => {
    it('builds Storefront-<stage>-<Service>', () => {
        expect(stackName(stages.dev, 'Customers')).toBe('Storefront-dev-Customers');
        expect(stackName(stages.prod, 'Database')).toBe('Storefront-prod-Database');
        expect(stackName(stages.prod, 'Orders')).toBe('Storefront-prod-Orders');
    });
});

describe('sharedStackName', () => {
    it('builds Storefront-<Stack>, with no stage in it', () => {
        expect(sharedStackName('Secrets')).toBe('Storefront-Secrets');
    });
});

describe('launchDarklySdkKeySecretName', () => {
    it('builds storefront-<stage>-secrets-launchdarkly-sdk-key', () => {
        expect(launchDarklySdkKeySecretName('dev')).toBe('storefront-dev-secrets-launchdarkly-sdk-key');
        expect(launchDarklySdkKeySecretName('prod')).toBe('storefront-prod-secrets-launchdarkly-sdk-key');
    });
});

describe('databaseStackName', () => {
    it('points every stage at the Database stack of prod', () => {
        expect(databaseStackName(stages.prod)).toBe('Storefront-prod-Database');
        expect(databaseStackName(stages.dev)).toBe('Storefront-prod-Database');
    });
});
