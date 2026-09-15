---
name: dsh-headless
description: Run one DeepSeek Harness (dsh) task headlessly with the final reply as the only stdout output, thinking and progress suppressed, and the model pinned to DeepSeek-V41-Flash. Use for scripted, CI, batch, or one-shot dsh runs, or when the user wants only the answer on stdout.
---

# dsh-headless skill

Runs `dsh --profile headless` for exactly one task and hands back only the
final assistant message on stdout. Thinking tokens, tool progress, and errors
never reach stdout.

Use the bundled `scripts/dsh-headless.sh` rather than calling `dsh` directly
whenever a script, CI step, or another agent has to consume the answer.

## When to load this skill

Load when the user asks to:

- run dsh / DeepSeek Harness headlessly, one-shot, non-interactively, or in a
  pipeline, and cares about a clean stdout;
- suppress "thinking", reasoning, progress, or streaming tokens from dsh output;
- pin a dsh run to DeepSeek-V41-Flash, or to a specific thinking effort;
- capture just the final answer from a dsh invocation.

## Quick start

```sh
# final reply on stdout, nothing else
.agents/skills/dsh-headless/scripts/dsh-headless.sh "summarize the failing test"

# change the thinking effort for one run
.agents/skills/dsh-headless/scripts/dsh-headless.sh --effort max "design a migration plan"

# capture in a script
if reply=$(scripts/dsh-headless.sh "run the test suite and report the failure"); then
  printf '%s\n' "$reply"
else
  exit 1
fi
```

Install it on `PATH` once per machine if it will be used repeatedly:

```sh
mkdir -p ~/.dsh/bin
ln -s "$(pwd)/.agents/skills/dsh-headless/scripts/dsh-headless.sh" ~/.dsh/bin/dsh-headless
# then add ~/.dsh/bin to PATH, e.g. in ~/.zshrc
export PATH="$HOME/.dsh/bin:$PATH"
```

## Options

| Flag | Default | Meaning |
|---|---|---|
| `-m, --model <id>` | `deepseek-flash` | Model id. `deepseek-flash` is the provider id whose display name is **DeepSeek-V41-Flash**. |
| `-e, --effort <level>` | `high` | Thinking effort: `off`, `low`, `high`, `max`. |
| `-h, --help` | — | Wrapper usage. |
| `--` | — | End of wrapper options; everything after it is task text. |

Environment equivalents: `DSH_HEADLESS_MODEL`, `DSH_HEADLESS_EFFORT`,
`DSH_BIN` (default `npx -y @deepseek-ai/dsh`), and
`DSH_HEADLESS_SHOW_STDERR=1` to stream stderr live for debugging.

Precedence: flag → environment variable → built-in default.

## Output contract

| Stream | Content |
|---|---|
| stdout | The final assistant message, and nothing else. |
| stderr | Provider reasoning under `dsh: reasoning:`, plus `dsh: <code>: <message>` on failure. Suppressed on success; replayed in full when the run fails. |
| Exit code | `0` task completed, `1` aborted/errored, `2` wrapper usage error. |

Intermediate tool output is not printed at all. There is **no `--quiet` flag on
dsh**: the separation is by stream, which is why the wrapper captures rather
than filters.

A run that produces no assistant message exits `1`. Treat the exit code as
authoritative; never infer success from stdout being non-empty.

## Why the wrapper sets `--patch`

dsh has no model or effort flag on the headless app — the app resolves the
model once from the `agent-default-model` service, and `reasoningEffort` is
deliberately not a composition config field. Two facts drive the design:

1. The user settings section **merges over and beats** the composition entry,
   so an ambient `~/.dsh/settings.yaml` would otherwise decide the model, and
   no `--patch` alone could pin it.
2. A row patch replaces the whole `config` of the row it targets.

So each run generates two throwaway documents in a temp directory and points
the `settings` row at them via `--patch`:

```yaml
# settings.yaml
agent-default-model:
  provider: deepseek-official
  model: 'deepseek-flash'
  reasoningEffort: 'high'
```

```yaml
# patch.yml
- id: settings
  config:
    path: '/tmp/dsh-headless.XXXXXX/settings.yaml'
    watch: false
```

The generated settings document is therefore the live source and wins
regardless of what `~/.dsh/settings.yaml` says. Sessions, credentials, and
profiles still come from the real `$DSH_HOME`, so the run shares history and
`DEEPSEEK_API_KEY` with every other surface.

## Gotchas

- **A task whose first word starts with `-` cannot be passed.** The launcher
  consumes the `--` separator and the app re-parses the operands, so a leading
  dash reaches the app's option parser. Start the task with a normal word.
- **`npx` is the default launcher.** Set `DSH_BIN=dsh` when dsh is installed
  globally to skip the npx resolution step.
- **`--effort off` disables thinking for the request.** It is not the same as
  suppressing output; the wrapper already suppresses output.
- **The reply is captured, not streamed.** Command substitution strips trailing
  newlines and the wrapper re-adds exactly one.
- **Large answers cost memory.** The whole final message is held in a shell
  variable.

## Verifying a change

```sh
bash -n scripts/dsh-headless.sh                     # syntax
scripts/dsh-headless.sh --help                      # usage
scripts/dsh-headless.sh --effort bogus "x"          # exits 2, no run
```

To exercise a run without touching the real home, point `DSH_HOME` at a
throwaway directory and unset the API key — the run then fails at the request
boundary with `MISSING_CREDENTIAL`, which proves the profile booted and the
generated settings document loaded.
