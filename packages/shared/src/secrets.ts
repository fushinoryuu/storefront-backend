import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

// Secrets are read from Secrets Manager once per execution environment (decisions 0009 and 0011).

export type SecretReader = (secretId: string) => Promise<string>;

/** Reads the string value of a secret from Secrets Manager. */
export function secretsManagerReader(client: Pick<SecretsManagerClient, 'send'> = new SecretsManagerClient({})): SecretReader {
    return async (secretId) => {
        const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
        if (!SecretString) throw new Error(`The secret ${secretId} has no string value.`);
        return SecretString;
    };
}

/**
 * The value of one secret. It is read on the first call and the answer is kept for the life of the execution environment, so create the provider once, outside the handler.
 * Calls made while the first read is still running share it. A read that fails is not kept, so the next call tries again.
 */
export function createSecretProvider({ secretId, read = secretsManagerReader() }: { secretId: string; read?: SecretReader }): () => Promise<string> {
    let value: Promise<string> | undefined;
    return () => {
        value ??= read(secretId).catch((error: unknown) => {
            value = undefined;
            throw error;
        });
        return value;
    };
}
