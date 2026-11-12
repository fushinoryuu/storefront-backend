# Conventions

How we name things, record decisions and work with Git. The rules for the OpenAPI specs are in [spec-conventions.md](spec-conventions.md). The reasons behind the larger choices are in [decisions/](decisions/).

## Resource naming

- A stack is named `Storefront-<stage>-<Service>`, for example `Storefront-dev-Customers`. `<stage>` is `dev` or `prod`, and `<Service>` is `Platform`, `Database`, `Customers`, `Orders` or `Shipping`. `stackName()` in `infra/lib/naming.ts` builds it, so use it instead of writing the string. The one stack that belongs to no stage is `Storefront-Secrets` (`sharedStackName()`).
- Leave physical names out and let CloudFormation generate them (no `bucketName`, `tableName` or `functionName`). Generated names include the stack name, so stage and service are already in them. A fixed name also stops CloudFormation from replacing the resource when a change needs it.
- When a name has to be fixed, because another stack or an outside tool looks it up, use `storefront-<stage>-<service>-<purpose>` in lowercase, for example `storefront-dev-platform-bus`.
- SSM parameters are `/storefront/<stage>/<service>/<name>`, with a lowercase, hyphenated name, for example `/storefront/dev/platform/event-bus-name`.
- Construct ids inside a stack are PascalCase.

## Tags

Every taggable resource carries `project` (`storefront`), `stage` (`dev` or `prod`), `service` (the stack's `<Service>`) and `owner`. The `StandardTags` aspect adds them, so a new stack calls `applyStandardTags` and never sets these tags by hand. A template test checks that they are present.

## Logs

Every log group the app creates has its retention set explicitly, from `logRetention` in the stage config (one week in `dev`, one month in `prod`). Create the log group in CDK and pass it to the function. Never leave the default, which keeps logs forever.

## Events

- `source` is `storefront.<service>` with the service in lowercase: `storefront.orders`, `storefront.shipping`.
- `detail-type` is PascalCase and past tense, an entity followed by what happened to it: `OrderPlaced`, `OrderCancelled`, `ShipmentDispatched`, `ShipmentDelivered`. An event states a fact that already happened, never a command.
- The envelope and the event schemas live in `packages/events`.

## Errors

Every error response from every service has the shape of the `Problem` schema in `specs/shared/components.yaml`: `type`, `title`, `status`, `detail`, `correlationId` and, for validation errors, an `errors[]` list. That includes the responses API Gateway produces itself for a missing key (403) and for throttling (429), which are customized to match. `correlationId` comes from the `x-correlation-id` request header, or is generated when the header is missing. The rules for documenting errors in a spec are in [spec-conventions.md](spec-conventions.md).

## Branches

- Work happens on a branch from `main`. `main` changes only through a pull request.
- A branch name starts with the Jira ticket key, then a short lowercase description: `BEP-123-add-address-api`.
- Pipelines derive the pull request's database schema from the key at the start of the branch name:
  - lowercase, with the hyphen replaced by an underscore: `BEP-123` becomes `bep_123`;
  - at most 63 bytes, the PostgreSQL limit for an identifier;
  - the `main` branch uses the fixed schema `main`.
- A derived name always ends in an underscore and digits, so it can never equal `main`. A pipeline fails when a branch has no key, or the name is too long. It must not shorten the name, because two branches could then end up sharing a schema.

## Commits

- One logical change per commit. The subject is a short sentence in the imperative that says what the commit does: `Add stage config, naming and removal policy helpers`.
- No Jira key and no type prefix in the subject. The branch name already carries the key.
- Add a body only when the reason is not obvious from the change.

## Pull requests

- One ticket is one pull request, and it stays reviewable: roughly 500 changed lines or fewer, not counting lockfiles.
- The title starts with the Jira key: `BEP-15: Add spec foundations`. The description starts with a link to the ticket and follows `.github/pull_request_template.md`.
- Before opening it, run what CI runs:

```
npm run lint
npm run format:check
npm run typecheck
npm test
npm run lint:specs
npm run bundle:specs -- --check
npm run synth
```

## Decision records

- A decision record explains a choice that is costly to reverse or that a later reader would otherwise have to guess. It lives in `docs/decisions/NNNN-short-title.md`.
- `NNNN` is a four-digit number, the next free one. Numbers are never reused or renumbered. Copy [decisions/0000-template.md](decisions/0000-template.md) to start one.
- A record has Context, Options, Decision and Consequences, and fits on about one page.
- The `Status:` line is `proposed`, `accepted on <date>` or `superseded by <number>`. It may end with a short note, for example `accepted on 2026-11-02. To be revisited after Phase 5.`
- A small change to an accepted record is made in the record itself. Edit the text that changed, and add `Amended on <date>: <what changed>` to the `Status:` line. A change is small when the decision stays the same: a correction, a clarification, a detail that moved, or a consequence that was added or reworded.
- A major rework needs a new record that supersedes the old one, and only the old record's `Status:` line is updated. A change is major when it reverses the decision, picks a different option, or removes what the Consequences rest on. Do not write a new record for a small change.
