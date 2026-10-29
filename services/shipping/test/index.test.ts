import { describe, expect, it } from 'vitest';
import { workspaceName } from '../src/index';

describe('@storefront/shipping', () => {
  it('loads', () => {
    expect(workspaceName).toBe('@storefront/shipping');
  });
});
