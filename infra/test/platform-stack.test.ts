import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { stageNames, stages } from '../lib/config/stages';
import type { StageConfig } from '../lib/config/stages';
import { apiKeyKinds } from '../lib/naming';
import { PlatformStack } from '../lib/stacks/platform-stack';

const build = (config: StageConfig) => Template.fromStack(new PlatformStack(new App(), config));

describe.each(stageNames)('PlatformStack in %s', (stage) => {
    const config = stages[stage];
    const template = build(config);

    it('is named for the stage', () => {
        expect(new PlatformStack(new App(), config).stackName).toBe(`Storefront-${stage}-Platform`);
    });

    it('has one event bus, with an archive of every event that keeps them for the stage retention', () => {
        template.resourceCountIs('AWS::Events::EventBus', 1);
        template.resourceCountIs('AWS::Events::Archive', 1);
        template.hasResourceProperties('AWS::Events::Archive', {
            RetentionDays: config.eventArchiveRetentionDays,
            EventPattern: { account: [Match.anyValue()] },
            SourceArn: Match.anyValue()
        });
    });

    it('publishes the event bus name to SSM', () => {
        template.hasResourceProperties('AWS::SSM::Parameter', { Name: `/storefront/${stage}/platform/event-bus-name`, Value: Match.anyValue() });
    });

    it('has an alarm topic that refuses requests that are not over TLS', () => {
        template.resourceCountIs('AWS::SNS::Topic', 1);
        template.hasResourceProperties('AWS::SNS::TopicPolicy', {
            PolicyDocument: {
                Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })])
            }
        });
    });

    it.each(apiKeyKinds)('has an API key for %s, with its id in SSM and no value in the template', (kind) => {
        template.hasResourceProperties('AWS::SSM::Parameter', { Name: `/storefront/${stage}/platform/${kind}-api-key-id`, Value: Match.anyValue() });
        const keys = Object.values(template.findResources('AWS::ApiGateway::ApiKey'));
        expect(keys).toHaveLength(apiKeyKinds.length);
        for (const key of keys) {
            expect(Object.keys(key.Properties)).not.toContain('Value');
            expect(Object.keys(key.Properties)).not.toContain('Name');
        }
    });

    it('keeps the bus, the archive and the topic in a persistent stage only', () => {
        const expected = stage === 'prod' ? 'Retain' : 'Delete';
        for (const type of ['AWS::Events::EventBus', 'AWS::Events::Archive', 'AWS::SNS::Topic']) {
            for (const resource of Object.values(template.findResources(type))) {
                expect(resource.DeletionPolicy).toBe(expected);
            }
        }
    });

    it('has no subscription while the stage has no alarm recipient', () => {
        template.resourceCountIs('AWS::SNS::Subscription', 0);
    });
});

describe('PlatformStack alarm recipients', () => {
    it('emails each recipient of the stage', () => {
        const template = build({ ...stages.dev, alarmRecipients: ['one@example.com', 'two@example.com'] });

        template.resourceCountIs('AWS::SNS::Subscription', 2);
        template.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'two@example.com' });
    });
});
