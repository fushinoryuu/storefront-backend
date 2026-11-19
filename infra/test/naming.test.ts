import { describe, expect, it } from 'vitest';
import { stages } from '../lib/config/stages';
import { apiKeyIdParameterName, databaseStackName, eventBusNameParameterName, launchDarklySdkKeySecretName, sharedStackName, ssmParameterName, stackName } from '../lib/naming';

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

describe('ssmParameterName', () => {
    it('builds /storefront/<stage>/<service>/<name> with the service in lowercase', () => {
        expect(ssmParameterName(stages.dev, 'Platform', 'event-bus-name')).toBe('/storefront/dev/platform/event-bus-name');
        expect(ssmParameterName(stages.prod, 'Customers', 'base-url')).toBe('/storefront/prod/customers/base-url');
    });

    it('names the event bus and API key id parameters of the platform stack', () => {
        expect(eventBusNameParameterName(stages.dev)).toBe('/storefront/dev/platform/event-bus-name');
        expect(apiKeyIdParameterName(stages.prod, 'admin')).toBe('/storefront/prod/platform/admin-api-key-id');
    });
});
