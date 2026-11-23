# Conventions

How we name things, record decisions and work with Git. The rules for the OpenAPI specs are in [spec-conventions.md](spec-conventions.md). The reasons behind the larger choices are in [decisions/](decisions/).

## Resource naming

- A stack is named `Storefront-<stage>-<Service>`, for example `Storefront-dev-Customers`. `<stage>` is `dev` or `prod`, and `<Service>` is `Platform`, `Database`, `Customers`, `Orders` or `Shipping`. `stackName()` in `infra/lib/naming.ts` builds it, so use it instead of writing the string. The stacks that belong to no stage are `Storefront-Secrets` and `Storefront-ApiGatewayAccount` (`sharedStackName()`).
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
- The one exception is a Dependabot branch (`dependabot/...`), which has no key. The CI workflow runs on it, because it needs no AWS access and no secrets. A pipeline that deploys a pull request to `dev` skips these branches instead of failing, and never derives a schema for one. See [Dependencies](#dependencies).

## Commits

- One logical change per commit. The subject is a short sentence in the imperative that says what the commit does: `Add stage config, naming and removal policy helpers`.
- No Jira key and no type prefix in the subject. The branch name already carries the key.
- Add a body only when the reason is not obvious from the change.

## Pull requests

- One ticket is one pull request, and it stays reviewable. About 500 changed lines, not counting lockfiles, is the guide: a change that will pass it is raised before it is built, and the maintainer decides whether to split it or go over. The description lists what the pull request changes and does not state its size.
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

## Dependencies

Dependabot (`.github/dependabot.yml`) checks the npm packages and the GitHub Actions every Monday. It opens one pull request for `vitest` and its coverage provider (every update type, major included), one for all the other minor and patch updates of an ecosystem, and one for each other major update, with at most five open per ecosystem. It also raises an alert for each advisory that affects a locked version.

- A Dependabot branch and pull request have no Jira key, and their title and commit message are Dependabot's (`Bump x from a to b`). The rules for keys in branches and titles do not apply to them (see [Branches](#branches)). Nothing is merged automatically: a person reviews each one like any other pull request.
- Dependencies use a `^` range, and the lockfile fixes the version that is installed. Two are pinned to an exact version, each for a reason:
  - `@hey-api/openapi-ts` is a 0.x package, where a minor release can change the generated code, and decision 0004 was checked against the pinned version, including the TypeScript versions it works with.
  - `esbuild` is a 0.x package too, and `allowScripts` in `package.json` names the exact version it approves, so a range would stop approving it. The Dependabot pull request that bumps it changes `allowScripts` to the same version.
- `vitest` and `@vitest/coverage-v8` are one group in `dependabot.yml`, because each release of the coverage provider needs exactly the same version of `vitest`. A bump of one without the other fails to install.
- Before merging a dependency pull request, the reviewer:
  - for a pinned package, reads the decision record that names it (0004 for the generator), including the versions it was checked against;
  - for `@aws-lambda-powertools/logger` and `@launchdarkly/node-server-sdk`, reads the Node.js support that decisions 0010 and 0011 checked, and checks it again when the Lambda runtime moves to a newer Node.js;
  - runs the seven commands under [Pull requests](#pull-requests). CI runs them too, and the reviewer reads the result.
- A grouped pull request holds many packages, so the reviewer reads the list of packages in it.
- TypeScript stays on 6.x (decision 0004), and the `ignore` rule in `dependabot.yml` keeps Dependabot from proposing 7. It names when to remove the rule.
- `@types/node` stays on the major of the Node.js version the code runs on (`.nvmrc`, `engines` and the Lambda runtime), because a newer major lets code use APIs that the runtime does not have while the type check passes. A rule in `dependabot.yml` ignores its major updates, and the change that moves the project to a newer Node.js removes the rule.
- A new release of `aws-cdk-lib` can add a Lambda runtime, and cdk-nag then fails a function for not using the newest one. The fix is to move to that runtime when Lambda offers it for production. Until then, `ServiceFunction` acknowledges the rule with the reason written next to it, and the move removes the acknowledgement.
- Fix an alert by updating the package. When no update exists, or the package is a dev tool that reads only our own files, dismiss the alert with a written reason, so the list of open alerts stays short and every entry in it needs a decision.

## Repository settings

These GitHub settings are on. They are not in the repository, so this list is what to check when the repository is set up again.

| Setting                     | Where                       | On since   |
| --------------------------- | --------------------------- | ---------- |
| Dependency graph            | Settings, Advanced Security | 2026-11-19 |
| Dependabot alerts           | Settings, Advanced Security | 2026-11-19 |
| Dependabot security updates | Settings, Advanced Security | 2026-11-19 |

Secret scanning and push protection were also on when the list was written (checked on 2026-11-19).

## Decision records

- A decision record explains a choice that is costly to reverse or that a later reader would otherwise have to guess. It lives in `docs/decisions/NNNN-short-title.md`.
- `NNNN` is a four-digit number, the next free one. Numbers are never reused or renumbered. Copy [decisions/0000-template.md](decisions/0000-template.md) to start one.
- A record has Context, Options, Decision and Consequences, and fits on about one page.
- The `Status:` line is `proposed`, `accepted on <date>` or `superseded by <number>`. It may end with a short note, for example `accepted on 2026-11-02. To be revisited after Phase 5.`
- A small change to an accepted record is made in the record itself. Edit the text that changed, and add `Amended on <date>: <what changed>` to the `Status:` line. A change is small when the decision stays the same: a correction, a clarification, a detail that moved, or a consequence that was added or reworded.
- A major rework needs a new record that supersedes the old one, and only the old record's `Status:` line is updated. A change is major when it reverses the decision, picks a different option, or removes what the Consequences rest on. Do not write a new record for a small change.
