import { RemovalPolicy } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

export const stageNames = ['dev', 'prod'] as const;
export type StageName = (typeof stageNames)[number];

export const serviceNames = ['Platform', 'Database', 'Customers', 'Orders', 'Shipping'] as const;
export type ServiceName = (typeof serviceNames)[number];

/**
 * `persistent` stacks survive test runs. `per-run` stacks are destroyed after every run.
 * `external` stacks are not deployed in this stage: another stage owns them (see `databaseStage`).
 */
export type StackLifecycle = 'persistent' | 'per-run' | 'external';

export interface StageConfig {
  readonly name: StageName;
  /** First part of every stack name: `<stackPrefix>-<stage>-<Service>`. */
  readonly stackPrefix: string;
  readonly removalPolicy: RemovalPolicy;
  readonly deletionProtection: boolean;
  readonly logRetention: RetentionDays;
  /** The stage whose `Database` stack holds the Aurora cluster this stage uses. */
  readonly databaseStage: StageName;
  /**
   * Aurora Serverless v2 capacity in ACUs, set by the stage that owns the cluster. A minimum
   * of 0 lets the cluster pause. `null` in stages that use another stage's cluster.
   */
  readonly aurora: {
    readonly minCapacity: number;
    readonly maxCapacity: number;
  } | null;
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

export const stages: Readonly<Record<StageName, StageConfig>> = {
  // Where pull request runs deploy, test and tear down. It shares the cluster owned by `prod`.
  dev: {
    name: 'dev',
    stackPrefix: 'Storefront',
    removalPolicy: RemovalPolicy.DESTROY,
    deletionProtection: false,
    logRetention: RetentionDays.ONE_WEEK,
    databaseStage: 'prod',
    aurora: null,
    carrierTimings: { pickedAfterSeconds: 2, shippedAfterSeconds: 4, deliveredAfterSeconds: 6 },
    alarmRecipients: [],
    owner: 'fushinoryuu',
    stacks: {
      Platform: 'per-run',
      Database: 'external',
      Customers: 'per-run',
      Orders: 'per-run',
      Shipping: 'per-run',
    },
  },
  // The production-like stage, deployed from `main` and kept up for ad hoc testing. It owns
  // the one Aurora cluster, which holds the `main` schema and the schema of each pull request.
  prod: {
    name: 'prod',
    stackPrefix: 'Storefront',
    removalPolicy: RemovalPolicy.RETAIN,
    deletionProtection: true,
    logRetention: RetentionDays.ONE_MONTH,
    databaseStage: 'prod',
    // Provisional: ADR 0007 decides whether this cluster may pause.
    aurora: { minCapacity: 0, maxCapacity: 4 },
    carrierTimings: {
      pickedAfterSeconds: 60,
      shippedAfterSeconds: 300,
      deliveredAfterSeconds: 900,
    },
    alarmRecipients: [],
    owner: 'fushinoryuu',
    stacks: {
      Platform: 'persistent',
      Database: 'persistent',
      Customers: 'persistent',
      Orders: 'persistent',
      Shipping: 'persistent',
    },
  },
};

export function isStageName(value: unknown): value is StageName {
  return stageNames.some((name) => name === value);
}

export class UnknownStageError extends Error {}

export function getStageConfig(stage: unknown): StageConfig {
  if (!isStageName(stage)) {
    throw new UnknownStageError(
      `Unknown stage "${String(stage)}". Pass one of: ${stageNames.join(', ')} (for example -c stage=dev).`,
    );
  }
  return stages[stage];
}
