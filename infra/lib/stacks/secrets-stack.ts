import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import { CfnSecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { applyStandardTags } from '../aspects/standard-tags';
import { stageNames } from '../config/stages';
import type { StageConfig } from '../config/stages';
import { launchDarklySdkKeySecretName, sharedStackName } from '../naming';

/**
 * The secrets that outlive the per-run stacks (decision 0011): the LaunchDarkly SDK key of each stage. It belongs to no stage, so one stack holds both secrets,
 * whichever stage the app is built for. The stack creates each secret empty and never sees the key. The owner puts the value in with
 * `aws secretsmanager put-secret-value` (docs/aws-setup.md), so the value is not in a template, in the repo or in CloudFormation.
 */
export class SecretsStack extends Stack {
    constructor(scope: Construct, config: Pick<StageConfig, 'owner'>) {
        super(scope, 'Secrets', { stackName: sharedStackName('Secrets') });
        applyStandardTags(this, { name: 'shared', owner: config.owner }, 'Secrets');

        for (const stage of stageNames) {
            // `CfnSecret` and not `Secret`, because `Secret` generates a random value when it is given none.
            const sdkKey = new CfnSecret(this, `LaunchDarklySdkKey-${stage}`, {
                name: launchDarklySdkKeySecretName(stage),
                description: `The LaunchDarkly SDK key of the ${stage} environment. The value is set by hand, not by this stack.`
            });
            // Not a stage's removal policy: the value can be copied again from LaunchDarkly, and a secret left behind by `cdk destroy` costs $0.40 a month.
            sdkKey.applyRemovalPolicy(RemovalPolicy.DESTROY);
        }
    }
}
