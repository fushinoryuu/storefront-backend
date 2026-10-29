import { describe, expect, it } from 'vitest';
import { name } from '../src/index';

describe('orders', () => {
  it('loads', () => {
    expect(name).toBe('orders');
  });
});
