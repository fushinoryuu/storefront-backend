import { stages } from './config/stages';
import type { ServiceName, StageConfig } from './config/stages';

/** Builds `Storefront-<stage>-<Service>`, for example `Storefront-dev-Customers`. */
export function stackName(config: StageConfig, service: ServiceName): string {
  return `${config.stackPrefix}-${config.name}-${service}`;
}

/** Name of the `Database` stack this stage uses, which another stage may own. */
export function databaseStackName(config: StageConfig): string {
  return stackName(stages[config.databaseStage], 'Database');
}
