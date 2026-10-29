import { describe, expect, it } from 'vitest';
import { stages } from '../lib/config/stages';
import { stackName } from '../lib/naming';

describe('stackName', () => {
  it('builds Storefront-<stage>-<Service>', () => {
    expect(stackName(stages.dev, 'Customers')).toBe('Storefront-dev-Customers');
    expect(stackName(stages.dev, 'Database')).toBe('Storefront-dev-Database');
    expect(stackName(stages.staging, 'Orders')).toBe('Storefront-staging-Orders');
  });
});
