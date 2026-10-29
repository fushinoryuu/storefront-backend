import { Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { applyStandardTags } from '../aspects/standard-tags';
import type { StageConfig } from '../config/stages';
import { stackName } from '../naming';

/**
 * Empty for now. It exists so `cdk synth` has a stack to build; the platform stack
 * ticket fills it with the cross-service resources.
 */
export class PlatformStack extends Stack {
  constructor(scope: Construct, config: StageConfig) {
    super(scope, 'Platform', { stackName: stackName(config, 'Platform') });
    applyStandardTags(this, config, 'Platform');
  }
}
