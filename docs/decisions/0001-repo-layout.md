# 0001: One repository with a single package

Status: accepted on 2026-11-03. Amended on 2026-11-09: this repo's integration tests use the library as a dev dependency (last bullet of the decision).

## Context

The project is three small services, two shared libraries, one CDK app and a set of OpenAPI specs, built by one person. The CDK app deploys all of it, and a change often spans infrastructure, a service and its spec. The spec-driven-test-client library is a separate product that consumes our specs.

## Options

- **One repo, one package.** One `package.json`, one lockfile and one install. The services and packages are plain folders.
- **One repo, npm workspaces.** Each service and package has its own `package.json`. Versions and dependencies are tracked per package, at the cost of more files and wiring that a project this size does not use.
- **One repo per service.** Independent versioning and deploys, but three CDK apps or a cross-repo contract for shared code, and every cross-service change becomes several PRs.

## Decision

One repo with a single package. The layout is:

| Path        | Contents                                                           |
| ----------- | ------------------------------------------------------------------ |
| `infra/`    | The CDK app: stage config, stacks, constructs, aspects and tests   |
| `services/` | `customers`, `orders` and `shipping`: handlers, domain code, tests |
| `packages/` | `shared` (logger, errors, correlation id) and `events`             |
| `specs/`    | Shared OpenAPI components and the bundled specs                    |
| `scripts/`  | Repo tooling, such as the spec lint and bundle commands            |
| `docs/`     | Roadmap, conventions and decision records                          |

- One root `tsconfig.json` in strict mode, with no project references. Node.js is pinned in `.nvmrc` and `engines`, and the CDK CLI is a dev dependency, so everyone runs the same versions.
- A service imports from `packages/` and never from another service. Services talk to each other through their APIs and events.
- The library lives in its own repository. The contract between the two repos is the bundled spec files, and no deployed code depends on the library. The one code dependency is in the other direction: the integration tests in this repo use the library as a dev dependency, installed from its published package, to call the services with typed clients (Phase 5).

## Consequences

- One install, one lint, typecheck and test run, and one CI workflow. A change across infra, a service and a spec is one PR.
- There is no version management between packages, so a breaking change in `packages/shared` or `packages/events` must update every caller in the same PR.
- Every service sees the same dependency set. Each Lambda is bundled with esbuild from its own imports, so this does not make deployments larger.
- Nothing yet stops a service from importing another service's code. If that slips, add a lint rule.
- Splitting a service into its own repo later would mean giving it a `package.json` and publishing the shared packages, which is real work, and not expected.
