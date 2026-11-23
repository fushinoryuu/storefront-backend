import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { stageNames, stages } from '../lib/config/stages';
import type { StageConfig } from '../lib/config/stages';
import { apiKeyKinds } from '../lib/naming';
import { PlatformStack } from '../lib/stacks/platform-stack';

const build = (config: StageConfig, alarmRecipients?: readonly string[]) => Template.fromStack(new PlatformStack(new App(), config, alarmRecipients));

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

    it('names the event bus for the stage, so the two stages can share an account and region', () => {
        template.hasResourceProperties('AWS::Events::EventBus', { Name: `storefront-${stage}-platform-bus` });
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

    it('lets the CloudWatch alarms of this account and region publish to the alarm topic, and no one else', () => {
        const [topicId] = Object.keys(template.findResources('AWS::SNS::Topic'));
        const [policy] = Object.values(template.findResources('AWS::SNS::TopicPolicy'));
        const statements = policy!.Properties.PolicyDocument.Statement as { Effect: string }[];
        const allowed = statements.filter(({ Effect }) => Effect === 'Allow');

        expect(allowed).toEqual([
            {
                Sid: 'AllowCloudWatchAlarmsToPublish',
                Effect: 'Allow',
                Principal: { Service: 'cloudwatch.amazonaws.com' },
                Action: 'sns:Publish',
                Resource: { Ref: topicId },
                Condition: {
                    StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
                    ArnLike: { 'aws:SourceArn': { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':cloudwatch:', { Ref: 'AWS::Region' }, ':', { Ref: 'AWS::AccountId' }, ':alarm:*']] } }
                }
            }
        ]);
        // The deny for requests that are not over TLS is still there, next to the allow.
        expect(statements.filter(({ Effect }) => Effect === 'Deny')).toHaveLength(1);
    });

    it('publishes the ARN of the alarm topic to SSM, for the service stacks that pass it to their functions and APIs', () => {
        const [topicId] = Object.keys(template.findResources('AWS::SNS::Topic'));

        template.hasResourceProperties('AWS::SSM::Parameter', { Name: `/storefront/${stage}/platform/alarm-topic-arn`, Type: 'String', Value: { Ref: topicId } });
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

    it('deletes the bus, the archive and the topic with the stack', () => {
        for (const type of ['AWS::Events::EventBus', 'AWS::Events::Archive', 'AWS::SNS::Topic']) {
            const resources = Object.values(template.findResources(type));
            expect(resources.length).toBeGreaterThan(0);
            for (const resource of resources) {
                expect(resource.DeletionPolicy).toBe('Delete');
            }
        }
    });

    it('has no subscription when no alarm recipient is given', () => {
        template.resourceCountIs('AWS::SNS::Subscription', 0);
    });
});

describe('PlatformStack alarm recipients', () => {
    it('emails each recipient it is given', () => {
        const template = build(stages.dev, ['one@example.com', 'two@example.com']);

        template.resourceCountIs('AWS::SNS::Subscription', 2);
        template.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'two@example.com' });
    });
});

describe('PlatformStack in both stages', () => {
    // `dev` and `prod` share one account and region, so a fixed physical name must not be the same in the two stages (a name that CDK builds from the construct path has no stage in it).
    const fixedNames = (stage: (typeof stageNames)[number]) => {
        const resources = Template.fromStack(new PlatformStack(new App(), stages[stage])).toJSON().Resources as Record<string, { Properties?: Record<string, unknown> }>;
        return Object.values(resources).flatMap((resource) => ['Name', 'TopicName', 'ArchiveName'].map((key) => resource.Properties?.[key]).filter((value): value is string => typeof value === 'string'));
    };

    it('has no fixed physical name that the stages share', () => {
        const dev = fixedNames('dev');
        expect(dev.length).toBeGreaterThan(0);
        expect(fixedNames('prod').filter((name) => dev.includes(name))).toEqual([]);
    });
});
