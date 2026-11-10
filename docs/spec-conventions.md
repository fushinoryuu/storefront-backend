# Spec conventions

How the OpenAPI specs are written. The specs are the source of truth for the API (decision [0004](decisions/0004-api-definition.md)), and `npm run lint:specs` enforces what this page says it enforces.

## Files

| What                                | Where                                                      |
| ----------------------------------- | ---------------------------------------------------------- |
| Business spec, version 1            | `services/<service>/openapi.yaml`                          |
| Operational spec                    | `services/<service>/openapi-v0.yaml`                       |
| A later major                       | `services/<service>/openapi-v2.yaml`                       |
| Shared components                   | `specs/shared/components.yaml`                             |
| Shared path items (health, version) | `specs/shared/paths/*.yaml`                                |
| Bundled standalone files            | `specs/<service>-service-v<N>.yaml` (generated, committed) |

- Never edit a bundle. Change the source, run `npm run bundle:specs` and commit the result. CI fails when a bundle is stale.
- A source name promises its prefix: `openapi.yaml` is `/v1`, `openapi-v2.yaml` is `/v2`.
- Shared parts are referenced with relative `$ref`s, for example `../../specs/shared/components.yaml#/components/schemas/Problem`. They are checked through the specs that use them.
- OpenAPI 3.0.3 has no `components.pathItems`, so a shared path item is a file of its own that a spec references from `paths`.

## OpenAPI version

`openapi: 3.0.3`, always. Every spec has `info.license` with the name `GPL-3.0-only`, the license of this repository (OpenAPI 3.0 has no SPDX identifier field, so the name is the SPDX id). Nullable fields use `nullable: true`, never a type array. `oneOf` and `anyOf` are used only where the model needs them, and always with a `discriminator`.

## Versions and paths

- Every path starts with `/v<N>`, and a spec uses one prefix only.
- Business routes are under `/v1/...`. A later major is served next to it, under `/v2/...`.
- The operational routes `/v0/health`, `/v0/health/ready` and `/v0/version` live in the `/v0` spec of each service. Health and version routes appear nowhere else, and a `/v0` spec holds nothing else. `v0` means operational, not part of the versioned business contract.
- `info.version` is `x.y.z`, and its major matches the prefix. Exceptions: the `0.x` drafts of the first business version use `/v1`, and the `/v0` spec stays `0.x`. Drafts are `0.x`, and a spec becomes `1.0.0` when its service is implemented and matches it. Bump `info.version` on every change and tell the library project.
- There is no `servers` entry. Base URLs come from the stage manifest.
- `GET /v0/version` reports `specVersions`, an object keyed by prefix whose keys equal the bundle file suffixes (`v0`, `v1`, `v2`).

## Operations

- `operationId` is camelCase, a verb plus a noun (`getShipment`, `listOrders`, `cancelOrder`), and unique in its spec.
- An operation has exactly one tag. Business tags name the endpoint group (`customers`, `addresses`, `orders`, `products`, `shipments`, `simulation`). The tag `operations` is for the `/v0` routes, and only for them.
- Every operation has a `summary`.

## Security

- The only scheme is `apiKey`, an API key in the `x-api-key` header, declared in `components.securitySchemes`.
- Every operation requires it, through the global `security` or its own, except `GET /v0/health` and `GET /v0/version`, which declare `security: []`. `GET /v0/health/ready` requires a key.

## Errors

- The shared error schema is `Problem` (`type`, `title`, `status`, `detail`, `correlationId`, optional `errors[]`). It is not called `Error`, which collides with the JavaScript global in generated TypeScript.
- Every 4xx, 500 and 503 response is `application/json` with the `Problem` schema. A 503 documents its `Retry-After` header, in seconds.
- Every operation documents the shared `InternalError` response (500), because any handler can fail in a way its caller could not avoid. The 500 has no `detail`.

## Examples

Every request body and every response that has a body has an example, including the 4xx, 500 and 503 ones. The library's mock servers serve them. Redocly checks that each example matches its schema.

## Pagination

Lists take the shared `cursor` and `limit` query parameters (`limit` is 1 to 100 and defaults to 20) and return a page envelope: an object with `items` and a required, nullable `nextCursor` (the shared `NextCursor` schema). A cursor is opaque. OpenAPI 3.0 has no generic schemas, so each list defines its own page schema with that shape.

## Checking and bundling

```
npm run lint:specs              # Redocly structure and examples, plus the project rules below
npm run bundle:specs            # write specs/<service>-service-v<N>.yaml
npm run bundle:specs -- --check # what CI runs: fails if a bundle is stale, missing or orphaned
```

| Rule                              | What it enforces                                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openapi-version`, `info-version` | `openapi: 3.0.3` and an `x.y.z` version                                                                                                                                                          |
| `no-servers`                      | No `servers` on the document, a path item or an operation                                                                                                                                        |
| `no-gateway-extensions`           | No `x-amazon-apigateway-*` anywhere                                                                                                                                                              |
| `version-prefix`                  | One `/v<N>` prefix per spec, agreeing with the `info.version` major                                                                                                                              |
| `operational-routes`              | Health and version routes only in `/v0`, and only they in `/v0`                                                                                                                                  |
| `source-name`                     | The file name promises the prefix its paths use                                                                                                                                                  |
| `operation-id`                    | camelCase, a verb plus a noun                                                                                                                                                                    |
| `one-tag`                         | Exactly one tag, and `operations` only on `/v0` routes                                                                                                                                           |
| `security`                        | `apiKey` as above, and `security: []` on health and version                                                                                                                                      |
| `examples`                        | An example on every body                                                                                                                                                                         |
| `problem-responses`               | `Problem` on every 4xx, 500 and 503                                                                                                                                                              |
| `discriminator`                   | A warning for `oneOf` or `anyOf` without a discriminator                                                                                                                                         |
| Redocly rules                     | The `recommended` ruleset: valid OpenAPI structure, resolvable `$ref`s, unique `operationId`s, summaries, examples that match their schemas, a license. `lint.ts` lists the few rules turned off |
