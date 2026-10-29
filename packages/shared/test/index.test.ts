import { describe, expect, it } from 'vitest';
import { name } from '../src/index';

describe('shared', () => {
  it('loads', () => {
    expect(name).toBe('shared');
  });
});
