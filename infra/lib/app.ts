import { App } from 'aws-cdk-lib';
import type { AppProps } from 'aws-cdk-lib';
import { alarmRecipientsVariable, parseAlarmRecipients } from './config/alarm-recipients';
import { getStageConfig } from './config/stages';
import { applyNag } from './nag';
import { ApiGatewayAccountStack } from './stacks/api-gateway-account-stack';
import { OrdersStack } from './stacks/orders-stack';
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
    if (stage !== undefined) {
        const config = getStageConfig(stage);
        const platform = new PlatformStack(app, config, parseAlarmRecipients(env[alarmRecipientsVariable]));
        // Orders reads the alarm topic and the API keys of the platform stack from SSM, which CloudFormation does not see as a dependency, so it is stated here: `deploy --all` waits for Platform, and `destroy --all` removes Orders first.
        new OrdersStack(app, config).addStackDependency(platform);
    }
    new SecretsStack(app);
    new ApiGatewayAccountStack(app);
    applyNag(app);
    return app;
}
