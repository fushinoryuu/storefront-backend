import { App } from 'aws-cdk-lib';
import type { AppProps } from 'aws-cdk-lib';
import { getStageConfig } from './config/stages';
import { PlatformStack } from './stacks/platform-stack';

/**
 * Builds the CDK app for the stage named in context (`cdk synth -c stage=dev`).
 * Stacks are added here as they are written.
 */
export function createApp(props?: AppProps): App {
  const app = new App(props);
  const config = getStageConfig(app.node.tryGetContext('stage'));
  new PlatformStack(app, config);
  return app;
}
