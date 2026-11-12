import { describe, expect, it } from 'vitest';
import { createApp } from '../lib/app';
import { stageNames, stages } from '../lib/config/stages';

describe('createApp', () => {
    it.each(stageNames)(
        'synthesizes for %s',
        (stage) => {
            const assembly = createApp({ context: { stage } }).synth();
            expect(assembly.stacks.map((stack) => stack.stackName)).toEqual([`Storefront-${stage}-Platform`, 'Storefront-Secrets']);
        },
        30000
    );

    it.each(stageNames)('tags every stack with the standard tags in %s', (stage) => {
        const assembly = createApp({ context: { stage } }).synth();
        expect(assembly.stacks.map((stack) => stack.tags)).toEqual([
            { project: 'storefront', stage, service: 'Platform', owner: stages[stage].owner },
            { project: 'storefront', stage: 'shared', service: 'Secrets', owner: stages[stage].owner }
        ]);
    });

    it('builds only the stack that belongs to no stage when no stage is named', () => {
        const assembly = createApp().synth();
        expect(assembly.stacks.map((stack) => stack.stackName)).toEqual(['Storefront-Secrets']);
    }, 30000);

    it.each(['staging', '', null])('fails for a stage that is named but unknown (%j)', (stage) => {
        expect(() => createApp({ context: { stage } })).toThrow(/Unknown stage/);
    });
});
