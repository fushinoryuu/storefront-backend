import { describe, expect, it } from 'vitest';
import { createApp } from '../lib/app';
import { stageNames } from '../lib/config/stages';

describe('createApp', () => {
  it.each(stageNames)('synthesizes for %s', (stage) => {
    const assembly = createApp({ context: { stage } }).synth();
    expect(assembly.stacks.map((stack) => stack.stackName)).toEqual([
      `Storefront-${stage}-Platform`,
    ]);
  });

  it('fails without a stage', () => {
    expect(() => createApp()).toThrow(/Unknown stage/);
  });
});
