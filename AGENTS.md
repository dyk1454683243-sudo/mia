# Working on mia

Conventions for any coding agent (Claude Code, Codex, Cursor, Aider, …).
The product and the summary architecture live in [README.md](README.md); the
lower-level architecture and the reasons behind it live in
[docs/](docs/README.md); this file is about how to operate on the repo safely.

## Commands

| Task | Command |
| --- | --- |
| Typecheck | `npm run typecheck` |
| Unit + worker tests | `npm test` (`test:unit` / `test:workers` to narrow) |
| Local dev | `npm run dev` |
| End-to-end against a deploy | `MIA_BASE=https://<worker>.<account>.workers.dev npm run e2e` |
| Deploy (disposable account) | `npm run deploy:temporary` |

Run `npm run typecheck && npm test` before opening a pull request.

## Documentation

Read [docs/](docs/README.md) — not just the code — whenever you are about to
change behavior rather than merely read it, and especially before touching
routing, the Durable Object alarm, redaction, identity, or persistence. The pages
carry the decisions and rejected alternatives that the code cannot, plus the
invariants other layers rely on.

| Page | Read it when |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | You need the request and WebSocket topology, where each kind of state lives, or why routing avoids SPA fallback. |
| [docs/game-engine.md](docs/game-engine.md) | You are touching `src/shared/mia.ts`: the ranking, phases, legal moves, doubt resolution or redaction. |
| [docs/table-room.md](docs/table-room.md) | You are touching `src/worker/table-room.ts`: hibernation, alarms, persistence order, reaping or the result write. |
| [docs/client.md](docs/client.md) | You are touching the browser: the reconnect lifecycle, the stale-move stamp or the countdown clock. |
| [docs/identity-and-storage.md](docs/identity-and-storage.md) | You are touching the cookie, the D1 schema, or what does and does not reach D1. |
| [docs/testing.md](docs/testing.md) | You are adding or debugging tests; it explains the test-only Durable Object subclass and per-file storage isolation. |
| [docs/known-gaps.md](docs/known-gaps.md) | You are deciding whether something is a bug or a stated limit, or looking for the open issue. |

Keep `docs/` current as part of a change that alters a decision. Update the page
that owns the decision rather than adding a new page; a stale page is worse than
none.

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

### Show the test failing

A PR whose point is a test or a bugfix carries, in its body, the **observed
failure** — the real assertion output — from reverting the fix and watching the
new test go red. Not a sentence claiming it was checked; the output.

Revert **one thing at a time**. A mutation that breaks five things at once only
proves the first assertion fires and says nothing about the other four.

This rule exists because it kept going wrong. Three PRs in a row shipped a check
that passed with the bug fully present:

- a forged-header test whose sabotage flipped all five headers together, so only
  the first assertion was ever exercised;
- `COUNT(*)` assertions against a sentinel in a file that never finishes a game,
  so the counts were zero either way;
- a viewport assertion that was correct but only ran at a three-seat table, when
  the property fails from six seats up.

Every one of those ran with a green suite, and every one was reported honestly.
An assertion that cannot fail is not coverage, and the only way to tell the
difference is to watch it fail once. The craft side of this is in
[docs/testing.md](docs/testing.md).

### Say what the screenshot shows

A PR that changes what the screen looks like carries, in its body, **what the
rendered screenshot shows at the moment that matters** — not that one was
captured, and not that the harness was green.

Pick the moment the change is about. For anything staged over time, that is
mid-flight, not the settled end state: a showdown is worth describing at its
first beat, a scroll pin at the position it starts from, a layout while the
tall thing is on screen rather than after the game has finished.

This rule has the same cause as the one above. The #29 showdown passed every
assertion while striking the claimed value through in red from its first frame,
giving away the verdict 2750ms before the stamp landed. Nothing was wrong with
the tests: they pinned *that* claimed, actual and stamp appear, and the whole
feature was about *when*. The bug was plain in the PR's own screenshot the
moment anyone looked at it.

Tests are bad at timing and appearance, and a screenshot is bad at nothing else.
Reading it is the only step that catches this class.

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
  npm test` on the branch, not just the delegate's word that it passed. Green is
  necessary and not sufficient: the suite passes just as cheerfully when the new
  test asserts nothing. Re-run the failure the PR body records (see [Show the
  test failing](#show-the-test-failing)) instead of relaying it, reverting one
  thing at a time so you find out which assertion is load-bearing.
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
