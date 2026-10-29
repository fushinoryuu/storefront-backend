import type { ServiceName, StageConfig } from './config/stages';

/** Builds `Storefront-<stage>-<Service>`, for example `Storefront-dev-Customers`. */
export function stackName(config: StageConfig, service: ServiceName): string {
  return `${config.stackPrefix}-${config.name}-${service}`;
}
