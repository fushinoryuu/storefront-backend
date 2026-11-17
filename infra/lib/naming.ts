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
