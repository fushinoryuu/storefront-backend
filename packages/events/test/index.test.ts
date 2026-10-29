import { describe, expect, it } from 'vitest';
import { workspaceName } from '../src/index';

describe('@storefront/events', () => {
  it('loads', () => {
    expect(workspaceName).toBe('@storefront/events');
  });
});
