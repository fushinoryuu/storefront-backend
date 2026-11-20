import { Validations } from 'aws-cdk-lib';
import type { App } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { stageNames } from './config/stages';

/**
 * A cdk-nag finding that is accepted on purpose. Every one has a `reason`, written for a reader who was not there.
 * `path` is the construct path from the app, for example `Secrets/LaunchDarklySdkKey-dev`, and `id` is the rule id, for example `AwsSolutions::AwsSolutions-SMG4`, the form that the finding prints.
 */
export interface Acknowledgement {
    readonly path: string;
    readonly id: string;
    readonly reason: string;
}

/**
 * Every acknowledged finding that belongs to one stack of the app. This is where one is added.
 * A finding that a construct always has is acknowledged by the construct, once, and not by every stack that uses it (`ServiceFunction` does).
 */
export const acknowledgements: readonly Acknowledgement[] = [
    ...stageNames.map((stage) => ({
        path: `Secrets/LaunchDarklySdkKey-${stage}`,
        id: 'AwsSolutions::AwsSolutions-SMG4',
        reason: 'The value is a LaunchDarkly SDK key that the owner copies in by hand. Secrets Manager cannot rotate it, because only LaunchDarkly can issue a new key.'
    })),
    {
        path: 'ApiGatewayAccount/LoggingRole',
        id: 'AwsSolutions::AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs]',
        reason: 'The role needs the AWS managed policy for pushing logs to CloudWatch Logs, the one the API Gateway documentation names. It grants only log group and log stream writes, and the role can be assumed by API Gateway alone.'
    }
];

/**
 * Runs the AWS Solutions rules against every stack, so `cdk synth` fails on a finding that is not acknowledged above.
 * A stack that is not in the app (a stage that was not named) is skipped, and a path that is missing from a stack that is in it is an error,
 * so an acknowledgement cannot go stale.
 */
export function applyNag(app: App, accepted: readonly Acknowledgement[] = acknowledgements): void {
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
    for (const { path, id, reason } of accepted) {
        const stackId = path.split('/')[0];
        if (stackId === undefined || app.node.tryFindChild(stackId) === undefined) continue;
        const node = app.node.findAll().find((child) => child.node.path === path);
        if (node === undefined) throw new Error(`The acknowledgement of ${id} names ${path}, which does not exist.`);
        Validations.of(node).acknowledge({ id, reason });
    }
}
