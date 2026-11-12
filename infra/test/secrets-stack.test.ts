import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { createApp } from '../lib/app';
import { stageNames } from '../lib/config/stages';
import { SecretsStack } from '../lib/stacks/secrets-stack';

const template = () => Template.fromStack(new SecretsStack(new App()));

describe('SecretsStack', () => {
    it('is named without a stage', () => {
        expect(new SecretsStack(new App()).stackName).toBe('Storefront-Secrets');
    });

    it.each(stageNames)(
        'is the same whichever stage the app is built for (%s)',
        (stage) => {
            expect(createApp({ context: { stage } }).synth().getStackByName('Storefront-Secrets').template).toEqual(createApp().synth().getStackByName('Storefront-Secrets').template);
        },
        30000
    );

    it('has one empty secret per stage for the LaunchDarkly SDK key, with no value in the template', () => {
        const stack = template();

        stack.resourceCountIs('AWS::SecretsManager::Secret', stageNames.length);
        for (const stage of stageNames) {
            stack.hasResourceProperties('AWS::SecretsManager::Secret', { Name: `storefront-${stage}-secrets-launchdarkly-sdk-key` });
        }
        for (const secret of Object.values(stack.findResources('AWS::SecretsManager::Secret'))) {
            expect(Object.keys(secret.Properties)).not.toContain('SecretString');
            expect(Object.keys(secret.Properties)).not.toContain('GenerateSecretString');
        }
        expect(JSON.stringify(stack.toJSON())).not.toMatch(/sdk-[0-9a-f]{8}/);
    }, 30000);

    it('deletes the secrets with the stack, so a teardown leaves nothing that bills', () => {
        const stack = template();

        for (const secret of Object.values(stack.findResources('AWS::SecretsManager::Secret'))) {
            expect(secret.DeletionPolicy).toBe('Delete');
        }
    }, 30000);
});
