# 0010: Observability toolkit

Status: accepted on 2026-11-04. Amended on 2026-11-10: the Node.js check is done, and the pinned Logger supports the runtime (see Consequences).

## Context

Every function must log structured JSON with the correlation id, service, stage and request id, trace requests with X-Ray, and emit a few business metrics in the embedded metric format (Phase 1, 4 and 6). Three services do this, so it is written once, in `packages/shared`. A reader of a portfolio project also expects to see the tools that people use in production.

## Options

- **Powertools for AWS Lambda (TypeScript).** A maintained library from AWS, with a Logger, a Tracer, and Metrics that sends custom metrics through the embedded metric format. It adds a dependency and its own conventions.
- **A small in-house layer.** A logger, a tracer wrapper and an EMF helper that we write. Few dependencies and full control, but we write and test code that a library already covers.

## Decision

Use Powertools for the Logger, the Tracer and Metrics, installed as npm packages and bundled by esbuild, not as a Lambda layer, so the version is pinned in the lockfile.

- `packages/shared` wraps them. Services import the wrapper and never Powertools, so the correlation id, the standard keys and the metric namespace are set in one place, and the toolkit can be swapped without touching the services.
- The wrapper adds `correlationId`, service, stage and request id to every log line.
- Other Powertools utilities are not part of this decision. The idempotency rules for orders (a stored response for a repeated key, a 409 for a different body) and for event consumers are our own, so `packages/shared` keeps its idempotency helper. A ticket that wants another utility checks it then.

## Consequences

- Logs, traces and metrics look the same in every service, and the wrapper is the one place to change.
- The library adds to the bundle of every function. Measure the bundle size and cold start when the first function is deployed (the throwaway service in Phase 1).
- Custom metrics are billed. Keep the list short: orders placed, orders cancelled, shipments created, transitions and end-to-end lag.
- Node.js support, checked on 2026-11-10 when the Logger was installed: its `package.json` has no `engines` field, so the support is read from the project. The Powertools repository runs the unit tests of every package on Node.js 22 and 24 (`reusable-run-linting-check-and-unit-tests.yml`), its README badge lists 22 and 24, and its root `package.json` requires `>=22`. This repository runs Node.js 24 (`.nvmrc`), which Lambda offers as `nodejs24.x` until 30 April 2028. `@aws-lambda-powertools/logger` is pinned to 2.36.0 (an exact version, not a range). Check again when the Lambda runtime moves to a newer Node.js.
- Source: [Powertools for AWS Lambda (TypeScript)](https://docs.aws.amazon.com/powertools/typescript/latest/).
