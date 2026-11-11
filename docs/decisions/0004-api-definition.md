# 0004: API definition is spec-first

Status: accepted on 2026-11-02. Amended on 2026-11-10: the Zod plugin is checked and the generated code is built, not committed (see Decision). To be revisited after Phase 5.

## Context

The spec-driven-test-client library generates typed clients from our OpenAPI specs, and it cannot start its own work until draft specs exist. That means the contract has to exist before any service does. Three constraints shape the choice:

- Routes are defined in CDK, and API Gateway integration details must not leak into the specs the library consumes.
- Zod is a skill this project wants to show, so the way the code is tied to the spec should make room for it.
- A spec nobody checks drifts from the code, so linting, bundling and conformance checks have to be part of the design.

## Options

**Where the contract comes from.**

- Spec-first: hand-written OpenAPI files are the source of truth, and the code is built to match. The drafts can exist before the services.
- Code-first: Zod schemas generate the spec. This cannot give the library drafts before the code exists.

**How the code stays tied to the spec.**

- (a) Validate at runtime with the JSON schemas from the spec (for example with Ajv), and test every response against the spec. No duplicates, but no Zod, and 3.0 schemas need a small conversion first.
- (b) Generate TypeScript types from the spec and keep runtime validation separate. Types and validators can drift apart.
- (c) Write the Zod schemas by hand, and test that each converts to the JSON Schema in the spec (`z.toJSONSchema` with the `openapi-3.0` target). It shows the most Zod skill, but every schema is written twice and the comparison has to ignore differences like descriptions and `$ref` layout.
- (d) Generate the Zod schemas from the spec. No duplicates, so no drift by construction. The generated code has to be managed.

**Spec dialect and tooling.**

- OpenAPI 3.0.3 against 3.1. 3.0.3 has the most documentation, and Zod 4 and the common TypeScript generators support it. Moving to 3.1 later is mostly mechanical (`nullable` becomes a type array) but touches every spec.
- Redocly against Spectral. Redocly lints and bundles with one dependency and a programmatic API, and Spectral would need a second tool to bundle.

## Decision

- Spec-first, OpenAPI 3.0.3. The hand-written sources are `services/<service>/openapi.yaml` (the `/v1` spec), `openapi-v0.yaml` (the operational routes) and, later, `openapi-v2.yaml`. Shared parts live in `specs/shared/`.
- Routes stay defined in CDK. The specs have no `x-amazon-apigateway-*` extensions and no `servers` entry. Base URLs come from the stage manifest.
- The versioning rule:
  - Every path starts with a version prefix and one spec has one prefix. Business routes are under `/v1/...`, and a later major is served next to it (`/v2/...`).
  - Operational routes (`/v0/health`, `/v0/health/ready`, `/v0/version`) live under the reserved prefix `/v0`, in their own small spec per service, defined once and never repeated in a business spec. `v0` means operational, not part of the versioned business contract.
  - A spec's `info.version` major matches its prefix. Exceptions: the `0.x` drafts of the first business version use `/v1`, and the `v0` spec stays `0.x`.
  - Each prefix is its own bundle, named `specs/<service>-service-v<N>.yaml`. The bundles are committed, and CI fails when one is stale.
- Tie to the spec, for now: option (d). Zod 4 schemas and types are generated from the bundled specs with the Zod plugin of `@hey-api/openapi-ts`, the generator the library uses. Handlers validate requests with the generated schemas, and handler tests check responses against the spec (Phase 5 adds the conformance suite). The shared integrations work in Phase 1 wires this up.
  - Checked on 2026-11-10 with `@hey-api/openapi-ts` 0.99.0 (pinned to an exact version) and its `zod` plugin: all six bundles generate. A 3.0 `nullable: true` becomes `.nullable()`, and each operation gets a schema for its body, its path parameters, its query and its headers. The output depends on the TypeScript version: it works with the 6.0.3 of this repository and fails to start with 7.0.2, so TypeScript stays on 6.x until the plugin supports 7.
  - The generated code is built, not committed. `npm run generate:schemas` writes `generated/<bundle>/zod.gen.ts` (ignored by git, ESLint and Prettier) from the committed bundles, and `npm test` and `npm run typecheck` run it first. The bundles stay the one thing a reviewer checks, and a stale copy cannot exist.
  - Query, path and header values arrive as text, and the generated schemas expect numbers where the spec says so. `validateParameters` in `packages/shared` turns the text into the type the schema asks for before it validates.
- Planned move to option (c). After Phase 5, when the three specs are at 1.0.0, the hand-off is done and the library has run against them, we revisit this and expect to switch to hand-written Zod with a drift test against the spec. The outcome is a new ADR that supersedes this one. The spec stays the source of truth throughout, and moving to code-first is a separate step that is not planned.
- Tooling: Redocly (`@redocly/openapi-core`) does the structural lint, example validation and bundling. The project rules are TypeScript checks over the bundled document (`scripts/specs/checks.ts`) and are listed in `docs/spec-conventions.md`. `npm run lint:specs` runs them, and `npm run bundle:specs` writes the bundles (`-- --check` is what CI runs).

## Consequences

- The library can generate clients from the drafts before anything is built, and the contract leads the code.
- With (d) there is one definition of every schema, so request validation cannot drift from the spec. The cost is generated code in the repo or the build, and a dependency on the plugin's quality.
- Moving to (c) later means writing a Zod schema for each spec schema and adding a drift test, then deleting the generated code. Doing (d) first gives us the spec-derived schemas to compare the hand-written ones against.
- Every spec change needs a regenerated bundle, and CI enforces that.
- The path prefix is part of the contract, so changing it later would be a breaking change for every client.
- The project rules are our own code, so we maintain them, but each rule has a unit test and a message that says what to fix.
- Staying on 3.0.3 rules out type arrays, `webhooks` and `components.pathItems`. Shared path items therefore live in their own files under `specs/shared/` and are referenced from each spec.
