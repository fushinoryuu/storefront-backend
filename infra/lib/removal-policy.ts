import type { RemovalPolicy } from 'aws-cdk-lib';
import type { StageConfig } from './config/stages';

/** The removal policy resources should use in this stage. */
export function removalPolicyFor(config: StageConfig): RemovalPolicy {
  return config.removalPolicy;
}
