import { describe, expect, it } from 'vitest';
import { createApp } from '../lib/app';
import { InvalidAlarmRecipientError } from '../lib/config/alarm-recipients';
import { stageNames, stages } from '../lib/config/stages';

describe('createApp', () => {
    it.each(stageNames)(
        'synthesizes for %s',
        (stage) => {
            const assembly = createApp({ context: { stage } }).synth();
            expect(assembly.stacks.map((stack) => stack.stackName)).toEqual(['Storefront-ApiGatewayAccount', `Storefront-${stage}-Platform`, 'Storefront-Secrets', `Storefront-${stage}-Orders`]);
        },
        30000
    );

    it.each(stageNames)('tags every stack with the standard tags in %s', (stage) => {
        const assembly = createApp({ context: { stage } }).synth();
        expect(assembly.stacks.map((stack) => stack.tags)).toEqual([
            { project: 'storefront', stage: 'shared', service: 'ApiGatewayAccount', owner: stages[stage].owner },
            { project: 'storefront', stage, service: 'Platform', owner: stages[stage].owner },
            { project: 'storefront', stage: 'shared', service: 'Secrets', owner: stages[stage].owner },
            { project: 'storefront', stage, service: 'Orders', owner: stages[stage].owner }
        ]);
    });

    it.each(stageNames)(
        'makes Orders depend on Platform in %s, which CloudFormation cannot see because they share only SSM parameters',
        (stage) => {
            const assembly = createApp({ context: { stage } }).synth();
            expect(assembly.getStackByName(`Storefront-${stage}-Orders`).dependencies.map((dependency) => dependency.id)).toContain('Platform');
            expect(assembly.getStackByName(`Storefront-${stage}-Platform`).dependencies.map((dependency) => dependency.id)).not.toContain('Orders');
        },
        30000
    );

    describe('alarm recipients', () => {
        const emailsOf = (env: NodeJS.ProcessEnv) => {
            const template = createApp({ context: { stage: 'prod' } }, env)
                .synth()
                .getStackByName('Storefront-prod-Platform').template as { Resources: Record<string, { Type: string; Properties: { Endpoint?: string } }> };
            return Object.values(template.Resources)
                .filter((resource) => resource.Type === 'AWS::SNS::Subscription')
                .map((resource) => resource.Properties.Endpoint);
        };

        it('are the addresses in ALARM_RECIPIENTS, subscribed to the topic of the stage', () => {
            expect(emailsOf({ ALARM_RECIPIENTS: 'one@example.com, two@example.com' })).toEqual(['one@example.com', 'two@example.com']);
        }, 30000);

        it('are none when the variable is not set', () => {
            expect(emailsOf({})).toEqual([]);
        }, 30000);

        it('fail the build when an entry is not an address', () => {
            expect(() => createApp({ context: { stage: 'prod' } }, { ALARM_RECIPIENTS: 'nope' })).toThrow(InvalidAlarmRecipientError);
        });

        it('are not read when no stage is named', () => {
            expect(() => createApp(undefined, { ALARM_RECIPIENTS: 'nope' })).not.toThrow();
        });
    });

    it('builds only the stacks that belong to no stage when no stage is named', () => {
        const assembly = createApp().synth();
        expect(assembly.stacks.map((stack) => stack.stackName)).toEqual(['Storefront-ApiGatewayAccount', 'Storefront-Secrets']);
    }, 30000);

    it.each(['staging', '', null])('fails for a stage that is named but unknown (%j)', (stage) => {
        expect(() => createApp({ context: { stage } })).toThrow(/Unknown stage/);
    });
});
