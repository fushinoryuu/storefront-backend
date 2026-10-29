import { describe, expect, it } from 'vitest';
import { workspaceName } from '../src/index';

describe('@storefront/shared', () => {
  it('loads', () => {
    expect(workspaceName).toBe('@storefront/shared');
  });
});
