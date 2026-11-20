# QA review patterns

Known recurring gaps in this repo. The QA review reads the **Implementation Gaps** section as a checklist before it concludes.

## Implementation Gaps

- A PR that builds something (a stack, a script, a construct) but does not deploy it leaves the roadmap boxes unticked with no done/remaining sub-bullets. `CLAUDE.md` asks for sub-bullets on partly done work, so check the roadmap boxes in `docs/ROADMAP.md` and `docs/roadmap-phases/` of such PRs.
- The reverse also happens: a box is ticked although its own text (or the PR description) says the thing cannot deploy yet, for example "an API with access logs does not deploy before the account role exists". Scan ticked boxes of such PRs for caveats like "does not deploy until" or "not verified", and ask for the box to be unticked with Done and Remaining sub-bullets.
