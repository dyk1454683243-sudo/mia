#!/usr/bin/env bash
# dsh-headless — run one dsh task headlessly with the final reply as the only
# stdout output and thinking/progress suppressed.
#
# Pins the model (default deepseek-flash = DeepSeek-V41-Flash) and the thinking
# effort (default high) for the run through a generated settings document, so an
# ambient $DSH_HOME/settings.yaml cannot silently change either. The final
# assistant message is the only thing written to stdout; reasoning and
# diagnostics stay on stderr, and are replayed only when the run fails.
#
# Usage: dsh-headless.sh [--model ID] [--effort LEVEL] [--] <task...>

set -euo pipefail

readonly DEFAULT_MODEL="deepseek-flash"
readonly DEFAULT_EFFORT="high"
readonly DSH_BIN="${DSH_BIN:-npx -y @deepseek-ai/dsh}"

usage() {
  cat <<'EOF'
Usage: dsh-headless.sh [options] [--] <task...>

Answer one dsh task headlessly. The final assistant message is written to
stdout; thinking, tool progress, and errors stay on stderr.

Options:
  -m, --model <id>      model id (default: deepseek-flash = DeepSeek-V41-Flash)
  -e, --effort <level>  thinking effort: off, low, high, max (default: high)
  -h, --help            show this help

Environment:
  DSH_BIN               launcher command (default: npx -y @deepseek-ai/dsh)
  DSH_HEADLESS_MODEL    default model id
  DSH_HEADLESS_EFFORT   default thinking effort
  DSH_HEADLESS_SHOW_STDERR
                        when non-empty, stream stderr live instead of
                        suppressing it on success (for debugging)

Exit status: 0 when the task completed, 1 when it aborted or errored,
2 for a usage error in this wrapper.
EOF
}

die() {
  printf 'dsh-headless: %s\n' "$*" >&2
  exit 2
}

# Render one YAML single-quoted scalar, so a model id or path containing
# punctuation cannot break the generated documents.
yaml_squote() {
  local s=$1 q="'"
  printf "'%s'" "${s//$q/$q$q}"
}

model=""
effort=""
parsing_opts=1
declare -a task_args=()

while [[ $# -gt 0 ]]; do
  if [[ $parsing_opts -eq 1 ]]; then
    case "$1" in
      -h|--help)
        usage
        exit 0
        ;;
      --)
        parsing_opts=0
        shift
        continue
        ;;
      -m|--model)
        [[ $# -ge 2 ]] || die "$1 needs a model id"
        model="$2"
        shift 2
        continue
        ;;
      --model=*)
        model="${1#--model=}"
        shift
        continue
        ;;
      -e|--effort)
        [[ $# -ge 2 ]] || die "$1 needs an effort level"
        effort="$2"
        shift 2
        continue
        ;;
      --effort=*)
        effort="${1#--effort=}"
        shift
        continue
        ;;
    esac
  fi
  task_args+=("$1")
  shift
done

model="${model:-${DSH_HEADLESS_MODEL:-$DEFAULT_MODEL}}"
effort="${effort:-${DSH_HEADLESS_EFFORT:-$DEFAULT_EFFORT}}"

case "$effort" in
  off|low|high|max) ;;
  *) die "invalid effort '$effort' (expected: off, low, high, max)" ;;
esac

if [[ ${#task_args[@]} -eq 0 ]]; then
  die "a task is required (try --help)"
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/dsh-headless.XXXXXX")"
trap 'rm -rf "$work"' EXIT

settings="$work/settings.yaml"
patch="$work/patch.yml"
stderr_log="$work/stderr.log"

# The generated settings document is the live source for the default model
# selection: a user section merges over — and therefore wins against — the
# composition entry, so this is what actually pins the run.
{
  printf 'agent-default-model:\n'
  printf '  provider: deepseek-official\n'
  printf '  model: %s\n' "$(yaml_squote "$model")"
  printf '  reasoningEffort: %s\n' "$(yaml_squote "$effort")"
} >"$settings"

# A row patch replaces the whole `config`, so state both fields we care about.
# Skipping the watcher is free accuracy for a one-shot run.
{
  printf -- '- id: settings\n'
  printf '  config:\n'
  printf '    path: %s\n' "$(yaml_squote "$settings")"
  printf '    watch: false\n'
} >"$patch"

read -r -a dsh_cmd <<<"$DSH_BIN"

if [[ -n "${DSH_HEADLESS_SHOW_STDERR:-}" ]]; then
  "${dsh_cmd[@]}" --profile headless --patch "$patch" -- "${task_args[@]}"
  exit 0
fi

# Capture stdout and stderr separately: stdout is the final reply, stderr is
# reasoning plus diagnostics. Nothing reaches the terminal until the run
# succeeds, so a failed run cannot leak a partial answer to stdout.
if reply="$("${dsh_cmd[@]}" --profile headless --patch "$patch" -- "${task_args[@]}" 2>"$stderr_log")"; then
  printf '%s\n' "$reply"
else
  status=$?
  cat "$stderr_log" >&2
  exit "$status"
fi
