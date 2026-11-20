import { RemovalPolicy } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { ApiKeyKind } from '../naming';

export const stageNames = ['dev', 'prod'] as const;
export type StageName = (typeof stageNames)[number];

export const serviceNames = ['Platform', 'Database', 'Customers', 'Orders', 'Shipping'] as const;
export type ServiceName = (typeof serviceNames)[number];

/** Stacks that belong to no stage. There is one of each, and every stage uses it. */
export const sharedStackNames = ['Secrets'] as const;
export type SharedStackName = (typeof sharedStackNames)[number];

/** First part of every stack name. */
export const projectStackPrefix = 'Storefront';

/** Value of the `owner` tag, the same in every stage and in the stacks that belong to none. */
export const projectOwner = 'fushinoryuu';

/** Requests a second that a caller may sustain, and how many it may send at once. */
export interface ThrottleLimits {
    readonly rateLimit: number;
    readonly burstLimit: number;
}

/** What one caller type may use of an API: its throttle, and how many requests it may send in a day. */
export interface UsageLimits extends ThrottleLimits {
    readonly quotaPerDay: number;
}

export interface ApiLimits {
    /** Applies to every method of the stage and every caller, so a runaway test cannot flood a service. */
    readonly defaultThrottle: ThrottleLimits;
    /** One usage plan per kind of API key (decision 0005). The plans carry these limits for the callers that hold the key. */
    readonly usagePlans: Readonly<Record<ApiKeyKind, UsageLimits>>;
}

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
    /** How many days the archive of the event bus keeps events for replay. Archived events cost $0.10 per GB, then $0.023 per GB-month (docs/cost.md). */
    readonly eventArchiveRetentionDays: number;
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
    /** Throttle and quota of the APIs of this stage (`ServiceApi`). */
    readonly api: ApiLimits;
    /** How long the simulated carrier waits before each shipment status change. */
    readonly carrierTimings: {
        readonly pickedAfterSeconds: number;
        readonly shippedAfterSeconds: number;
        readonly deliveredAfterSeconds: number;
    };
    /** Value of the `owner` tag. */
    readonly owner: string;
    readonly stacks: Readonly<Record<ServiceName, StackLifecycle>>;
}

/**
 * Low on purpose: this is a demo, so a loop that goes wrong in a test costs little and cannot reach a service's limits.
 * Both stages use the same numbers, so what a test sees in `dev` is what `prod` does.
 * The `services` key carries the calls between services, `tests` the test suites and the library project, and `admin` the shipping simulation.
 */
const apiLimits: ApiLimits = {
    defaultThrottle: { rateLimit: 50, burstLimit: 100 },
    usagePlans: {
        services: { rateLimit: 50, burstLimit: 100, quotaPerDay: 100_000 },
        tests: { rateLimit: 20, burstLimit: 40, quotaPerDay: 20_000 },
        admin: { rateLimit: 5, burstLimit: 10, quotaPerDay: 1_000 }
    }
};

export const stages: Readonly<Record<StageName, StageConfig>> = {
    // Where pull request runs deploy, test and tear down. It shares the cluster owned by `prod`.
    dev: {
        name: 'dev',
        stackPrefix: projectStackPrefix,
        removalPolicy: RemovalPolicy.DESTROY,
        deletionProtection: false,
        logRetention: RetentionDays.ONE_WEEK,
        eventArchiveRetentionDays: 7,
        databaseStage: 'prod',
        aurora: null,
        api: apiLimits,
        carrierTimings: { pickedAfterSeconds: 2, shippedAfterSeconds: 4, deliveredAfterSeconds: 6 },
        owner: projectOwner,
        stacks: {
            Platform: 'per-run',
            Database: 'external',
            Customers: 'per-run',
            Orders: 'per-run',
            Shipping: 'per-run'
        }
    },
    // The production-like stage, deployed from `main` and kept up for ad hoc testing. It owns
    // the one Aurora cluster, which holds the `main` schema and the schema of each pull request.
    prod: {
        name: 'prod',
        stackPrefix: projectStackPrefix,
        removalPolicy: RemovalPolicy.RETAIN,
        deletionProtection: true,
        logRetention: RetentionDays.ONE_MONTH,
        eventArchiveRetentionDays: 30,
        databaseStage: 'prod',
        // ADR 0007: the cluster may pause. The maximum is low so a runaway test cannot scale it up.
        aurora: { minCapacity: 0, maxCapacity: 4 },
        api: apiLimits,
        carrierTimings: {
            pickedAfterSeconds: 60,
            shippedAfterSeconds: 300,
            deliveredAfterSeconds: 900
        },
        owner: projectOwner,
        stacks: {
            Platform: 'persistent',
            Database: 'persistent',
            Customers: 'persistent',
            Orders: 'persistent',
            Shipping: 'persistent'
        }
    }
};

export function isStageName(value: unknown): value is StageName {
    return stageNames.some((name) => name === value);
}

export class UnknownStageError extends Error {}

export function getStageConfig(stage: unknown): StageConfig {
    if (!isStageName(stage)) {
        throw new UnknownStageError(`Unknown stage "${String(stage)}". Pass one of: ${stageNames.join(', ')} (for example -c stage=dev).`);
    }
    return stages[stage];
}
