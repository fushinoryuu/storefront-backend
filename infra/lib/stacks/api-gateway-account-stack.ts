import { Stack } from 'aws-cdk-lib';
import { CfnAccount } from 'aws-cdk-lib/aws-apigateway';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { applyStandardTags } from '../aspects/standard-tags';
import { projectOwner } from '../config/stages';
import { sharedStackName } from '../naming';

/** The AWS managed policy that lets API Gateway push logs to CloudWatch Logs. It is the one the API Gateway documentation names for this role. */
export const loggingManagedPolicyName = 'service-role/AmazonAPIGatewayPushToCloudWatchLogs';

/**
 * The one IAM role that API Gateway uses to write access logs, and the account setting that points it there.
 * The setting exists once for each account and region, so `dev` and `prod` share it. That is why the stack belongs to no stage (decision 0002):
 * a stack of a stage would exist twice, and the second deploy would overwrite the setting of the first.
 *
 * `ServiceApi` does not create it (`cloudWatchRole` is off, and `cdk.json` disables the CDK default). An API with access logs does not deploy until this stack has been deployed once.
 * The owner deploys it by hand (docs/aws-setup.md). It holds no secret and costs nothing, and the logs are billed by CloudWatch Logs.
 *
 * Destroying the stack deletes the role. API Gateway is expected to keep the old role in the setting, so logging would fail until the stack is deployed again (not verified). Deploy it again before the next API.
 */
export class ApiGatewayAccountStack extends Stack {
    readonly loggingRole: Role;

    constructor(scope: Construct) {
        super(scope, 'ApiGatewayAccount', { stackName: sharedStackName('ApiGatewayAccount') });
        applyStandardTags(this, { name: 'shared', owner: projectOwner }, 'ApiGatewayAccount');

        this.loggingRole = new Role(this, 'LoggingRole', {
            description: 'Lets API Gateway write access logs to CloudWatch Logs. One for the account and region, used by every API.',
            assumedBy: new ServicePrincipal('apigateway.amazonaws.com'),
            managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName(loggingManagedPolicyName)]
        });
        new CfnAccount(this, 'Account', { cloudWatchRoleArn: this.loggingRole.roleArn });
    }
}
