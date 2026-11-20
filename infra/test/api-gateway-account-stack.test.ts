import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { createApp } from '../lib/app';
import { stageNames } from '../lib/config/stages';
import { applyNag } from '../lib/nag';
import { ApiGatewayAccountStack, loggingManagedPolicyName } from '../lib/stacks/api-gateway-account-stack';

const template = () => Template.fromStack(new ApiGatewayAccountStack(new App()));

describe('ApiGatewayAccountStack', () => {
    it('is named without a stage', () => {
        expect(new ApiGatewayAccountStack(new App()).stackName).toBe('Storefront-ApiGatewayAccount');
    });

    it.each(stageNames)(
        'is built once and is the same whichever stage the app is built for (%s)',
        (stage) => {
            const staged = createApp({ context: { stage } }).synth();
            expect(staged.stacks.filter((stack) => stack.stackName === 'Storefront-ApiGatewayAccount')).toHaveLength(1);
            expect(staged.getStackByName('Storefront-ApiGatewayAccount').template).toEqual(createApp().synth().getStackByName('Storefront-ApiGatewayAccount').template);
        },
        30000
    );

    it('has one role that API Gateway alone can assume', () => {
        const stack = template();

        stack.resourceCountIs('AWS::IAM::Role', 1);
        stack.hasResourceProperties('AWS::IAM::Role', {
            AssumeRolePolicyDocument: {
                Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'apigateway.amazonaws.com' } }]
            }
        });
    });

    it('gives the role the AWS managed policy for CloudWatch Logs and nothing else', () => {
        const stack = template();

        stack.resourceCountIs('AWS::IAM::Policy', 0);
        stack.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
        const [role] = Object.values(stack.findResources('AWS::IAM::Role'));
        expect(role?.Properties.ManagedPolicyArns).toHaveLength(1);
        // The ARN is a join of the partition and the name, so look for the name in it.
        expect(JSON.stringify(role?.Properties.ManagedPolicyArns)).toContain(`:iam::aws:policy/${loggingManagedPolicyName}`);
    });

    it('sets the account setting to that role, and sets nothing else', () => {
        const stack = template();

        const [roleId] = Object.keys(stack.findResources('AWS::IAM::Role'));
        stack.resourceCountIs('AWS::ApiGateway::Account', 1);
        stack.hasResourceProperties('AWS::ApiGateway::Account', { CloudWatchRoleArn: { 'Fn::GetAtt': [roleId, 'Arn'] } });
        expect(Object.keys(stack.toJSON().Resources)).toHaveLength(2);
    });

    it('tags the role as shared, with no stage', () => {
        template().hasResourceProperties('AWS::IAM::Role', {
            Tags: [
                { Key: 'owner', Value: 'fushinoryuu' },
                { Key: 'project', Value: 'storefront' },
                { Key: 'service', Value: 'ApiGatewayAccount' },
                { Key: 'stage', Value: 'shared' }
            ]
        });
    });

    it('passes cdk-nag with the acknowledgement of the managed policy, and fails without it', () => {
        const acknowledged = new App();
        new ApiGatewayAccountStack(acknowledged);
        applyNag(acknowledged);
        expect(() => acknowledged.synth()).not.toThrow();

        const bare = new App();
        new ApiGatewayAccountStack(bare);
        applyNag(bare, []);
        expect(() => bare.synth()).toThrow(/AwsSolutions-IAM4/);
    }, 30000);
});
