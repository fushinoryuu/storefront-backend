import { describe, expect, it } from 'vitest';
import { workspaceName } from '../src/index';

describe('@storefront/orders', () => {
  it('loads', () => {
    expect(workspaceName).toBe('@storefront/orders');
  });
});
