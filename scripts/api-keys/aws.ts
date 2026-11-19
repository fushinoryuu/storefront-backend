import { APIGatewayClient, GetApiKeyCommand } from '@aws-sdk/client-api-gateway';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { KeySource } from './cli';

/** Reads from the account and region of the AWS profile in use. */
export function awsKeySource(ssm = new SSMClient({}), apiGateway = new APIGatewayClient({})): KeySource {
    return {
        async parameter(name) {
            const { Parameter } = await ssm.send(new GetParameterCommand({ Name: name }));
            if (!Parameter?.Value) throw new Error(`The parameter ${name} has no value.`);
            return Parameter.Value;
        },
        async keyValue(id) {
            const { value } = await apiGateway.send(new GetApiKeyCommand({ apiKey: id, includeValue: false }));
            if (!value) throw new Error(`The API key ${id} has no value.`);
            return value;
        }
    };
}
