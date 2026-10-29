import { describe, expect, it } from 'vitest';
import { stages } from '../lib/config/stages';
import { databaseStackName, stackName } from '../lib/naming';

describe('stackName', () => {
  it('builds Storefront-<stage>-<Service>', () => {
    expect(stackName(stages.dev, 'Customers')).toBe('Storefront-dev-Customers');
    expect(stackName(stages.prod, 'Database')).toBe('Storefront-prod-Database');
    expect(stackName(stages.prod, 'Orders')).toBe('Storefront-prod-Orders');
  });
});

describe('databaseStackName', () => {
  it('points every stage at the Database stack of prod', () => {
    expect(databaseStackName(stages.prod)).toBe('Storefront-prod-Database');
    expect(databaseStackName(stages.dev)).toBe('Storefront-prod-Database');
  });
});
