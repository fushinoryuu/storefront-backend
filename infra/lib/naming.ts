import { projectStackPrefix, stages } from './config/stages';
import type { ServiceName, SharedStackName, StageConfig, StageName } from './config/stages';

/** Builds `Storefront-<stage>-<Service>`, for example `Storefront-dev-Customers`. */
export function stackName(config: StageConfig, service: ServiceName): string {
    return `${config.stackPrefix}-${config.name}-${service}`;
}

/** Builds `Storefront-<Stack>` for a stack that belongs to no stage, for example `Storefront-Secrets`. */
export function sharedStackName(stack: SharedStackName): string {
    return `${projectStackPrefix}-${stack}`;
}

/** Name of the secret that holds the LaunchDarkly SDK key of a stage (decision 0011). Services look it up by this name. */
export function launchDarklySdkKeySecretName(stage: StageName): string {
    return `${projectStackPrefix.toLowerCase()}-${stage}-secrets-launchdarkly-sdk-key`;
}

/** Name of the `Database` stack this stage uses, which another stage may own. */
export function databaseStackName(config: StageConfig): string {
    return stackName(stages[config.databaseStage], 'Database');
}

/** Builds the name of an SSM parameter, `/storefront/<stage>/<service>/<name>`, for example `/storefront/dev/platform/event-bus-name`. */
export function ssmParameterName(config: StageConfig, service: ServiceName, name: string): string {
    return `/${projectStackPrefix.toLowerCase()}/${config.name}/${service.toLowerCase()}/${name}`;
}

/** The kinds of caller that get an API key (decision 0005). The platform stack owns one key of each kind. */
export const apiKeyKinds = ['tests', 'services', 'admin'] as const;
export type ApiKeyKind = (typeof apiKeyKinds)[number];

/** SSM parameter that holds the id of the API key of a kind. The value of the key is never in SSM (decision 0005). */
export function apiKeyIdParameterName(config: StageConfig, kind: ApiKeyKind): string {
    return ssmParameterName(config, 'Platform', `${kind}-api-key-id`);
}

/** SSM parameter that holds the name of the stage's event bus. */
export function eventBusNameParameterName(config: StageConfig): string {
    return ssmParameterName(config, 'Platform', 'event-bus-name');
}

/** SSM parameter that holds the ARN of the stage's alarm topic, which every service stack passes to its functions and APIs. */
export function alarmTopicArnParameterName(config: StageConfig): string {
    return ssmParameterName(config, 'Platform', 'alarm-topic-arn');
}
