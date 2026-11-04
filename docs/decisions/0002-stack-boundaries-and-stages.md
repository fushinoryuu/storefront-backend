# 0002: Stack boundaries and stages

Status: accepted on 2026-11-03.

## Context

Pull request runs have to deploy, test and tear down everything they create, quickly and cheaply. We also want one production-like deployment that stays up for ad hoc testing. The Aurora cluster takes 10 to 15 minutes to create and holds data, so it cannot be rebuilt on every run. Both stages live in one personal AWS account and region (`us-west-2`).

## Options

**Stack boundaries.**

- One stack for everything. Simple, but a run cannot keep the database while it replaces the services, and one failure blocks every service.
- One stack per service, plus a platform stack and a database stack. Each unit deploys, fails and is destroyed on its own.

**Stages.**

- Two stages, `dev` for pull request runs and `prod` deployed from `main`. `prod` owns the database, and `dev` uses it.
- Every pull request gets a full stage with its own cluster. Complete isolation, but 10 to 15 minutes and a new cluster per run.
- A separate AWS account per stage. The strongest isolation, with more account setup than a personal project needs.

## Decision

- One CDK app with five stacks: `Platform`, `Database`, `Customers`, `Orders` and `Shipping`. They are named `Storefront-<stage>-<Service>`, for example `Storefront-dev-Customers`.
- `Platform` (event bus, API keys, shared parameters, alarm topic) and `Database` deploy first. The service stacks depend on them.
- Two stages, `dev` and `prod`, both in the same account and region and configured in `infra/lib/config/stages.ts`. Each stack is marked `persistent`, `per-run` or `external` (owned by another stage):

| Stage  | Used for                                    | Stacks                                                | Removal policy and protection     | Log retention |
| ------ | ------------------------------------------- | ----------------------------------------------------- | --------------------------------- | ------------- |
| `dev`  | Pull request runs: deploy, test, tear down  | All `per-run`, except `Database`, which is `external` | `DESTROY`, no deletion protection | One week      |
| `prod` | Deployed from `main`, up for ad hoc testing | All `persistent`                                      | `RETAIN`, deletion protection     | One month     |

- `prod` owns the one Aurora cluster, in `Storefront-prod-Database` with CloudFormation termination protection on. The cluster holds the `main` schema for `prod` and one schema per pull request run. `dev` reads its connection details and has no database stack of its own. ADR 0006 and 0007 cover how the schemas, users and scaling work.
- A test run deploys to `dev`, runs the tests, drops its schema and destroys the `per-run` stacks. The teardown script lists those stacks explicitly and never runs `cdk destroy --all`.

## Consequences

- A run is as fast as its stacks, and the expensive, stateful part survives it. `prod` is always there to test against.
- The stage is a parameter, not a copy of the code. A new stage is a new entry in `stages.ts`.
- `dev` stack names are the same on every run, so runs have to be serialized, or two branches would deploy over each other.
- One shared cluster is a shared failure point. A run's database user must have no access to the `main` schema, so a mistaken clean cannot reach it (ADR 0006).
- Both stages share an account, so isolation comes from names, tags and permissions, not an account boundary. A full teardown has to remove termination protection from the database stack first.
- `prod` costs money while it is deployed, even when idle. `docs/cost.md` will record how much, once the cost guardrails are written.
