# Working on mia

Conventions for any coding agent (Claude Code, Codex, Cursor, Aider, …).
Product and architecture live in [README.md](README.md) and [PLAN.md](PLAN.md);
this file is about how to operate on the repo safely.

## Commands

| Task | Command |
| --- | --- |
| Typecheck | `npm run typecheck` |
| Unit + worker tests | `npm test` (`test:unit` / `test:workers` to narrow) |
| Local dev | `npm run dev` |
| End-to-end against a deploy | `MIA_BASE=https://<worker>.<account>.workers.dev npm run e2e` |
| Deploy (disposable account) | `npm run deploy:temporary` |

Run `npm run typecheck && npm test` before opening a pull request.

## GitHub access

Agents reach GitHub through a **fine-grained personal access token scoped to
`hensleyl/mia` and nothing else**, supplied as the `GH_TOKEN` environment
variable. Use the `gh` CLI, which picks it up automatically.

The token grants **Contents**, **Issues**, **Pull requests**, and **Metadata**
(read/write). It deliberately does **not** grant Administration, Workflows, or
Secrets.

Rules:

- **Never run `gh auth login`.** An account-wide login would store a credential
  covering all ~30 repos on this account, defeating the whole arrangement.
- **Never print, echo, log, or commit the token**, and never copy it into a
  tracked file. `.claude/settings.local.json`, which holds it, is gitignored —
  keep it that way.
- **Never reach for a different credential** to get around a refusal.

### When you get `Resource not accessible by personal access token`

That HTTP 403 is the boundary working, not a misconfiguration. It means you
tried something outside this repo or outside the granted permissions — editing
`.github/workflows`, creating a ruleset, reading secrets, or touching another
repository.

**Stop and tell the human what you were trying to do.** Do not widen the token,
do not look for another way in. Repo administration is intentionally a manual,
human-only step.

## Branches and pull requests

`main` is protected by the `protect-main` ruleset, with **no bypass actors** —
the rule binds the repo owner too, because the agent token acts as the owner.

**An agent must not merge a PR it wrote.** Opening or updating a PR is the end of
an agent's work on it: push, open the PR, report, stop. Merging is the step that
makes a change permanent, and the agent that wrote a change is the last one who
should decide it belongs in `main`.

- **Never merge your own PR** — not with `gh pr merge`, not with `gh api`, not by
  any other route. Do not ask for the ability, and do not treat the absence of
  required checks as permission. No amount of green checks, review comments or
  `MERGEABLE`/`CLEAN` status is a substitute for a judgement you are not allowed
  to make.
- If you believe your own PR is ready, **say so and stop.** Leave it open. A PR
  sitting open is the correct resting state, not a task left unfinished.
- **Never push directly to `main`.** Work on a branch and open a PR.
- **Never force-push** (`--force`, `-f`) or delete a branch on the remote.
- The ruleset requires no approving reviews, so nothing technical stops a merge.
  That is a property of the config, **not** a grant of authority.
- If a PR refuses to merge, the likely cause is GitHub's
  `require_extra_approval_for_unattributed_changes` rule: commits whose
  authorship doesn't map to a GitHub account need an extra approval. Report it
  rather than rewriting history to work around it.

### When you may merge

Two cases, and no others.

**A human delegates a specific PR to you** — "go ahead and merge #12". That
delegation is per PR and does not carry over: approval of one PR, a general "keep
going", or an earlier merge is never standing authority for the next one.

**You are supervising another agent, and a human asked you to merge what you
approve.** A supervisor reviewing a delegate's work is a second, independent
reading before the change becomes permanent, which is the thing the rule above
is protecting. Having spawned the delegate yourself does not disqualify you —
what disqualifies you is having written the code. Every one of these must hold:

- **You wrote none of it.** Not the implementation, not the tests, not a fixup
  commit, not a one-line typo fix on the branch. Touching the branch makes you an
  author and puts the PR back under "never merge your own".
- **A human framed this run as supervision with merge authority** — "review the
  PRs, merge them if you approve". Being a supervisor is not itself authority;
  the human granting the merge step is. It covers the PRs of that run and expires
  with it.
- **You reviewed the change itself**, not the delegate's account of it. Read the
  full diff. A delegate reporting "typecheck clean, all tests pass" is a claim to
  check, not a result to relay.
- **Checks are green and you confirmed it independently** — `npm run typecheck &&
  npm test` on the branch, not just the delegate's word that it passed.
- **Your verdict is recorded on the PR** before you merge it, so the reasoning
  survives in a place a human can read later.
- **Anything you would not merge goes back to the delegate.** Write the concerns
  on the PR and hand it back for revision. Do not fix it yourself and then merge
  it — that is authoring the change and approving it in one move, which is
  exactly what none of this permits.

Merging still stops at the first real doubt. "The delegate says it works and
nothing is obviously wrong" is not approval; if you would not defend the change
to the human afterwards, leave it open and say why.

The harness has its own say. A permission classifier may refuse `gh pr merge` as
self-approval no matter what this file allows, because it cannot see which agent
wrote what. That refusal is not a problem to route around — report it and let the
human press the button.

## Issues

GitHub Issues are the todo tracker. `gh issue list`, `gh issue create`,
`gh issue comment`, and `gh issue close` are all available.

Close issues from the PR that fixes them (`Closes #12` in the PR body) rather
than closing them by hand.

## Secrets

This repo is **public** and has no secrets in its history. Keep it that way.

- The app provisions no secrets by design: the session-signing key lives in a
  D1 `app_config` row, and `wrangler.jsonc` carries no account or database ID.
- `.dev.vars` is gitignored and must never be committed.
- **Cloudflare claim URLs are bearer credentials** — whoever holds one owns the
  account. Never write one into a tracked file, an issue, or a commit message.
  GitHub's push protection will *not* catch these; it matches known provider
  token patterns, and a claim URL looks like an ordinary URL.
- Deploys are disposable. Never claim the temporary account; if one expires,
  redeploy and carry on.
