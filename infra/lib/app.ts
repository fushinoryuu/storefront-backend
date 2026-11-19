import { App } from 'aws-cdk-lib';
import type { AppProps } from 'aws-cdk-lib';
import { alarmRecipientsVariable, parseAlarmRecipients } from './config/alarm-recipients';
import { getStageConfig } from './config/stages';
import { applyNag } from './nag';
import { PlatformStack } from './stacks/platform-stack';
import { SecretsStack } from './stacks/secrets-stack';

/**
 * Builds the CDK app. The stacks of a stage are built when context names the stage (`cdk synth -c stage=dev`).
 * The stacks that belong to no stage are always built, so without a stage the app has only those.
 * A stage that is named but unknown is an error.
 * The alarm addresses of the stage come from the `ALARM_RECIPIENTS` variable of `env`, so no address is in the repo.
 * Stacks are added here as they are written.
 */
export function createApp(props?: AppProps, env: NodeJS.ProcessEnv = process.env): App {
    const app = new App(props);
    const stage: unknown = app.node.tryGetContext('stage');
    if (stage !== undefined) new PlatformStack(app, getStageConfig(stage), parseAlarmRecipients(env[alarmRecipientsVariable]));
    new SecretsStack(app);
    applyNag(app);
    return app;
}
