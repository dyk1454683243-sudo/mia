# dsh-headless (skill)

One-shot DeepSeek Harness (`dsh`) runs with a clean stdout: the final assistant
message is the only thing written there, thinking and progress are suppressed,
and the model is pinned to DeepSeek-V41-Flash by default.

`SKILL.md` is the canonical machine-readable behavior. Load this skill when a
task needs `dsh --profile headless` output consumed by a script, a CI step, or
another agent rather than read by a human.

## Layout

| File | Purpose |
| --- | --- |
| `SKILL.md` | When to load the skill, the output contract, options, and design rationale |
| `scripts/dsh-headless.sh` | The wrapper: parses model/effort/task, generates the settings pin, runs dsh, emits only the final reply on stdout |

## Usage

```sh
scripts/dsh-headless.sh [--model ID] [--effort off|low|high|max] [--] <task...>
```

Exit code `0` means the task completed, `1` means it aborted or errored, and `2`
is a usage error in the wrapper.
