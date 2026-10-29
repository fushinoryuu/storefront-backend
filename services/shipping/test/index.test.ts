import { describe, expect, it } from 'vitest';
import { name } from '../src/index';

describe('shipping', () => {
  it('loads', () => {
    expect(name).toBe('shipping');
  });
});
