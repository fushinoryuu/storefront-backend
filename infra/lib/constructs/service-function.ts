import { Validations } from 'aws-cdk-lib';
import type { Duration } from 'aws-cdk-lib';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';
import type { ServiceName, StageConfig } from '../config/stages';
import { removalPolicyFor } from '../removal-policy';
import { LambdaAlarms } from './lambda-alarms';

export const logLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
export type LogLevel = (typeof logLevels)[number];

/** Memory of a function that does not ask for more. Lambda gives CPU in proportion to memory, so raise it when a measurement says to. */
export const defaultMemorySize = 256;

export interface ServiceFunctionProps {
    readonly config: StageConfig;
    readonly service: ServiceName;
    /** The TypeScript file with the handler, which esbuild bundles. */
    readonly entry: string;
    /** There is no default, so every function has a timeout that someone chose. It also sets the duration alarm. */
    readonly timeout: Duration;
    /** The name of the stage's event bus, which the platform stack publishes to SSM. */
    readonly eventBusName: string;
    /** Name of the exported handler. Defaults to `handler`. */
    readonly handler?: string;
    /** Defaults to 256 MB. */
    readonly memorySize?: number;
    /** Defaults to `INFO`. */
    readonly logLevel?: LogLevel;
    /** The variables of this function. The standard ones below win over a variable with the same name. */
    readonly environment?: Readonly<Record<string, string>>;
    /** The alarm topic of the platform stack. Without one the alarms exist and notify nobody. */
    readonly alarmTopic?: ITopic;
}

/**
 * A Lambda function with what every service function needs, so a stack only says what is different about its own:
 * arm64 on Node.js 24, bundled by esbuild with source maps, X-Ray tracing on, and its own log group with the retention of the stage (conventions: Logs).
 * The bundler is the `esbuild` of the repo's `devDependencies`, pinned to an exact version. `allowScripts` in `package.json` names the same version, so a bump changes both.
 * It gets these environment variables: `STAGE`, `SERVICE_NAME` (lowercase), `EVENT_BUS_NAME`, `POWERTOOLS_SERVICE_NAME` and `POWERTOOLS_LOG_LEVEL` for the logger, and `NODE_OPTIONS` so that stack traces use the source maps.
 * It also gets the three alarms of `LambdaAlarms`, as `alarms`.
 *
 * It is a `NodejsFunction`, so permissions are given the CDK way and stay as narrow as the resource: `table.grantReadData(fn)`, `secret.grantRead(fn)`, `bus.grantPutEventsTo(fn)`.
 * Never add a policy statement with a wildcard. The one wildcard it has is X-Ray's, which does not support a resource (acknowledged in this construct).
 * The other acknowledgement is the cdk-nag rule for the latest runtime: it stays until the project moves to a newer Node.js (see the comment where it is made).
 *
 * @example
 * const hello = new ServiceFunction(this, 'Hello', {
 *     config,
 *     service: 'Customers',
 *     entry: 'services/customers/src/hello.ts',
 *     timeout: Duration.seconds(10),
 *     eventBusName: eventBus.eventBusName,
 *     alarmTopic
 * });
 * table.grantReadData(hello);
 */
export class ServiceFunction extends NodejsFunction {
    readonly alarms: LambdaAlarms;

    constructor(scope: Construct, id: string, props: ServiceFunctionProps) {
        // Created here, and not left to Lambda, because Lambda's own log group keeps logs forever.
        const logGroup = new LogGroup(scope, `${id}LogGroup`, { retention: props.config.logRetention, removalPolicy: removalPolicyFor(props.config) });
        // Its own role, so that the function can write to its own log group only. The role that CDK makes by default carries the AWS managed policy, which allows every log group.
        const role = new Role(scope, `${id}Role`, { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
        role.addToPolicy(new PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [logGroup.logGroupArn] }));
        // The one finding of cdk-nag that every function has, acknowledged here once and not in every stack. It covers the policy of this role, which holds only the log statement above and X-Ray's.
        Validations.of(role).acknowledge({
            id: 'AwsSolutions::AwsSolutions-IAM5[Resource::*]',
            reason: 'The role holds the two X-Ray actions that send trace data, and X-Ray does not support a resource for them, so no narrower resource exists. Its other statement names the log group of the function.'
        });
        const logLevel = props.logLevel ?? 'INFO';
        const serviceName = props.service.toLowerCase(); // as in the logger and the event source: `shipping`, not `Shipping`
        super(scope, id, {
            entry: props.entry,
            handler: props.handler,
            runtime: Runtime.NODEJS_24_X,
            architecture: Architecture.ARM_64,
            memorySize: props.memorySize ?? defaultMemorySize,
            timeout: props.timeout,
            tracing: Tracing.ACTIVE,
            logGroup,
            role,
            bundling: { sourceMap: true },
            environment: {
                ...props.environment,
                STAGE: props.config.name,
                SERVICE_NAME: serviceName,
                EVENT_BUS_NAME: props.eventBusName,
                POWERTOOLS_SERVICE_NAME: serviceName,
                POWERTOOLS_LOG_LEVEL: logLevel,
                // Node ignores the source maps unless it is told to use them, and then a stack trace would point into the bundle.
                NODE_OPTIONS: '--enable-source-maps'
            }
        });
        // cdk-nag asks for the newest runtime that `aws-cdk-lib` knows, and a release of the library that adds one makes this finding appear on every function.
        // Node.js 24 is the newest runtime that Lambda offers for production: the Node.js 26 runtime was in preview on 2026-11-19, without the Lambda SLA or support.
        Validations.of(this).acknowledge({
            id: 'AwsSolutions::AwsSolutions-L1',
            reason: 'Node.js 24 is the runtime of the project, and the newer runtime of aws-cdk-lib is not for production yet: Lambda has the Node.js 26 runtime in preview, without its SLA or support. Remove this acknowledgement in the change that moves the project to Node.js 26.'
        });
        this.alarms = new LambdaAlarms(this, 'Alarms', { function: this, timeout: props.timeout, alarmTopic: props.alarmTopic });
    }
}
