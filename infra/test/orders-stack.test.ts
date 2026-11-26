import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '@redocly/openapi-core';
import { App } from 'aws-cdk-lib';
import type { CfnElement } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import type { Role } from 'aws-cdk-lib/aws-iam';
import { describe, expect, it } from 'vitest';
import { ordersTable } from '../../services/orders/src/table';
import { stageNames, stages } from '../lib/config/stages';
import type { StageName } from '../lib/config/stages';
import { OrdersStack, ordersSpecVersions } from '../lib/stacks/orders-stack';

/** Bundling is skipped, because esbuild is slow and the template does not depend on it. */
const build = (stage: StageName) => {
    const stack = new OrdersStack(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), stages[stage]);
    return { stack, template: Template.fromStack(stack) };
};

interface Statement {
    Effect: string;
    Action: string | string[];
    Resource: unknown;
}

const asList = (value: string | string[]) => (Array.isArray(value) ? value : [value]);

/** The DynamoDB statements of the policies attached to the role of the function with this construct id. */
function tableStatements({ stack, template }: ReturnType<typeof build>, functionId: string): Statement[] {
    const role = stack.node.findChild(`${functionId}Role`) as Role;
    const roleId = stack.getLogicalId(role.node.defaultChild as CfnElement);
    return Object.values(template.findResources('AWS::IAM::Policy'))
        .filter((policy) => (policy.Properties.Roles as unknown[]).some((attached) => JSON.stringify(attached) === JSON.stringify({ Ref: roleId })))
        .flatMap((policy) => policy.Properties.PolicyDocument.Statement as Statement[])
        .filter((statement) => asList(statement.Action).some((action) => action.startsWith('dynamodb:')));
}

describe.each(stageNames)('OrdersStack in %s', (stage) => {
    const config = stages[stage];
    const built = build(stage);
    const { stack, template } = built;
    const [tableId] = Object.keys(template.findResources('AWS::DynamoDB::Table'));

    it('is named for the stage', () => {
        expect(stack.stackName).toBe(`Storefront-${stage}-Orders`);
    });

    it('has one table, on demand, with the keys, the time-to-live attribute and the stream of the table design', () => {
        template.resourceCountIs('AWS::DynamoDB::Table', 1);
        template.hasResourceProperties('AWS::DynamoDB::Table', {
            BillingMode: 'PAY_PER_REQUEST',
            KeySchema: [
                { AttributeName: ordersTable.partitionKey, KeyType: 'HASH' },
                { AttributeName: ordersTable.sortKey, KeyType: 'RANGE' }
            ],
            TimeToLiveSpecification: { AttributeName: ordersTable.ttlAttribute, Enabled: true },
            StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' }
        });
    });

    it('has the two indexes of the table design, with every attribute projected', () => {
        const { byCustomer, byStatus } = ordersTable.indexes;
        template.hasResourceProperties('AWS::DynamoDB::Table', {
            GlobalSecondaryIndexes: [
                {
                    IndexName: byCustomer.name,
                    KeySchema: [
                        { AttributeName: byCustomer.partitionKey, KeyType: 'HASH' },
                        { AttributeName: byCustomer.sortKey, KeyType: 'RANGE' }
                    ],
                    Projection: { ProjectionType: 'ALL' }
                },
                {
                    IndexName: byStatus.name,
                    KeySchema: [
                        { AttributeName: byStatus.partitionKey, KeyType: 'HASH' },
                        { AttributeName: byStatus.sortKey, KeyType: 'RANGE' }
                    ],
                    Projection: { ProjectionType: 'ALL' }
                }
            ]
        });
    });

    it(`${config.pointInTimeRecovery ? 'keeps' : 'does not keep'} point-in-time recovery, as the stage says`, () => {
        template.hasResourceProperties('AWS::DynamoDB::Table', { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: config.pointInTimeRecovery } });
    });

    it('deletes the table with the stack, and keeps nothing', () => {
        template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
        const kept = Object.values(template.toJSON().Resources as Record<string, { DeletionPolicy?: string; UpdateReplacePolicy?: string }>).filter((resource) => ['Retain', 'RetainExceptOnCreate'].some((policy) => resource.DeletionPolicy === policy || resource.UpdateReplacePolicy === policy));
        expect(kept).toEqual([]);
    });

    it('requires an API key on the three routes of the service, and on no other method but the two operational ones', () => {
        const methods = Object.values(template.findResources('AWS::ApiGateway::Method')).map((method) => ({ http: method.Properties.HttpMethod, key: method.Properties.ApiKeyRequired }));

        expect(
            methods
                .filter(({ key }) => key === true)
                .map(({ http }) => http)
                .sort()
        ).toEqual(['GET', 'GET', 'POST']);
        expect(methods.filter(({ key }) => key !== true)).toEqual([
            { http: 'GET', key: false },
            { http: 'GET', key: false }
        ]);
    });

    it('accepts the keys of the tests and of the services, and no admin key', () => {
        const plans = Object.values(template.findResources('AWS::ApiGateway::UsagePlan')).map((plan) => plan.Properties.UsagePlanName as string);

        expect(plans.map((name) => name.split('-').pop()).sort()).toEqual(['services', 'tests']);
    });

    it('reads the alarm topic that the platform stack of the stage publishes', () => {
        template.hasParameter('*', { Type: 'AWS::SSM::Parameter::Value<String>', Default: `/storefront/${stage}/platform/alarm-topic-arn` });
    });

    it('gives the function that places an order the reads and the writes of the transaction, on the table alone', () => {
        const statements = tableStatements(built, 'CreateOrder');

        expect(statements).toEqual([{ Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem'], Resource: { 'Fn::GetAtt': [tableId, 'Arn'] } }]);
    });

    it('gives the function that reads an order the read of one item, on the table alone', () => {
        const statements = tableStatements(built, 'GetOrder');

        expect(statements).toEqual([{ Effect: 'Allow', Action: 'dynamodb:GetItem', Resource: { 'Fn::GetAtt': [tableId, 'Arn'] } }]);
    });

    it('gives the function that lists products no access to the table', () => {
        expect(tableStatements(built, 'ListProducts')).toEqual([]);
    });

    it('tells the two functions that use the table its name, and no other function', () => {
        const tableName = { Ref: tableId };
        template.resourcePropertiesCountIs('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ TABLE_NAME: tableName }) } }, 2);
        template.resourcePropertiesCountIs('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ SERVICE_NAME: 'orders' }) } }, 4);
    });

    it('has an alarm for the throttled requests and one for the system errors of the table, which notify the alarm topic', () => {
        const tableAlarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')).filter((alarm) => JSON.stringify(alarm.Properties).includes('AWS/DynamoDB'));

        expect(tableAlarms).toHaveLength(2);
        expect(tableAlarms.map((alarm) => JSON.stringify(alarm.Properties).includes('ThrottledRequests'))).toEqual(expect.arrayContaining([true, false]));
        expect(tableAlarms.some((alarm) => JSON.stringify(alarm.Properties).includes('SystemErrors'))).toBe(true);
        for (const alarm of tableAlarms) {
            expect(alarm.Properties.AlarmActions).toHaveLength(1);
            expect(alarm.Properties.Threshold).toBe(1);
        }
    });
});

describe('the spec versions of the orders stack', () => {
    const versionOf = (file: string) => (parseYaml(readFileSync(fileURLToPath(new URL(`../../services/orders/${file}`, import.meta.url)), 'utf8')) as { info: { version: string } }).info.version;

    it('are the versions of the two specs, so a bump of a spec is made here too', () => {
        expect(ordersSpecVersions).toEqual({ v0: versionOf('openapi-v0.yaml'), v1: versionOf('openapi.yaml') });
    });
});
