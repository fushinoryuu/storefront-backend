# CLAUDE.md

Guidance for Claude Code in this repo. The rules themselves are in `docs/`; this file says where to find them and how to work.

## Read first

- `docs/ROADMAP.md` for the plan and `docs/roadmap-phases/` for each phase.
- `docs/conventions.md` for naming, tags, events, errors, branches, commits, pull requests and decision records.
- `docs/spec-conventions.md` for the OpenAPI specs.
- `docs/decisions/` for why things are the way they are. Do not contradict an accepted record. Amend the record for a small change, and write a new record that supersedes it only for a major rework (see `docs/conventions.md`).
- `TODO.md` at the repo root, if it exists (see below).

## How to work

- Every change belongs to a Jira ticket in project BEP. Work on a branch from `main` whose name starts with the ticket key, never on `main`.
- One ticket is one pull request. If a change will pass about 500 changed lines (lockfiles do not count), say so and ask how to split it before building it.
- Do not create, edit or transition Jira tickets unless asked.
- Keep to the ticket's scope. Mention related work instead of doing it. If a pull request does change something the ticket does not cover, list it in the description with the reason.
- Tick a roadmap checkbox only when the work behind it is finished and true. For work that is partly done, leave the box unticked and add sub-bullets that list what is done and what remains.
- Keep Jira ticket keys out of `docs/`, decision records, specs and code comments. A key belongs in a branch name, a pull request, a commit hand-over and Jira. Examples of the branch format in `docs/conventions.md` are fine.
- Never push. Run `git commit` only when asked.
- When you are asked how you will address something, such as a review comment, answer with the plan and wait for the go-ahead before you change anything.

## What the maintainer wants from a design

- This is a portfolio project. Keep the patterns real teams use (API versioning, feature flags, idempotency) even when they cost extra. Do not suggest dropping one to save scope or money. Say what it costs and what it changes, recommend one design, and let the maintainer decide.
- Cost still matters, because the AWS account is paid for personally. State the cost of a choice, and prefer the cheaper option when two fit.
- Prefer a product that is widely used over an AWS-only alternative when it helps the project show what teams use.
- Everything runs in one AWS account in `us-west-2`, with the stages `dev` and `prod`. Do not plan for a separate production account.

## Handing work over

When the work for a ticket is built, give the maintainer:

- The commits, in order, in one code block: a `git add` and a `git commit -m "..."` for each. Each commit is one logical change with a plain message and no ticket key.
- A pull request title that starts with the ticket key, and a description that follows `.github/pull_request_template.md`.
  - It starts with the link to the ticket.
  - It does not repeat the acceptance criteria. They live in the ticket.
  - It lists everything the pull request changes, states its size, and says what has not been verified.
  - Update it when the branch changes, so the numbers and the list stay true.

A reviewer's findings are posted as a Jira comment. The fixes go on the same branch as new commits.

## TODO.md

`TODO.md` is the maintainer's scratch file. It is not in git, so a new machine starts without it.

- Read it at the start of every turn, because the maintainer edits it between messages.
- The "Personal items" section is the maintainer's. Never edit it.
- The "Decisions" section holds questions waiting on the maintainer and things to verify. Add an item when you need an answer and cannot get it now. Remove it once the answer lives in the docs, a decision record or Jira. Do not put in it what is already written there.
- It may name tickets.

## Rules that are easy to break

- The API is spec-first. Change the source spec under `services/<service>/` or `specs/shared/`, then run `npm run bundle:specs`. Never edit a bundle in `specs/` by hand.
- Routes are defined in CDK. Specs have no `servers` entry and no `x-amazon-apigateway-*` extensions.
- Stage-specific values come from `infra/lib/config/stages.ts`. Do not write a stage, a stack name or a retention period inline.
- Never put an API key value, a secret or an AWS credential in code, config or the repo.
- The Zod schemas in `generated/` are built, not committed. `npm run generate:schemas` writes them, and `npm test` and `npm run typecheck` run it first. TypeScript stays on 6.x, because the generator fails on 7 (decision 0004).
- Services import `packages/shared` and never Powertools itself (decision 0010). Calls from one service to another go through the shared HTTP client (decision 0009).

## Before you say it is done

Run what CI runs: `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`, `npm run lint:specs`, `npm run bundle:specs -- --check` and `npm run synth`. If one fails or is skipped, say which and show why.

On Windows, run `npm test` from PowerShell. From Git Bash, a working directory with a lower-case drive letter (`cd /d/...` gives `d:\...`) makes vitest load twice, and every test fails with "Cannot read properties of undefined (reading 'config')". `cd "D:/..."` with an upper-case letter avoids it. `npm test` starts DynamoDB Local in a container for the tests that need it. With no container runtime running those tests are skipped, so say so when you report the run, and in CI they fail instead (see `packages/shared/README.md`).
