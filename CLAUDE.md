# CLAUDE.md

Guidance for Claude Code in this repo. The rules themselves are in `docs/`; this file says where to find them and how to work.

## Read first

- `docs/ROADMAP.md` for the plan and `docs/roadmap-phases/` for each phase.
- `docs/conventions.md` for naming, tags, events, errors, branches, commits, pull requests and decision records.
- `docs/spec-conventions.md` for the OpenAPI specs.
- `docs/decisions/` for why things are the way they are. Do not contradict an accepted record. Amend the record for a small change, and write a new record that supersedes it only for a major rework (see `docs/conventions.md`).

## How to work

- Every change belongs to a Jira ticket in project BEP. Work on a branch whose name starts with the ticket key, never on `main`.
- Commit messages follow `docs/conventions.md`. Leave pushing to the maintainer.
- Write the pull request title and description as `docs/conventions.md` describes, using `.github/pull_request_template.md`.
- Do not create, edit or transition Jira tickets unless asked.
- Keep to the ticket's scope. Mention related work instead of doing it.
- Tick a roadmap checkbox only when the work behind it is finished and true.

## Rules that are easy to break

- The API is spec-first. Change the source spec under `services/<service>/` or `specs/shared/`, then run `npm run bundle:specs`. Never edit a bundle in `specs/` by hand.
- Routes are defined in CDK. Specs have no `servers` entry and no `x-amazon-apigateway-*` extensions.
- Stage-specific values come from `infra/lib/config/stages.ts`. Do not write a stage, a stack name or a retention period inline.
- Never put an API key value, a secret or an AWS credential in code, config or the repo.

## Before you say it is done

Run what CI runs: `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`, `npm run lint:specs`, `npm run bundle:specs -- --check` and `npm run synth`.
