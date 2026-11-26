import { fileURLToPath } from 'node:url';
import { Duration, Stack, Validations } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { AttributeType, BillingMode, Operation, ProjectionType, StreamViewType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Grant } from 'aws-cdk-lib/aws-iam';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { Topic } from 'aws-cdk-lib/aws-sns';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { ordersTable } from '../../../services/orders/src/table';
import { applyStandardTags } from '../aspects/standard-tags';
import type { StageConfig } from '../config/stages';
import { ServiceApi } from '../constructs/service-api';
import { ServiceFunction } from '../constructs/service-function';
import { alarmTopicArnParameterName, stackName } from '../naming';
import { removalPolicyFor } from '../removal-policy';

/** The `info.version` of the two specs the orders API serves. A test keeps them equal to the specs, so a bump of a spec fails until it is made here too. */
export const ordersSpecVersions = { v0: '0.2.0', v1: '0.3.0' } as const;

const entry = (file: string) => fileURLToPath(new URL(`../../../services/orders/src/${file}.ts`, import.meta.url));

/**
 * The orders service of one stage: its table, three functions behind a `ServiceApi`, and the alarms on the table (the Lambda and API alarms come from the constructs).
 * The table is built from `ordersTable`, the shape that `docs/services/orders-table-design.md` describes. It is destroyed with the stack in every stage (decision 0002),
 * keeps a stream with new and old images that nothing reads yet, and has point-in-time recovery when the stage says so (`pointInTimeRecovery`).
 *
 * Each function gets only the table actions it uses, on the table and not on its indexes, because no handler reads an index yet.
 * The alarm topic comes from the SSM parameter that the `Platform` stack of the stage publishes, so deploy `Platform` first (the app makes `Orders` depend on it).
 */
export class OrdersStack extends Stack {
    readonly table: Table;
    readonly api: ServiceApi;

    constructor(scope: Construct, config: StageConfig) {
        super(scope, 'Orders', { stackName: stackName(config, 'Orders') });
        applyStandardTags(this, config, 'Orders');
        const alarmTopic = Topic.fromTopicArn(this, 'AlarmTopic', StringParameter.valueForStringParameter(this, alarmTopicArnParameterName(config)));

        this.table = new Table(this, 'Table', {
            partitionKey: { name: ordersTable.partitionKey, type: AttributeType.STRING },
            sortKey: { name: ordersTable.sortKey, type: AttributeType.STRING },
            billingMode: BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: ordersTable.ttlAttribute,
            stream: StreamViewType.NEW_AND_OLD_IMAGES,
            pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: config.pointInTimeRecovery },
            removalPolicy: removalPolicyFor(config)
        });
        if (!config.pointInTimeRecovery) {
            Validations.of(this.table).acknowledge({
                id: 'AwsSolutions::AwsSolutions-DDB3',
                reason: 'A table of this stage lives for the minutes of a test run and is destroyed after it, so there is nothing to restore. The stage setting `pointInTimeRecovery` turns it on in `prod`.'
            });
        }
        for (const { name, partitionKey, sortKey } of Object.values(ordersTable.indexes)) {
            this.table.addGlobalSecondaryIndex({
                indexName: name,
                partitionKey: { name: partitionKey, type: AttributeType.STRING },
                sortKey: { name: sortKey, type: AttributeType.STRING },
                projectionType: ProjectionType.ALL
            });
        }

        const listProducts = new ServiceFunction(this, 'ListProducts', { config, service: 'Orders', entry: entry('list-products'), timeout: Duration.seconds(5), alarmTopic });
        const createOrder = this.tableFunction('CreateOrder', config, alarmTopic, entry('create-order'), Duration.seconds(10), ['dynamodb:GetItem', 'dynamodb:PutItem']);
        const getOrder = this.tableFunction('GetOrder', config, alarmTopic, entry('get-order'), Duration.seconds(5), ['dynamodb:GetItem']);

        // `tests` is the suite and the library project. `services` is for the services that will call orders. `admin` comes with `listOrders`.
        this.api = new ServiceApi(this, 'Api', { config, service: 'Orders', specVersions: ordersSpecVersions, keyKinds: ['tests', 'services'], alarmTopic });
        this.api.addRoute('GET', '/products', listProducts);
        this.api.addRoute('POST', '/orders', createOrder);
        this.api.addRoute('GET', '/orders/{orderId}', getOrder);

        // Over a five minute window, one throttled or failed request alarms, as the alarms of a function do. Both are metrics per operation, so the operations the functions use are named.
        const operations = [Operation.GET_ITEM, Operation.PUT_ITEM, Operation.TRANSACT_WRITE_ITEMS];
        const metricOptions = { operations, period: Duration.minutes(5) };
        const alarms = {
            ThrottledRequests: ['DynamoDB refused at least one request to the orders table because it was throttled.', this.table.metricThrottledRequestsForOperations(metricOptions)],
            SystemErrors: ['DynamoDB answered at least one request to the orders table with a server error.', this.table.metricSystemErrorsForOperations(metricOptions)]
        } as const;
        for (const [id, [alarmDescription, metric]] of Object.entries(alarms)) {
            const alarm = new Alarm(this, id, { alarmDescription, metric, threshold: 1, evaluationPeriods: 1, comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, treatMissingData: TreatMissingData.NOT_BREACHING });
            alarm.addAlarmAction(new SnsAction(alarmTopic));
        }
    }

    /** A function that reads or writes the table. `actions` are granted on the table's ARN alone, so there is no wildcard in the policy. */
    private tableFunction(id: string, config: StageConfig, alarmTopic: ITopic, file: string, timeout: Duration, actions: string[]): IFunction {
        const fn = new ServiceFunction(this, id, { config, service: 'Orders', entry: file, timeout, alarmTopic, environment: { TABLE_NAME: this.table.tableName } });
        Grant.addToPrincipal({ grantee: fn, actions, resourceArns: [this.table.tableArn] });
        return fn;
    }
}
