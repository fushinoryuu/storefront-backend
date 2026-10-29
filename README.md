# storefront-backend

A small backend for a fake online store, built on AWS with CDK in TypeScript. Three microservices (customers, orders, shipping), each with a different data store and communication style.

The plan, decisions and phases are in [docs/ROADMAP.md](docs/ROADMAP.md).

## Requirements

- Node.js 24 (the version in `.nvmrc`)
- npm 11 or newer

## Commands

Run these from the repo root:

| Command | What it does |
|---|---|
| `npm ci` | Install dependencies from the lockfile |
| `npm run lint` | Lint with ESLint |
| `npm run format:check` | Check formatting with Prettier (`npm run format` fixes it) |
| `npm run typecheck` | Typecheck the whole repo |
| `npm test` | Run all tests with vitest |
| `npm run synth` | Synthesize the CDK app for `dev` and `staging` into `cdk.out/` (no AWS credentials needed) |

The CDK app needs a stage: `npx cdk synth -c stage=dev` or `-c stage=staging`.

## Layout

| Path | Contents |
|---|---|
| `infra/` | CDK app |
| `services/` | `customers`, `orders`, `shipping` |
| `packages/` | `shared` and `events` libraries |
| `specs/` | OpenAPI shared components and bundled specs |
| `scripts/` | Helper scripts |
| `docs/` | Roadmap, phase docs and decision records |
