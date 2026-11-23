import { App, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import type { CloudAssembly } from 'aws-cdk-lib/cx-api';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../lib/app';
import { stageNames } from '../lib/config/stages';
import { sharedStackName } from '../lib/naming';

/** The one stack that has termination protection: every API of the account depends on it (decision 0002). The Database stack joins it when it is built. */
const protectedStackNames: readonly string[] = [sharedStackName('ApiGatewayAccount')];

const keepingPolicies: readonly (string | undefined)[] = ['Retain', 'RetainExceptOnCreate'];

interface TemplateResource {
    readonly Type: string;
    readonly DeletionPolicy?: string;
    readonly UpdateReplacePolicy?: string;
}

/** Resources that a destroy leaves behind, or that an update that replaces them leaves behind. Both need a hand to delete. */
function keptResources(assembly: CloudAssembly): string[] {
    return assembly.stacks.flatMap((stack) => {
        const { Resources = {} } = stack.template as { Resources?: Record<string, TemplateResource> };
        return Object.entries(Resources)
            .filter(([, resource]) => keepingPolicies.includes(resource.DeletionPolicy) || keepingPolicies.includes(resource.UpdateReplacePolicy))
            .map(([id, resource]) => `${stack.stackName}: ${id} (${resource.Type})`);
    });
}

/** Stacks that CloudFormation refuses to delete and that are not on the list of stacks that need it. */
function unexpectedlyProtectedStacks(assembly: CloudAssembly): string[] {
    return assembly.stacks.filter((stack) => stack.terminationProtection && !protectedStackNames.includes(stack.stackName)).map((stack) => stack.stackName);
}

describe.each(stageNames)('every stack of the app in %s', (stage) => {
    let assembly: CloudAssembly;

    beforeAll(() => {
        assembly = createApp({ context: { stage } }).synth();
    }, 30_000);

    it('has no resource that is kept when the stack is deleted or when an update replaces it, so one command removes everything', () => {
        expect(assembly.stacks.length).toBeGreaterThan(0);
        expect(keptResources(assembly)).toEqual([]);
    });

    it('has no termination protection, except for the stacks that would break others or lose data if they were destroyed by accident', () => {
        expect(unexpectedlyProtectedStacks(assembly)).toEqual([]);
        expect(assembly.getStackByName(sharedStackName('ApiGatewayAccount')).terminationProtection).toBe(true);
    });
});

describe('the checks of the stacks', () => {
    it('find a resource that a stack keeps, and name it', () => {
        const app = new App();
        const stack = new Stack(app, 'Kept', { stackName: 'Storefront-dev-Kept' });
        new LogGroup(stack, 'Logs', { removalPolicy: RemovalPolicy.RETAIN });

        expect(keptResources(app.synth())).toEqual([expect.stringMatching(/^Storefront-dev-Kept: Logs\w+ \(AWS::Logs::LogGroup\)$/)]);
    });

    it('find a resource that a stack leaves behind when an update replaces it', () => {
        const app = new App();
        const stack = new Stack(app, 'Kept', { stackName: 'Storefront-dev-Kept' });
        new LogGroup(stack, 'Logs', { removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE });

        expect(keptResources(app.synth())).toHaveLength(1);
    });

    it('find a stack with termination protection that is not on the list', () => {
        const app = new App();
        new Stack(app, 'Protected', { stackName: 'Storefront-dev-Protected', terminationProtection: true });
        new Stack(app, 'Free', { stackName: 'Storefront-dev-Free' });

        expect(unexpectedlyProtectedStacks(app.synth())).toEqual(['Storefront-dev-Protected']);
    });

    it('let a stack on the list have termination protection', () => {
        const app = new App();
        new Stack(app, 'Account', { stackName: sharedStackName('ApiGatewayAccount'), terminationProtection: true });

        expect(unexpectedlyProtectedStacks(app.synth())).toEqual([]);
    });
});
