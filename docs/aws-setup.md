# AWS setup

How the AWS account is set up for this project, and how to repeat it. Account ids, the access portal URL, email addresses and budget amounts are not written here. Keep them out of the repo.

## Account and region

- The project runs in its own AWS account, a member account of an AWS Organization. The management account holds only Organizations, IAM Identity Center and billing. No stack is deployed there.
- Both stages (`dev` and `prod`) live in the member account, in one region: `us-west-2` (Oregon). See [decision 0002](decisions/0002-stack-boundaries-and-stages.md).
- The root user of each account is for setup and billing only, with MFA on. Do not create access keys for it, and do not use it for deployments.

## Local credentials

Local work uses short-lived credentials from IAM Identity Center (SSO). There are no long-lived access keys.

1. In IAM Identity Center, create a user for yourself and assign it to the member account with a permission set. `AdministratorAccess` is needed for the bootstrap, because it creates IAM roles. Keep the session duration short.
2. Install the AWS CLI v2, then create the profile. It asks for the access portal URL (shown on the Identity Center dashboard) and the SSO region:

```
aws configure sso --profile storefront
```

3. Choose the member account when the CLI lists the accounts, set the default region to `us-west-2`, and name the profile `storefront`.
4. Log in whenever the session expires, then check which account you are in:

```
aws sso login --profile storefront
aws sts get-caller-identity --profile storefront
```

The result must show the member account. Pass `--profile storefront` to every `aws` and `cdk` command, or set `AWS_PROFILE=storefront` for the shell.

## CDK bootstrap

Bootstrap creates the `CDKToolkit` stack that `cdk deploy` needs. It is done once for the account and region:

```
npx cdk bootstrap --profile storefront
```

The command uses the account from the profile, so nothing in it has to be copied from a console. It needs no stage, because `dev` and `prod` share the account and region.

To check, open CloudFormation in `us-west-2` in the member account and look for the `CDKToolkit` stack. Running the command again prints "bootstrapped (no changes)".

## LaunchDarkly SDK keys

The `Storefront-Secrets` stack creates one empty secret for the SDK key of each LaunchDarkly environment (decision 0011). It belongs to no stage, so it is deployed once, without one, and a test run never destroys it. Deploy it, then put each key in. The `cdk` commands select the stack by its id in the app, `Secrets`, and not by its CloudFormation name `Storefront-Secrets`, which gives "No stacks match". `npx cdk ls` shows both, as `Secrets (Storefront-Secrets)`. In PowerShell, so that the key is typed hidden and stays out of the shell history:

```
npx cdk deploy --profile storefront Secrets
$key = Read-Host "dev SDK key" -MaskInput
aws secretsmanager put-secret-value --region us-west-2 --profile storefront --secret-id storefront-dev-secrets-launchdarkly-sdk-key --secret-string $key
```

Then repeat the last two commands with `prod` in the two places. Use the **SDK key** of the environment (LaunchDarkly: the gear icon, **Projects**, the project, **Environments**), not the mobile key or the client-side ID. To remove both secrets, run `npx cdk destroy --profile storefront Secrets`. Secrets Manager keeps a deleted secret for a recovery window and does not bill it meanwhile.

## API keys

The platform stack of a stage owns three API Gateway keys, `tests`, `services` and `admin` (decision 0005), and publishes only their ids to SSM. After each deploy of the stack, write the values to a local file that git ignores:

```
npm run get-api-keys -- --stage dev
```

The command reads the ids from `/storefront/<stage>/platform/<kind>-api-key-id` and the values from API Gateway, and writes `.api-keys/<stage>.json`, readable only by you. It prints the kinds and the path, never a value. The `dev` stack is destroyed after each test run, so its keys change on every deploy and the command has to run again.

## Alarm emails

The alarm topic of the platform stack emails the addresses in the `ALARM_RECIPIENTS` environment variable, a comma-separated list. It is read when the stack is built, so no address is in the repo. Each address gets a confirmation email from AWS, and has to follow its link before it receives anything.

Put the variable in a `.env` file at the repo root, which git ignores and the CDK app loads:

```
ALARM_RECIPIENTS=you@example.com
```

Or set it for one command, which wins over the file:

```
ALARM_RECIPIENTS=you@example.com npx cdk deploy --profile storefront -c stage=prod Platform
```

- A `.env` file applies to every stage. Its stack is destroyed after every run, so a `dev` deploy with an address sends a new confirmation email each time. Deploy `dev` without the variable unless you are checking the subscription (with `ALARM_RECIPIENTS=` on the command line, an empty value wins over the file).
- Have the variable on every deploy of a stage that has recipients. A deploy without it removes the subscription. When deploys move to a workflow (Phase 6), set it there once, as a repository variable, and it is always present. No file is needed there.
- A value that is not an email address stops the build with a one-line message that does not repeat the value.

## Availability in `us-west-2`

Checked on 2026-11-06 with the `storefront` profile.

- **EventBridge Pipes.** `aws pipes list-pipes --region us-west-2 --profile storefront` answered with an empty list and no error, so the service is available. The AWS General Reference also lists a Pipes endpoint for the region.
- **Aurora Serverless v2 scale to zero.** Every Aurora PostgreSQL engine version in the region, from 13.23 to 18.6, reports a minimum capacity of 0 ACUs (and a maximum of 256 or 384). To repeat the check:

```
aws rds describe-db-engine-versions --engine aurora-postgresql --region us-west-2 --profile storefront --query 'DBEngineVersions[?ServerlessV2FeaturesSupport.MinCapacity==`0`].{version:EngineVersion,min:ServerlessV2FeaturesSupport.MinCapacity,max:ServerlessV2FeaturesSupport.MaxCapacity}' --output table
```

Scale to zero therefore does not limit which engine version the database stack can use. The RDS Data API also has to support the version (see the [ROADMAP](ROADMAP.md) facts).

## Budget

An AWS Budget guards the spend before anything is deployed:

- A monthly cost budget in the management account, filtered to the member account, so it counts only this project.
- Email alerts at low thresholds, on actual and forecast spend. The limit and the addresses are the owner's choice and are not recorded here.
- Billing data lags by up to about a day, so the alert is a safety net, not a plan. [cost.md](cost.md) explains what the project costs and where.
- Tuning the thresholds after real usage is part of the Phase 6 cost review.

## What is not set up yet

- GitHub Actions access to AWS (an OIDC role). That arrives in Phase 6.
- Any deployed stack except `Secrets`, which is deployed. The platform stack comes next.
