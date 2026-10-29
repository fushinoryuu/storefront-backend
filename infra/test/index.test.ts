import { describe, expect, it } from 'vitest';
import { name } from '../lib/index';

describe('infra', () => {
  it('loads', () => {
    expect(name).toBe('infra');
  });
});
