import { Duration, Stack } from 'aws-cdk-lib';
import { ApiKey } from 'aws-cdk-lib/aws-apigateway';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import { applyStandardTags } from '../aspects/standard-tags';
import type { StageConfig } from '../config/stages';
import { apiKeyIdParameterName, apiKeyKinds, eventBusNameParameterName, stackName } from '../naming';
import { removalPolicyFor } from '../removal-policy';

/**
 * The resources every service shares, one set per stage (decision 0002): the event bus with its archive, the alarm topic and the three API keys
 * (decision 0005). The names and ids that other stacks and outside tools need are published to SSM, and no key value is.
 */
export class PlatformStack extends Stack {
    constructor(scope: Construct, config: StageConfig) {
        super(scope, 'Platform', { stackName: stackName(config, 'Platform') });
        applyStandardTags(this, config, 'Platform');
        const removalPolicy = removalPolicyFor(config);

        const bus = new EventBus(this, 'EventBus');
        bus.applyRemovalPolicy(removalPolicy);
        // An archive with no filter on the account keeps every event of the bus, so events can be replayed while debugging.
        const archive = bus.archive('EventArchive', {
            description: 'Every event of the bus, kept for replay while debugging.',
            eventPattern: { account: [this.account] },
            retention: Duration.days(config.eventArchiveRetentionDays)
        });
        archive.applyRemovalPolicy(removalPolicy);
        new StringParameter(this, 'EventBusNameParameter', { parameterName: eventBusNameParameterName(config), stringValue: bus.eventBusName });

        const alarmTopic = new Topic(this, 'AlarmTopic', { displayName: `Storefront ${config.name} alarms`, enforceSSL: true });
        alarmTopic.applyRemovalPolicy(removalPolicy);
        for (const recipient of config.alarmRecipients) {
            alarmTopic.addSubscription(new EmailSubscription(recipient));
        }

        for (const kind of apiKeyKinds) {
            // No `value`: API Gateway generates it. A script reads it after the deploy (scripts/get-api-keys.ts).
            const id = kind.charAt(0).toUpperCase() + kind.slice(1);
            const key = new ApiKey(this, `${id}ApiKey`, { description: `The ${kind} API key of the ${config.name} stage.` });
            new StringParameter(this, `${id}ApiKeyIdParameter`, { parameterName: apiKeyIdParameterName(config, kind), stringValue: key.keyId });
        }
    }
}
