# Spec hand-off

For the people and projects that build on the Storefront API specs, mainly the `spec-driven-test-client` library, which generates typed clients from them. It says where the specs are, how they change, and what you cannot get yet. How the specs are written is in [spec-conventions.md](spec-conventions.md).

## Where the specs are

The specs you consume are the bundled files in [specs/](../specs/) on `main`. Each is one standalone OpenAPI 3.0.3 file with every `$ref` resolved, so a generator needs nothing else.

| File                                | What it holds                                             |
| ----------------------------------- | --------------------------------------------------------- |
| `customers-service-v1.yaml`         | The customers business API, under `/v1`                   |
| `customers-service-v0.yaml`         | The customers operational routes, under `/v0`             |
| `orders-service-v1.yaml`            | The orders business API, under `/v1`                      |
| `orders-service-v0.yaml`            | The orders operational routes, under `/v0`                |
| `shipping-service-v1.yaml`          | The shipping business API, under `/v1`                    |
| `shipping-service-v0.yaml`          | The shipping operational routes, under `/v0`              |
| `<service>-service-v2.yaml` (later) | A breaking change to a business API, served next to `/v1` |

- The name is `<service>-service-v<N>.yaml`. The suffix `v<N>` equals the path prefix of every route in the file and the key that `GET /v0/version` uses in `specVersions`.
- `v1` and later hold the business routes. `v0` is the operational spec: `GET /v0/health`, `GET /v0/version` and, for customers only, `GET /v0/health/ready`. Their `operationId`s are `getHealth`, `getVersion` and `getReadiness`, under the tag `operations`. A `v1` or `v2` spec has none of them. `v0` means operational, not pre-release.
- A new major is served next to the old one (`/v2` beside `/v1`), and each major is its own file, so a consumer sees every version as one more segment of the same service.
- The files in `services/<service>/` are the sources. Do not consume or edit them: they reference `specs/shared/`. Never edit a bundle either, because the next bundle run overwrites it. Spec changes are made in the source, and CI fails when a bundle is stale.
- Every spec has the shared `Problem` error schema on its 4xx and 503 responses, the `apiKey` security scheme (the `x-api-key` header), an example on every body, `nullable: true` for nullable fields, no `servers` entry and no API Gateway extensions. The rules are in [spec-conventions.md](spec-conventions.md).

Pull the files from a git ref of this repository, and record the commit and each `info.version` next to your copy. Published build artifacts come later, with the stage manifest (below).

## Drafts and how they change

- Every spec is a draft until its service is built and matches it. A draft has an `info.version` of `0.x.y` and may change freely. A spec becomes `1.0.0` when its service is implemented and matches it.
- `info.version` is bumped on every change to a spec. While a spec is a draft, a small change (wording, an example, a license block) raises the patch number, and a change that adds, removes or reshapes an operation or a schema raises the minor number. A change to `specs/shared/` bumps every spec whose bundle it changes.
- The repository owner tells the library project about every change, with the file name and the new `info.version`. The library project does not need to watch this repository for it.
- To see whether your copy is current, compare its `info.version` with the file on `main`. Once a service is deployed, `GET /v0/version` reports the `info.version` of every spec it serves in `specVersions`, so a client can compare that with the specs it was generated from.
- Planned changes to released specs (a non-breaking v1.1.0 and a breaking `/v2`) are written up in [spec-change-notes.md](spec-change-notes.md), so they can be rehearsed. They are not in the drafts.

## Running a mock server

Until real endpoints exist, a mock server can answer from a spec. [Prism](https://github.com/stoplightio/prism) works with these specs (checked with version 5.16.0):

```
npx @stoplight/prism-cli@5.16.0 mock specs/orders-service-v1.yaml -p 4010
```

Then call `http://127.0.0.1:4010/v1/products`. One mock serves one spec, so run each spec on its own port.

- The mock answers with the examples in the spec, which is why every body has one.
- It enforces the `apiKey` scheme. Send an `x-api-key` header with any value on every route except `GET /v0/health` and `GET /v0/version`, or the mock answers 401.
- To get a documented error, send `Prefer: code=409` (any status the route documents). The mock answers with that response's example.
- The mock validates requests. A request that breaks the spec gets the route's 422 response when it documents one, else its 400 response, else a 422 that Prism makes up. On `createOrder` the route documents a 422 for an unknown customer, so the mock answers an invalid request there with the unknown customer example. The real service answers a request that breaks the spec with 400.

## What is not available yet

- **Base URLs.** The specs have no `servers` entry. No stage is deployed yet. Base URLs will be published per stage in a stage manifest (service names, base URLs, the names of the secrets that hold the keys, the spec versions deployed, and the feature flag keys), together with the bundled specs as a build artifact.
- **API keys.** The platform stack creates three keys, one per kind of caller: `tests` (test suites and the library project), `services` (calls between services, never for tests) and `admin` (the shipping simulation route). Their values are generated on every deploy of a stage, so they change each time. A key retrieval script (`scripts/get-api-keys`) will read them after a deploy. Neither the stack nor the script exists yet. Key values never appear in this repository.
- **Planned spec changes.** The v1.1.0 and `/v2` specs are not written. See [spec-change-notes.md](spec-change-notes.md).

## Reporting a spec problem

Raise a bug ticket in the Jira project BEP of this project. Say which file and `info.version` you used, which `operationId` or schema is affected, what the generator or the mock did, and what you expected. Spec problems are fixed in the source spec here, never in a copy, and the fix comes with a new `info.version`.

## Feature flags

The backend uses LaunchDarkly for feature flags and exposes no flag state through the API, because that would show outside callers which flags are on. Where a flag changes what a route answers, the spec documents it. For example `advanceShipment` answers 404, the same as a route that does not exist, when its simulation flag is off.

- Storefront flags are plain booleans with no targeting rules, so a flag's state is the `on` value of the flag in a LaunchDarkly environment. Read it with the LaunchDarkly REST API.
- A personal API token with the built-in Reader role is enough for read-only access. This is to be confirmed when the token is created.
- The environments are `dev` (shared by every pull request run) and `prod`.
- The LaunchDarkly project key and the flag keys are not defined yet. They are listed here once the shared platform work defines them.
