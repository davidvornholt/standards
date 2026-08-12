#!/usr/bin/env bash

set -euo pipefail

if (( $# != 1 )); then
  echo "usage: actionlint-queue-compat.bash <actionlint>" >&2
  exit 2
fi

actionlint=$1
queue_message='unexpected key "queue" for "concurrency" section. expected one of "cancel-in-progress", "group"'
queue_ignore='^unexpected key "queue" for "concurrency" section\. expected one of "cancel-in-progress", "group"$'
workspace=$(realpath -e -- "${GITHUB_WORKSPACE:-$PWD}")
diagnostics=$(mktemp)
temp_files=("$diagnostics")
trap 'rm -f -- "${temp_files[@]}"' EXIT

set +e
"$actionlint" -format '{{json .}}' >"$diagnostics"
lint_status=$?
set -e

case "$lint_status" in
  0)
    exit 0
    ;;
  1)
    ;;
  *)
    exit "$lint_status"
    ;;
esac

if ! jq -e '
  type == "array" and
  length > 0 and
  all(.[];
    type == "object" and
    (.message | type == "string") and
    (.filepath | type == "string") and
    (.line | type == "number") and
    (.column | type == "number") and
    (.kind | type == "string")
  )
' "$diagnostics" >/dev/null; then
  echo "::error::Actionlint returned invalid structured diagnostics" >&2
  exit 1
fi

validate_queue_diagnostic() {
  local diagnostic=$1
  local filepath line column kind resolved source_line queue_indent
  local ancestor_index=-1 ancestor_indent=-1 candidate candidate_indent
  local index probe probe_diagnostics probe_status current_count duplicate_count
  local duplicate_message previous_line previous_source explicit_indent
  local -a lines

  filepath=$(jq -er '.filepath' <<<"$diagnostic")
  line=$(jq -er '.line | select(floor == . and . >= 1)' <<<"$diagnostic")
  column=$(jq -er '.column | select(floor == . and . >= 1)' <<<"$diagnostic")
  kind=$(jq -er '.kind' <<<"$diagnostic")

  if [[ "$kind" != syntax-check || "$filepath" == /* || "$filepath" == .. || "$filepath" == ../* || "$filepath" == */../* || "$filepath" == */.. ]]; then
    echo "::error file=$filepath,line=$line,col=$column::Refusing to suppress an untrusted Actionlint queue diagnostic" >&2
    return 1
  fi
  if ! resolved=$(realpath -e -- "$filepath") || [[ ! -f "$resolved" || "$resolved" != "$workspace"/* ]]; then
    echo "::error file=$filepath,line=$line,col=$column::The Actionlint queue diagnostic does not name a contained workflow file" >&2
    return 1
  fi

  mapfile -t lines <"$resolved"
  if (( line > ${#lines[@]} )); then
    echo "::error file=$filepath,line=$line,col=$column::The Actionlint queue diagnostic points beyond the workflow" >&2
    return 1
  fi

  source_line=${lines[line - 1]%$'\r'}
  if [[ ! "$source_line" =~ ^(\ *)queue:\ max$ ]]; then
    echo "::error file=$filepath,line=$line,col=$column::Only an exact queue: max entry can bypass Actionlint 1.7.12" >&2
    return 1
  fi
  queue_indent=${#BASH_REMATCH[1]}
  if (( column != queue_indent + 1 )); then
    echo "::error file=$filepath,line=$line,col=$column::The Actionlint queue diagnostic does not point at the queue key" >&2
    return 1
  fi

  for (( index = line - 2; index >= 0; index-- )); do
    candidate=${lines[index]%$'\r'}
    [[ "$candidate" =~ ^\ *($|#) ]] && continue
    [[ "$candidate" =~ ^(\ *) ]] || continue
    candidate_indent=${#BASH_REMATCH[1]}
    if (( candidate_indent < queue_indent )); then
      ancestor_index=$index
      ancestor_indent=$candidate_indent
      break
    fi
  done

  if (( ancestor_index < 0 )) || [[ "${lines[ancestor_index]%$'\r'}" != "${lines[ancestor_index]%%[! ]*}concurrency:" ]]; then
    echo "::error file=$filepath,line=$line,col=$column::queue: max must be a direct entry in a concurrency mapping" >&2
    return 1
  fi

  probe=$(mktemp "${RUNNER_TEMP:-/tmp}/actionlint-queue-compat.XXXXXX.yml")
  probe_diagnostics=$(mktemp)
  temp_files+=("$probe" "$probe_diagnostics")
  lines[line - 1]="${source_line%%queue: max}cancel-in-progress: false"
  printf '%s\n' "${lines[@]}" >"$probe"
  set +e
  "$actionlint" -format '{{json .}}' "$probe" >"$probe_diagnostics"
  probe_status=$?
  set -e

  if (( probe_status > 1 )) || ! jq -e '
    type == "array" and
    all(.[];
      type == "object" and
      (.message | type == "string") and
      (.line | type == "number") and
      (.column | type == "number") and
      (.kind | type == "string")
    )
  ' "$probe_diagnostics" >/dev/null; then
    echo "::error file=$filepath,line=$line,col=$column::Actionlint could not validate concurrency cancellation semantics" >&2
    return 1
  fi

  current_count=$(jq -er --argjson line "$line" --argjson column "$column" '[.[] | select(.line == $line and .column == $column)] | length' "$probe_diagnostics")
  duplicate_matches=$(jq -cer --argjson line "$line" --argjson column "$column" '[.[] | select(.kind == "syntax-check") |
    . as $diagnostic |
    (.message | capture("^key \"cancel-in-progress\" is duplicated in \"concurrency\" section\\. previously defined at line:(?<line>[0-9]+),col:(?<column>[0-9]+)$")) as $previous |
    select(
      ($diagnostic.line == $line and $diagnostic.column == $column) or
      (($previous.line | tonumber) == $line and ($previous.column | tonumber) == $column)
    ) |
    {
      atInjectedKey: ($diagnostic.line == $line and $diagnostic.column == $column),
      originalLine: (if $diagnostic.line == $line and $diagnostic.column == $column then ($previous.line | tonumber) else $diagnostic.line end)
    }
  ]' "$probe_diagnostics")
  duplicate_count=$(jq -er 'length' <<<"$duplicate_matches")
  expected_current_count=$(jq -er 'if length == 1 and .[0].atInjectedKey then 1 else 0 end' <<<"$duplicate_matches")

  if (( duplicate_count == 0 && current_count == 0 )); then
    return 0
  fi
  if (( duplicate_count != 1 || current_count != expected_current_count )); then
    echo "::error file=$filepath,line=$line,col=$column::Actionlint returned an unexpected diagnostic for the concurrency cancellation probe" >&2
    return 1
  fi

  previous_line=$(jq -er '.[0].originalLine' <<<"$duplicate_matches")
  if (( previous_line < 1 || previous_line > ${#lines[@]} )); then
    echo "::error file=$filepath,line=$line,col=$column::Actionlint located concurrency cancellation outside the workflow" >&2
    return 1
  fi

  previous_source=${lines[previous_line - 1]%$'\r'}
  if [[ "$previous_source" =~ :[[:space:]]+false([[:space:]]*(#.*)?)?$ ]]; then
    return 0
  fi
  if [[ "$previous_source" =~ ^(\ *)\? ]]; then
    explicit_indent=${BASH_REMATCH[1]}
    for (( index = previous_line; index < ${#lines[@]}; index++ )); do
      candidate=${lines[index]%$'\r'}
      [[ "$candidate" =~ ^\ *($|#) ]] && continue
      if [[ "$candidate" =~ ^${explicit_indent}:[[:space:]]+false([[:space:]]*(#.*)?)?$ ]]; then
        return 0
      fi
      break
    done
  fi

  echo "::error file=$filepath,line=$line,col=$column::queue: max requires cancel-in-progress to be absent or literal false" >&2
  return 1
}

queue_count=0
queue_invalid=0
while IFS= read -r encoded; do
  diagnostic=$(printf '%s' "$encoded" | base64 --decode)
  (( queue_count += 1 ))
  if ! validate_queue_diagnostic "$diagnostic"; then
    queue_invalid=1
  fi
done < <(jq -r --arg message "$queue_message" '.[] | select(.message == $message) | @base64' "$diagnostics")

diagnostic_count=$(jq -er 'length' "$diagnostics")
if (( queue_count > 0 && queue_invalid == 0 && queue_count == diagnostic_count )); then
  exit 0
fi

set +e
if (( queue_count > 0 && queue_invalid == 0 )); then
  "$actionlint" -color -ignore "$queue_ignore"
else
  "$actionlint" -color
fi
native_status=$?
set -e

if (( native_status == 0 )); then
  echo "::error::Actionlint diagnostics changed between compatibility checks" >&2
  exit 1
fi
exit "$native_status"
