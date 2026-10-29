import { RemovalPolicy } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

export const stageNames = ['dev', 'staging'] as const;
export type StageName = (typeof stageNames)[number];

export const serviceNames = ['Platform', 'Database', 'Customers', 'Orders', 'Shipping'] as const;
export type ServiceName = (typeof serviceNames)[number];

/** `persistent` stacks survive test runs. `per-run` stacks are destroyed after every run. */
export type StackLifecycle = 'persistent' | 'per-run';

export interface StageConfig {
  readonly name: StageName;
  /** First part of every stack name: `<stackPrefix>-<stage>-<Service>`. */
  readonly stackPrefix: string;
  readonly removalPolicy: RemovalPolicy;
  readonly deletionProtection: boolean;
  readonly logRetention: RetentionDays;
  /** Aurora Serverless v2 capacity in ACUs. A minimum of 0 lets the cluster pause. */
  readonly aurora: {
    readonly minCapacity: number;
    readonly maxCapacity: number;
  };
  /** How long the simulated carrier waits before each shipment status change. */
  readonly carrierTimings: {
    readonly pickedAfterSeconds: number;
    readonly shippedAfterSeconds: number;
    readonly deliveredAfterSeconds: number;
  };
  /** Email addresses that receive alarm notifications. */
  readonly alarmRecipients: readonly string[];
  /** Value of the `owner` tag. */
  readonly owner: string;
  readonly stacks: Readonly<Record<ServiceName, StackLifecycle>>;
}

const stackLifecycles: Readonly<Record<ServiceName, StackLifecycle>> = {
  Platform: 'per-run',
  Database: 'persistent',
  Customers: 'per-run',
  Orders: 'per-run',
  Shipping: 'per-run',
};

export const stages: Readonly<Record<StageName, StageConfig>> = {
  dev: {
    name: 'dev',
    stackPrefix: 'Storefront',
    removalPolicy: RemovalPolicy.DESTROY,
    deletionProtection: false,
    logRetention: RetentionDays.ONE_WEEK,
    aurora: { minCapacity: 0, maxCapacity: 2 },
    carrierTimings: { pickedAfterSeconds: 2, shippedAfterSeconds: 4, deliveredAfterSeconds: 6 },
    alarmRecipients: [],
    owner: 'fushinoryuu',
    stacks: stackLifecycles,
  },
  staging: {
    name: 'staging',
    stackPrefix: 'Storefront',
    removalPolicy: RemovalPolicy.RETAIN,
    deletionProtection: true,
    logRetention: RetentionDays.ONE_MONTH,
    // Provisional: ADR 0007 decides whether staging may pause.
    aurora: { minCapacity: 0.5, maxCapacity: 4 },
    carrierTimings: {
      pickedAfterSeconds: 60,
      shippedAfterSeconds: 300,
      deliveredAfterSeconds: 900,
    },
    alarmRecipients: [],
    owner: 'fushinoryuu',
    stacks: stackLifecycles,
  },
};

export function isStageName(value: unknown): value is StageName {
  return stageNames.some((name) => name === value);
}

export function getStageConfig(stage: unknown): StageConfig {
  if (!isStageName(stage)) {
    throw new Error(
      `Unknown stage "${String(stage)}". Pass one of: ${stageNames.join(', ')} (for example -c stage=dev).`,
    );
  }
  return stages[stage];
}
