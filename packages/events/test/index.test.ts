import { describe, expect, it } from 'vitest';
import { name } from '../src/index';

describe('events', () => {
  it('loads', () => {
    expect(name).toBe('events');
  });
});
