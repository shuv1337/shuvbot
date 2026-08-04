# Design: reviewing fork pull requests

**Status: proposed, not implemented.** Fork pull requests are reviewed but never
posted to. This document exists to get the rule right before changing it.

## The goal

Review pull requests submitted by outside contributors, and post the review, so
`@shuvbot review` works on someone else's contribution rather than only on
same-repository branches.

## Why it is blocked today

`buildRuntimePolicy` computes:

```ts
canReview: canComment && !input.isFork;
```

That single term conflates two questions that deserve different answers:

1. **May shuvbot execute in a fork context?** Fork content is attacker
   controlled. This must stay restricted.
2. **May shuvbot publish its review on a fork pull request?** This is the base
   repository's own token writing a review to its own pull request, containing
   shuvbot's own findings.

The second is not the same risk as the first, and only the first justifies the
restriction.

## Threat model

What actually goes wrong with fork pull requests, in order of severity:

| Threat                                                                                                                                                      | Status                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Executing fork code in a credentialed job** (the "pwn request"): a fork controls a build, test, or shell command running beside `CLAUDE_CODE_OAUTH_TOKEN` | Already prevented. The workflow checks out `refs/pull/N/merge` only for same-repo heads; fork pull requests keep the default checkout. Fork policy also forces `shell=disabled`, `push=disabled`, `canReadSecrets=false`. |
| **Prompt injection through fork content**: the diff, title, body, and comments are attacker-authored text the agent reads                                   | Partly mitigated, and the residual risk is the reason this needs a decision. See below.                                                                                                                                   |
| **Fork triggering its own review** to burn quota or fish for injection results                                                                              | Already prevented. The workflow requires `author_association` in OWNER/MEMBER/COLLABORATOR, so a maintainer must ask.                                                                                                     |
| **Fork pull request auto-reviewed on open with secrets present**                                                                                            | Not possible, and must stay that way. A fork `pull_request` event has no secrets, so fork review is inherently comment-triggered. Do **not** reach for `pull_request_target` to change this.                              |

### The residual risk, stated plainly

Allowing posting means attacker-influenced text can reach a review that shuvbot
publishes under the repository's bot identity. Injection cannot make shuvbot
push, run a shell, or read secrets - those are separately disabled for forks -
but it could make the review body misleading or abusive.

That is a nuisance and a trust problem, not a compromise. It is bounded by three
things that already hold:

- Findings pass through a structured schema (`review-schema.ts`) with severity
  and confidence filtering, not free-form text passthrough.
- Inline comments anchor to diff positions, so they cannot be placed on
  arbitrary files.
- AI approval is never permitted (`hard:no-ai-approval`), so a review can never
  become an approval.

## Proposed rule

Separate publishing from executing:

```ts
// Publishing a review is the base repository writing to its own pull request.
canReview: canComment;
```

and leave every execution restriction exactly as it is. Fork pull requests keep
`shell=disabled`, `push=disabled`, `canReadSecrets=false`, and are never checked
out into a credentialed job.

The agent continues to read a **trusted workspace** (the base branch) and an
**untrusted diff** (fetched from the API, never checked out). That combination
is what makes posting acceptable.

## Invariants that must not change

Anything in this list is load-bearing. Changing one without replacing it
reopens a real hole.

1. Fork code is never checked out into a job holding the Claude credential.
2. `shell` stays `disabled` for forks.
3. `push` stays `disabled` for forks.
4. Secrets are never exposed to tools on a fork run.
5. AI approval is never permitted, on any run.
6. Policy is decided deterministically. Event payloads and model output never
   grant permission.
7. Fork review stays comment-triggered by a maintainer. Do not add
   `pull_request_target`.
8. `detectFork` and `parsePullRequest` keep failing closed when fork status is
   unknown.

## Implementation sketch

1. `packages/core/src/policy.ts`: drop the `!isFork` term from `canReview`, and
   record a reason (`fork:review=published`) so a fork review is visible in the
   run record rather than silent.
2. `packages/core/test/policy-matrix.test.ts`: assert the split directly - a
   fork run has `canReview: true` **and** `shell: "disabled"`, `push:
"disabled"`, `canReadSecrets: false`. The point of the test is that
   publishing moved and executing did not.
3. `packages/action/src/main.ts`: the "not posted" branch stays, but its reason
   narrows to permission rather than fork status.
4. Bound the posted review body, and keep untrusted text out of anything
   rendered as HTML in the workflow summary.
5. Re-verify end to end on a real fork pull request, not a synthetic one.

## Open questions

- Should a fork review be labelled as such in the posted body, so a reader knows
  the diff was attacker-authored? Probably yes, cheap and honest.
- Should fork reviews be rate limited per contributor, separately from the
  maintainer-trigger guard?
