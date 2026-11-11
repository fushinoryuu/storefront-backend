# 0011: Feature flags with LaunchDarkly

Status: accepted on 2026-11-11. One check is open: how many service connections the Lambda functions use (see Consequences).

## Context

The Storefront shows feature flags for real. The first uses come later: switching on the `advanceShipment` simulation route (Phase 4) and the "customers unavailable" simulation (Phase 5). Services evaluate flags themselves, and the backend exposes no flag state through its API (decided on 2026-11-02), because that would show outside callers which flags are on. The per-run stacks of a pull request are destroyed after the run, so anything a flag client needs that must outlive them, such as an SDK key, cannot belong to those stacks.

## Options

- **AWS AppConfig.** Inside the account, with no new vendor and no new secret, and a Lambda extension that caches. It is a configuration service more than a flag product, and fewer people use it for flags.
- **LaunchDarkly.** The product most teams know for flags, and a free Developer plan. It adds a vendor, an SDK in every bundle, a key per environment, and plan limits.
- **Where the SDK keys live.** Secrets Manager costs $0.40 per secret per month. An SSM SecureString parameter in the standard tier costs nothing, but then there are two ways to read a secret. The `services` API key is already read from Secrets Manager (decision 0009).

## Decision

Use LaunchDarkly, on the free Developer plan, and not AppConfig. This project exists to show what teams use, and LaunchDarkly is that.

- **Plan limits.** Found on 2026-11-02: free, unlimited seats, 1 project, 3 environments, 5 service connections a month, 1,000 client-side monthly active users, and going over a limit warns and then makes the plan read-only. [The pricing page](https://launchdarkly.com/pricing) was read again on 2026-11-11 and gives the same project, environment, connection and user figures, but no longer says what happens past a limit. The owner checks the billing page when the account is created, and the read-only behavior stays unverified until then.
- **Environments.** One project with two environments: `dev`, shared by every pull request run (the runs are serialized), and `prod`. The third environment stays spare. A stage uses the SDK key of the environment with its own name.
- **SDK keys.** One secret per environment in Secrets Manager, created by hand and not by CDK, so no per-run stack owns or deletes it. Its name follows `docs/conventions.md`: `storefront-<stage>-platform-launchdarkly-sdk-key`. A service reads it once per execution environment with `createSecretProvider`, and its Lambda role gets read access when the first service uses a flag. A key is never in code, config, a template or a log. The same cost line as the other secrets applies: about $0.80 a month for two.
- **Flag convention.** Every flag is a plain boolean with no targeting rules or percentage rollouts. ON serves `true` and OFF serves `false`, so a flag's state is the `on` value of its environment. A test that changes a flag is optional and puts the old value back afterwards.
- **The code never depends on LaunchDarkly.** `packages/shared` has a registry with the key, the default and the description of every flag the code knows, and `createFlagClient` takes only keys from it, so an unknown key fails typecheck. A flag is answered with its default when the SDK key cannot be read, the SDK is not ready within a configured timeout, it gives up, or an evaluation fails. The client reports each fallback so the service can log it. A simulation defaults to off.
- **One SDK, one context.** The SDK is created on the first evaluation and reused. Every evaluation uses one context per service (`kind: service`, `key: <service name>`), which also keeps the number of contexts at three. The service name is the SDK app id, so the usage page can show which service uses what. Evaluation events are not sent, because nothing here reads them and a Lambda function freezes between calls.
- **Reading a flag from outside.** The library and the tests read the state of a flag from the LaunchDarkly REST API with a personal token that has the built-in Reader role. Whether Reader is enough is checked when the token is made. Whether REST API calls count as a service connection is unverified.

## Consequences

- No service can fail because LaunchDarkly is down or out of plan. The cost is that a flag then silently has its default, so `onFallback` should be logged. While LaunchDarkly is down, every evaluation can wait up to the timeout, so a service picks a short one.
- Service connections for Lambda are counted by connection time, not by instance. [The documentation](https://launchdarkly.com/docs/home/account/service-connections) says a function that runs under a minute is sampled once a minute, and each sample counts as 1/43,800 of a connection, and that pre-production environments count. The earlier note in the Phase 1 doc that this is not documented is out of date. What our traffic costs is unverified: once the client runs in `dev` (the hello service in Phase 1), read the service connections usage page by app id, and record the number in this record. If it is too high, switch the SDK to polling or let fewer services read flags directly.
- A new SDK key takes effect only in execution environments that start after the change.
- The SDK (`@launchdarkly/node-server-sdk`, pinned to an exact version, Apache-2.0) adds to the bundle of every function that reads a flag. Its README supports Node.js 16 and above, and the unit tests here run on 24. Measure the bundle size and cold start when the first function is deployed, as in decision 0010.
- A manual step stays outside the code: the account, the project, the two environments, the two secrets and the Reader token.
- Source: [LaunchDarkly service connections](https://launchdarkly.com/docs/home/account/service-connections).
