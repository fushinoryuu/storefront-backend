# storefront-backend

A small backend for a fake online store, built on AWS with CDK in TypeScript. Three microservices (customers, orders, shipping), each with a different data store and communication style.

The plan, decisions and phases are in [docs/ROADMAP.md](docs/ROADMAP.md).

## Requirements

- Node.js 26 (the version in `.nvmrc`)
- npm 11 or newer

## Commands

Run these from the repo root:

| Command                               | What it does                                                                                                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                              | Install dependencies from the lockfile                                                                                                                                                                                                            |
| `npm run lint`                        | Lint with ESLint                                                                                                                                                                                                                                  |
| `npm run format:check`                | Check formatting with Prettier (`npm run format` fixes it)                                                                                                                                                                                        |
| `npm run typecheck`                   | Typecheck the whole repo                                                                                                                                                                                                                          |
| `npm run generate:schemas`            | Generate the Zod schemas from the bundled specs into `generated/` (not committed; `npm test` and `npm run typecheck` run it first)                                                                                                                |
| `npm test`                            | Run all tests with vitest (`-- --coverage` also writes a coverage report to `coverage/`, which git ignores). Start DynamoDB Local first with `docker compose up --detach --wait`, or the idempotency tests fail (see `packages/shared/README.md`) |
| `npm run lint:specs`                  | Lint the OpenAPI specs (Redocly plus the project rules in `docs/spec-conventions.md`)                                                                                                                                                             |
| `npm run bundle:specs`                | Write the bundled specs to `specs/` (`-- --check` is what CI runs: fails if one is stale)                                                                                                                                                         |
| `npm run synth`                       | Synthesize the CDK app for `dev` and `prod` into `cdk.out/` (no AWS credentials needed)                                                                                                                                                           |
| `npm run get-api-keys`                | Write the three API key values of a stage to `.api-keys/<stage>.json`, which git ignores (`-- --stage dev`, after the platform stack is deployed; `docs/aws-setup.md`)                                                                            |
| `npm run aws:login`                   | Sign in to the `storefront` AWS profile with SSO and print the identity, which the deploy scripts need (`docs/aws-setup.md`)                                                                                                                      |
| `npm run deploy:all`                  | Deploy every stack the app builds, with the `storefront` profile. With `-- -c stage=dev` (or `prod`) that is the stacks of the stage and the two shared ones, and without a stage only the two shared ones (`Secrets`, `ApiGatewayAccount`)       |
| `npm run deploy:secrets`              | Deploy the `Secrets` stack, which belongs to no stage, with the `storefront` profile (`docs/aws-setup.md`)                                                                                                                                        |
| `npm run destroy:secrets`             | Destroy the `Secrets` stack, which deletes both LaunchDarkly SDK key secrets. CDK asks for confirmation first                                                                                                                                     |
| `npm run deploy:api-gateway-account`  | Deploy the `ApiGatewayAccount` stack, the account-wide API Gateway logging role, with the `storefront` profile (`docs/aws-setup.md`)                                                                                                              |
| `npm run destroy:api-gateway-account` | Destroy the `ApiGatewayAccount` stack, which deletes the logging role. It has termination protection, which must be turned off first (`docs/aws-setup.md`)                                                                                        |
| `npm run deploy:platform`             | Deploy the `Platform` stack of a stage with the `storefront` profile (`-- -c stage=dev`, or `prod`). `ALARM_RECIPIENTS=you@example.com` in front subscribes the alarm topic (`docs/aws-setup.md`)                                                 |
| `npm run destroy:platform`            | Destroy the `Platform` stack of a stage (`-- -c stage=dev`, or `prod`), with everything it made. CDK asks for confirmation first. The service stacks of the stage depend on it, so destroy them first                                             |

The CDK app builds the stacks of a stage when it is given one: `npx cdk synth -c stage=dev` or `-c stage=prod`. Without a stage it builds only `Storefront-Secrets` and `Storefront-ApiGatewayAccount`, which belong to no stage.

## Layout

| Path        | Contents                                    |
| ----------- | ------------------------------------------- |
| `infra/`    | CDK app                                     |
| `services/` | `customers`, `orders`, `shipping`           |
| `packages/` | `shared` and `events` libraries             |
| `specs/`    | OpenAPI shared components and bundled specs |
| `scripts/`  | Helper scripts                              |
| `docs/`     | Roadmap, conventions and decision records   |
