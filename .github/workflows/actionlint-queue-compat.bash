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
trap 'rm -f -- "$diagnostics"' EXIT

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
  local index sibling sibling_indent sibling_key
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

  for (( index = ancestor_index + 1; index < ${#lines[@]}; index++ )); do
    sibling=${lines[index]%$'\r'}
    [[ "$sibling" =~ ^\ *($|#) ]] && continue
    [[ "$sibling" =~ ^(\ *) ]] || continue
    sibling_indent=${#BASH_REMATCH[1]}
    (( sibling_indent <= ancestor_indent )) && break
    sibling_key=${sibling#"${sibling%%[! ]*}"}
    if [[ "$sibling_key" == cancel-in-progress:* || "$sibling_key" == '"cancel-in-progress":'* || "$sibling_key" == "'cancel-in-progress':"* ]]; then
      if (( sibling_indent != queue_indent )) || [[ "$sibling" != "${sibling%%[! ]*}cancel-in-progress: false" ]]; then
        echo "::error file=$filepath,line=$((index + 1))::queue: max cannot be combined with cancel-in-progress unless it is literal false" >&2
        return 1
      fi
    fi
  done
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
