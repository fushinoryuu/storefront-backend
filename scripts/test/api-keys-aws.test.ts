import { GetApiKeyCommand } from '@aws-sdk/client-api-gateway';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { describe, expect, it, vi } from 'vitest';
import { awsKeySource } from '../api-keys/aws';

/** A client that answers every call with `output` and keeps the commands it was sent. */
function fakeClient(output: object) {
    return { send: vi.fn().mockResolvedValue(output) };
}

describe('awsKeySource', () => {
    it('asks SSM for the parameter by name and returns its value', async () => {
        const ssm = fakeClient({ Parameter: { Value: 'key-id-1' } });
        const source = awsKeySource(ssm, fakeClient({}));

        expect(await source.parameter('/storefront/dev/platform/tests-api-key-id')).toBe('key-id-1');
        const command = ssm.send.mock.calls[0]?.[0] as GetParameterCommand;
        expect(command).toBeInstanceOf(GetParameterCommand);
        expect(command.input).toEqual({ Name: '/storefront/dev/platform/tests-api-key-id' });
    });

    it('asks API Gateway for the key with its value, which `get-api-key` leaves out by default', async () => {
        const apiGateway = fakeClient({ value: 'the-value' });
        const source = awsKeySource(fakeClient({}), apiGateway);

        expect(await source.keyValue('key-id-1')).toBe('the-value');
        const command = apiGateway.send.mock.calls[0]?.[0] as GetApiKeyCommand;
        expect(command).toBeInstanceOf(GetApiKeyCommand);
        expect(command.input).toEqual({ apiKey: 'key-id-1', includeValue: true });
    });

    it.each([{}, { Parameter: {} }, { Parameter: { Value: '' } }])('fails when the parameter has no value (%j)', async (output) => {
        const source = awsKeySource(fakeClient(output), fakeClient({}));

        await expect(source.parameter('/storefront/dev/platform/tests-api-key-id')).rejects.toThrow('has no value');
    });

    it.each([{}, { value: '' }])('fails when the API key has no value (%j), without printing anything', async (output) => {
        const source = awsKeySource(fakeClient({}), fakeClient(output));

        await expect(source.keyValue('key-id-1')).rejects.toThrow('The API key key-id-1 has no value.');
    });
});
