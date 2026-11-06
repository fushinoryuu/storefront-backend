# Cost

What the project costs when it is idle and when it is used, what to avoid, and how to tear it down. Prices change, so check the current AWS pricing before relying on any number here. The figures are for `us-west-2` (Oregon) unless a line says otherwise, and a month is taken as 730 hours. The budget that guards the spend is described in [aws-setup.md](aws-setup.md).

## What costs money when idle

`prod` stays deployed from `main`, so these run all the time:

| What                                       | Idle cost                                                                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aurora cluster, paused                     | Storage only, at $0.10 per GB-month of consumed storage. Backup storage beyond the free allocation is $0.021 per GB-month. A demo database is small.     |
| Secrets Manager interface endpoint         | $0.01 per hour, about $7.30 a month, for the migration runner of `prod` (decision 0006). It is the largest fixed cost.                                   |
| Secrets Manager secrets                    | $0.40 per secret per month. The database stack alone has five (the master secret and one for each of the four users in decision 0006), about $2 a month. |
| DynamoDB, Lambda, API Gateway, EventBridge | No hourly charge. Tables are on-demand, so an idle table costs its storage. Point-in-time recovery in `prod` adds a per-GB charge.                       |
| CloudWatch Logs and alarms                 | Log storage is kept short by the retention in `stages.ts` (one week in `dev`, one month in `prod`). Each alarm and dashboard has a small monthly charge. |

## What costs money when used

| What                                       | Price and what drives it                                                                                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aurora capacity                            | $0.12 per ACU-hour for Aurora PostgreSQL Serverless v2 in the Standard configuration (IO-Optimized is $0.16). Billed only while the cluster is awake. I/O is $0.20 per million requests. |
| RDS Data API                               | $0.35 per million requests at the first tier. Each unit of work is a few requests (begin, set the path, the statements, commit).                                                         |
| Interface endpoint (`dev`)                 | The same $0.01 per hour, for as long as a pull request run's stack exists, plus $0.01 per GB processed.                                                                                  |
| EventBridge Pipes                          | $0.40 per million requests after filtering, where each 64 KB chunk of payload is one request. The pricing page does not name a region for this price.                                    |
| Lambda, API Gateway, DynamoDB, EventBridge | Per request or per unit of work. At demo volume this is small next to the lines above. I did not check the rates.                                                                        |

A pull request run costs endpoint hours for the minutes it lasts, plus Aurora capacity from the moment it wakes the cluster until the cluster pauses again. The pause comes an hour after the last request (decision 0007), so an idle hour after each run is billed. At the lowest nonzero capacity (0.5 ACU) an hour is about $0.06, and at the maximum of 4 ACU it is $0.48. I have not measured what the cluster uses while it waits, and the Phase 6 cost review measures one run for real.

Two worst cases to keep in mind:

- A cluster that never pauses at 0.5 ACU costs about $44 a month ($0.12 × 0.5 × 730). That is the alternative decision 0007 rejected, and a one-line change in `stages.ts` if the resume wait is too painful.
- A cluster pinned at the 4 ACU maximum all month costs about $350. The maximum is low so that a runaway test cannot reach that for long, and the budget alert is the net under it.

## Avoiding the NAT gateway

A NAT gateway is the usual surprise bill, and this design has none. AWS's pricing page lists $0.045 per hour (about $33 a month) plus $0.045 per GB processed for US East (Ohio). I did not check the Oregon rate for it. A NAT also needs a public IPv4 address, which is $0.005 per hour in Oregon ($3.65 a month), so a NAT left running is about $36 a month before data.

The migration runner needs to reach Secrets Manager from an isolated VPC. One interface endpoint in one availability zone does that for about $7.30 a month (decision 0006). Nothing else in the VPC needs internet access, because the app calls the database through the Data API from outside the VPC.

## Strategies not adopted yet

These are known ways to spend less. None is built.

- **Just-in-time network egress.** Create a NAT gateway (or the endpoint) only for the migration step of a deploy, then destroy it. A NAT billed per run would cost about $1 or $2 a month instead of $7.30. It is not adopted because:
  - CloudFormation cannot create a resource, run a trigger that depends on it and delete the resource in one deploy. It needs a separate egress stack that the pipeline deploys before the services and destroys after, so it only works cleanly from the pipeline.
  - Subnets need a route to the NAT, and removing it means changing the route again.
  - A failed teardown leaves a NAT running at about $36 a month, and the cleanup job has one more thing to find.
  - Every `prod` deploy pays the extra minutes.
  - The runner has general internet access while the NAT exists. The endpoint reaches Secrets Manager only.

  Revisit it in the Phase 6 cost review, with measured numbers and a working pipeline. Adopting it needs a new decision record that supersedes decision 0006.

- **A shorter auto-pause delay.** The delay is one hour (decision 0007). The AWS default is 300 seconds. A shorter delay cuts the idle hour after each run, at the cost of more resumes (about 15 seconds each) for anyone testing by hand.
- **Fewer secrets.** Four database users mean four secrets at $0.40 a month. That is cheap next to the safety it buys, so this is not worth changing.

## Destroy order

The teardown is planned for Phase 6, which builds and rehearses it. The order below is what it will do.

**A pull request run (fast mode).** It leaves `prod`, the database stack and the `main` schema alone:

1. Clean the run's schema through the Flyway runner. This comes first, because the runner is destroyed with its stack.
2. Destroy the `dev` per-run stacks, from an explicit list, never with `cdk destroy --all`: `Shipping`, `Orders`, `Customers`, then `Platform`. The service stacks depend on `Platform`, so CDK destroys them first.
3. A scheduled job later finds per-run stacks that are older than a few hours and stale schemas, so a failed teardown does not keep costing money.

**A full teardown.** It takes `prod` down and loses its data:

1. Destroy the `prod` service stacks (`Shipping`, `Orders`, `Customers`), then `Platform`.
2. Turn off CloudFormation termination protection on `Storefront-prod-Database`, and destroy it last. The cluster is `RETAIN`, so deleting the stack does not delete the cluster. Remove it by hand, and decide first whether a final snapshot is worth keeping.
3. Check that nothing is left (the list below).

## What survives a destroy

- **Everything in `prod`**, because it is `RETAIN`: the Aurora cluster, DynamoDB tables and their backups. They keep billing until deleted by hand.
- **Log groups.** CDK-created groups follow the stack's removal policy. A group a service created for itself has no retention and survives. This is why every log group is created in CDK (see [conventions.md](conventions.md)).
- **Secrets.** A deleted secret stays recoverable for a recovery window before it is gone.
- **The bootstrap stack.** `CDKToolkit` keeps an S3 bucket and an image repository for deployment assets, and the assets from earlier deploys stay in them. Its cost is small, and it is needed for the next deploy.
- **The budget and Identity Center,** which belong to the management account.

To confirm the account is clean after a full teardown, look at CloudFormation (only `CDKToolkit` should remain), then Aurora, DynamoDB, Secrets Manager, VPC endpoints, NAT gateways and CloudWatch log groups in `us-west-2`.

## Checking that Aurora pauses

A paused cluster costs storage only, so it is worth checking that it pauses and what holds it awake.

- The `ServerlessDatabaseCapacity` CloudWatch metric (namespace `AWS/RDS`, dimension `DBClusterIdentifier`) drops to 0 while the cluster is paused. For example, the minimum per hour over a day:

```
aws cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name ServerlessDatabaseCapacity --dimensions Name=DBClusterIdentifier,Value=<cluster-identifier> --start-time <start> --end-time <end> --period 3600 --statistics Minimum --region us-west-2 --profile storefront
```

- RDS events 0370 to 0374 report pausing and resuming. Look at the cluster's events in the console.
- If it never reaches 0, look for what keeps it busy: an open connection (even an idle one), an RDS Proxy, logical replication, a reader instance, or a probe that touches the database. Decision 0007 lists what the design avoids. Maintenance also resumes the cluster, and AWS then waits at least 20 minutes before pausing it again.
- Phase 6 checks this over several days, after the database stack exists.

## Pricing sources

Prices were read on 2026-11-06 from the public AWS price list files for `us-west-2` (`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<offer>/current/us-west-2/index.json`, published between 2026-09-11 and 2026-11-05): `AmazonVPC` for the endpoint and the public IPv4 address, `AmazonRDS` for Aurora, storage, I/O and the Data API, and `AWSSecretsManager` for secrets. The NAT gateway figure and the Pipes price come from the AWS pricing pages, as noted above. Check the [AWS pricing pages](https://aws.amazon.com/pricing/) again when you build, because prices change.
