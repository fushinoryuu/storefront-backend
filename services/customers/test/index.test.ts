import { describe, expect, it } from 'vitest';
import { workspaceName } from '../src/index';

describe('@storefront/customers', () => {
  it('loads', () => {
    expect(workspaceName).toBe('@storefront/customers');
  });
});
