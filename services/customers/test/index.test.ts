import { describe, expect, it } from 'vitest';
import { name } from '../src/index';

describe('customers', () => {
  it('loads', () => {
    expect(name).toBe('customers');
  });
});
