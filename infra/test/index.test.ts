import { describe, expect, it } from 'vitest';
import { workspaceName } from '../lib/index';

describe('@storefront/infra', () => {
  it('loads', () => {
    expect(workspaceName).toBe('@storefront/infra');
  });
});
