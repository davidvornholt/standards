#!/usr/bin/env bash
# Runs one release, rollback, or status operation for the canonical app-release
# action. action.yml passes every input through an APP_RELEASE_* variable and
# creates the private work directory; its always() step removes that directory
# again. The host side is the app-release SSH forced command: it reads the
# GitHub OIDC token from stdin, streams progress, ends with one
# `APP_RELEASE_RESULT <json>` line, and exits 0 (done), 1 (failed, previous
# version serving), 2 (rejected), 3 (failed, previous version not restored), or
# 4 (lock wait timed out).
# shellcheck disable=SC2016 # Markdown backticks in printf formats and $unit in the jq program are literal on purpose.
set -euo pipefail
# Every file this script creates holds or sits next to a credential.
umask 077

command=${APP_RELEASE_COMMAND-}
images_input=${APP_RELEASE_IMAGES-}
unit=${APP_RELEASE_UNIT-}
host=${APP_RELEASE_HOST-}
known_host=${APP_RELEASE_KNOWN_HOST-}
ssh_key_path=${APP_RELEASE_SSH_KEY_PATH-}
audience=${APP_RELEASE_AUDIENCE-}
tag_production=${APP_RELEASE_TAG_PRODUCTION-}
work=${APP_RELEASE_WORK_DIR-}
age_key=${APP_RELEASE_AGE_KEY-}
registry_token=${APP_RELEASE_REGISTRY_TOKEN-}
# Credentials reach only the one process that needs each of them: the age key
# reaches sops through its environment, and the registry token reaches docker
# login on stdin. No other child process inherits either.
unset APP_RELEASE_AGE_KEY APP_RELEASE_REGISTRY_TOKEN

readonly name_pattern='^[a-z0-9][a-z0-9-]*$'
readonly image_pattern='^([a-z0-9][a-z0-9-]*)@(sha256:[0-9a-f]{64})$'
readonly host_pattern='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
readonly ssh_key_path_pattern='^[a-z0-9_]+(\.[a-z0-9_]+)*$'
readonly audience_pattern='^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
readonly private_key_header_pattern='^-----BEGIN ([A-Z]+ )?PRIVATE KEY-----$'
readonly jwt_pattern='^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
readonly max_token_bytes=16384
readonly secret_file="${GITHUB_WORKSPACE:-.}/secrets/ci.yaml"

# Writes one workflow command. Its data escapes %, CR, and LF, so a value such
# as a host message cannot end the command early and start another one.
workflow_command() {
  local data=${2//'%'/'%25'}
  data=${data//$'\r'/'%0D'}
  printf '::%s::%s\n' "$1" "${data//$'\n'/'%0A'}"
}

annotate() {
  workflow_command "error title=$1" "$2"
}

fail() {
  annotate 'App release' "$1"
  exit 1
}

problems=()
case "$command" in
  release | rollback | status) ;;
  *) problems+=("command must be release, rollback, or status") ;;
esac
if ! [[ $unit =~ $name_pattern ]]; then
  problems+=("unit must match $name_pattern")
fi
host_valid=false
if [ "${#host}" -le 253 ] && [[ $host =~ $host_pattern ]]; then
  host_valid=true
else
  problems+=("host must be a lowercase DNS name such as prod-1.example.com")
fi
if [ "$host_valid" = true ]; then
  # Only the given host key is trusted, for exactly the given host. Markers,
  # host lists, hashed names, and ports are rejected rather than interpreted.
  known_host_pattern="^${host//./\\.} (ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|ssh-rsa) [A-Za-z0-9+/]+={0,2}$"
  if ! [[ $known_host =~ $known_host_pattern ]]; then
    problems+=("known-host must be one known_hosts line for $host: '$host <key-type> <base64-key>'")
  fi
fi
if ! [[ $ssh_key_path =~ $ssh_key_path_pattern ]]; then
  problems+=("ssh-key-path must be a dotted path into secrets/ci.yaml matching $ssh_key_path_pattern")
fi
if ! [[ $audience =~ $audience_pattern ]]; then
  problems+=("audience must match $audience_pattern")
fi
case "$tag_production" in
  true | false) ;;
  *) problems+=("tag-production must be true or false") ;;
esac
if [ -z "$age_key" ]; then
  problems+=("age-key is empty; pass the SOPS_AGE_KEY secret that decrypts secrets/ci.yaml")
fi
if [ "$command" != status ] && [ "$tag_production" = true ] && ! [[ $registry_token =~ ^[^[:space:]]+$ ]]; then
  problems+=("registry-token must be a non-empty token without whitespace while tag-production is true")
fi

images=()
image_lines=0
declare -A requested=()
while IFS= read -r line || [ -n "$line" ]; do
  # Trim surrounding whitespace, including the CR of a CRLF line ending.
  line=${line#"${line%%[![:space:]]*}"}
  line=${line%"${line##*[![:space:]]}"}
  if [ -z "$line" ]; then
    continue
  fi
  image_lines=$((image_lines + 1))
  if [ "$command" != release ]; then
    problems+=("images is only accepted by the release command")
    break
  fi
  if ! [[ $line =~ $image_pattern ]]; then
    problems+=("images line '$line' must be <app>@sha256:<64 lowercase hex>")
  elif [ -n "${requested[${BASH_REMATCH[1]}]+set}" ]; then
    problems+=("images names app ${BASH_REMATCH[1]} more than once")
  else
    requested[${BASH_REMATCH[1]}]=${BASH_REMATCH[2]}
    images+=("$line")
  fi
done <<<"$images_input"
if [ "$command" = release ] && [ "$image_lines" -eq 0 ]; then
  problems+=("images must list at least one <app>@sha256:<digest> for release")
fi

if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL-}" ] || [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN-}" ]; then
  problems+=("GitHub OIDC is unavailable; grant the job permissions: id-token: write")
fi
if [ -z "$work" ] || [ ! -d "$work" ]; then
  problems+=("APP_RELEASE_WORK_DIR must name the action's work directory")
fi
if [ -z "${GITHUB_OUTPUT-}" ] || [ -z "${GITHUB_STEP_SUMMARY-}" ]; then
  problems+=("GITHUB_OUTPUT and GITHUB_STEP_SUMMARY must be set; run this action inside GitHub Actions")
fi
if [ ! -f "$secret_file" ]; then
  problems+=("secrets/ci.yaml does not exist; check out the repository before this action")
fi

if [ "${#problems[@]}" -gt 0 ]; then
  for problem in "${problems[@]}"; do
    annotate 'Invalid app-release input' "$problem"
  done
  exit 1
fi

trap 'rm -rf -- "$work"' EXIT

remote_command=$command
if [ "$command" = release ]; then
  remote_command="release ${images[*]}"
fi
# ci.app_release.ssh_private_key becomes ["ci"]["app_release"]["ssh_private_key"].
extract_path="[\"${ssh_key_path//./\"][\"}\"]"

# The pin and checksums match the canonical sops-secret action; a test in the
# standards repository fails when the two drift apart.
install_sops() {
  version=v3.13.3
  case "$(uname -m)" in
    x86_64) arch=amd64 sha=e5bec3346a873ae91d871550f3e698c1aad962aff462a080e40f25fde17fef6b ;;
    aarch64) arch=arm64 sha=53b0abacd38ef1b12a66d6c100956691b9cefce018d91f81e73ddf7438b94d77 ;;
    *) fail "No pinned SOPS binary for runner architecture $(uname -m)" ;;
  esac
  sops="$work/sops"
  if ! curl -sfLo "$sops" "https://github.com/getsops/sops/releases/download/${version}/sops-${version}.linux.${arch}"; then
    rm -f "$sops"
    fail "Downloading SOPS ${version} for linux/${arch} failed"
  fi
  if ! echo "$sha  $sops" | sha256sum --check --quiet; then
    rm -f "$sops"
    fail "Downloaded SOPS binary does not match the pinned checksum"
  fi
  chmod +x "$sops"
}

key_file="$work/id"
known_hosts_file="$work/known_hosts"
install_sops
if ! SOPS_AGE_KEY="$age_key" "$sops" decrypt --extract "$extract_path" "$secret_file" >"$key_file"; then
  fail "Decrypting $ssh_key_path from secrets/ci.yaml failed"
fi
key=""
IFS= read -r -d '' key <"$key_file" || true
key_header=${key%%$'\n'*}
if ! [[ ${key_header%$'\r'} =~ $private_key_header_pattern ]]; then
  fail "$ssh_key_path in secrets/ci.yaml is not a PEM or OpenSSH private key"
fi
while IFS= read -r key_line; do
  if [ -n "$key_line" ]; then
    workflow_command add-mask "$key_line"
  fi
done <<<"$key"
# OpenSSH refuses a private key file without a final newline.
if [[ $key != *$'\n' ]]; then
  printf '\n' >>"$key_file"
fi
unset key key_line
printf '%s\n' "$known_host" >"$known_hosts_file"

# The bearer header goes through stdin so the request token stays out of argv.
if ! oidc_response=$(curl -fsS -H @- "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${audience}" <<<"Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}"); then
  fail "Requesting the GitHub OIDC token failed"
fi
token=$(jq -r '.value | strings' <<<"$oidc_response" 2>/dev/null) || token=""
unset oidc_response
if [ "${#token}" -gt "$max_token_bytes" ] || ! [[ $token =~ $jwt_pattern ]]; then
  fail "The GitHub OIDC token response did not contain a JWT"
fi
workflow_command add-mask "$token"

log_file="$work/host-output"
echo "Running '$remote_command' for unit $unit on root@$host"
set +e
ssh -F none -T \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o IdentityAgent=none \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$known_hosts_file" \
  -o GlobalKnownHostsFile=/dev/null \
  -o CheckHostIP=no \
  -o UpdateHostKeys=no \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=8 \
  -o ConnectTimeout=15 \
  -i "$key_file" \
  "root@$host" "$remote_command" <<<"$token" | tee "$log_file"
ssh_status=${PIPESTATUS[0]}
set -e
unset token
rm -f -- "$key_file"

# One jq pass takes the last APP_RELEASE_RESULT line, validates it, and prints
# the result, the compact apps object, the app count, one tab-separated line
# per app sorted by name, and finally the message, which may span lines. An
# invalid or missing result line prints nothing.
result_report='
  def digest: type == "string" and test("^sha256:[0-9a-f]{64}$");
  def repository:
    type == "string"
    and test("^[a-z0-9]+([.-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*)+$");
  def valid:
    type == "object"
    and .unit == $unit
    and (.result | IN("released", "unchanged", "superseded", "rolled-back", "status", "failed"))
    and (.message | type == "string")
    and (.apps | type == "object")
    and all(.apps | to_entries[];
      (.key | test("^[a-z0-9][a-z0-9-]*$"))
      and (.value | type == "object")
      and (.value.repository | repository)
      and (.value.digest | digest)
      and (.value.previousDigest == null or (.value.previousDigest | digest))
      and (.value.slot | IN("blue", "green", null)));
  last(inputs | select(startswith("APP_RELEASE_RESULT ")))
  | ltrimstr("APP_RELEASE_RESULT ") | rtrimstr("\r")
  | (try fromjson catch null)
  | select(valid)
  | .result,
    (.apps | tojson),
    (.apps | length),
    (.apps | to_entries | sort_by(.key)[]
      | [.key, .value.repository, .value.digest, .value.previousDigest // "none", .value.slot // "none"]
      | join("\t")),
    .message
'
report=$(jq -nrR --arg unit "$unit" "$result_report" <"$log_file" 2>/dev/null) || report=""

result=""
message=""
apps_json=""
app_names=()
app_repositories=()
app_digests=()
app_previous_digests=()
app_slots=()
if [ -n "$report" ]; then
  {
    IFS= read -r result
    IFS= read -r apps_json
    IFS= read -r app_count
    for ((index = 0; index < app_count; index++)); do
      IFS=$'\t' read -r name repository digest previous_digest slot
      app_names+=("$name")
      app_repositories+=("$repository")
      app_digests+=("$digest")
      app_previous_digests+=("$previous_digest")
      app_slots+=("$slot")
    done
    IFS= read -r -d '' message || true
  } <<<"$report"
  message=${message%$'\n'}
  {
    printf 'result=%s\n' "$result"
    printf 'apps-json=%s\n' "$apps_json"
    printf 'live-images<<APP_RELEASE_LIVE_IMAGES_EOF\n'
    for index in "${!app_names[@]}"; do
      printf '%s@%s\n' "${app_repositories[index]}" "${app_digests[index]}"
    done
    printf 'APP_RELEASE_LIVE_IMAGES_EOF\n'
  } >>"$GITHUB_OUTPUT"
fi

{
  printf '### App release for `%s`\n\n' "$unit"
  printf 'Command `%s` on `%s` exited with code %s.\n\n' "$command" "$host" "$ssh_status"
  if [ -n "$report" ]; then
    printf 'Result: **%s**\n\n' "$result"
    if [ -n "$message" ]; then
      printf '%s\n\n' "$message"
    fi
    printf '| App | Digest | Previous digest | Slot |\n| --- | --- | --- | --- |\n'
    for index in "${!app_names[@]}"; do
      previous_digest=${app_previous_digests[index]}
      if [ "$previous_digest" != none ]; then
        previous_digest="\`$previous_digest\`"
      fi
      printf '| `%s` | `%s` | %s | %s |\n' \
        "${app_names[index]}" "${app_digests[index]}" "$previous_digest" "${app_slots[index]}"
    done
  else
    printf 'The host returned no valid `APP_RELEASE_RESULT` line.\n'
  fi
} >>"$GITHUB_STEP_SUMMARY"

detail=""
if [ -n "$message" ]; then
  detail=" Host message: $message"
fi
case "$ssh_status" in
  0) ;;
  1)
    annotate 'App release failed' "The $command for unit $unit failed, and the previous version is still serving.$detail"
    exit 1
    ;;
  2)
    annotate 'App release rejected' "The host rejected the $command request for unit $unit (authorization, validation, or syntax). Check that this workflow runs from the unit's repository and ref with an allowed event, that the unit lists this repository's SSH key, and that each image's org.opencontainers.image.revision label is the released commit.$detail"
    exit 2
    ;;
  3)
    annotate 'App release critical failure' "Production may be down. The $command for unit $unit failed, and the previous version could not be restored. Inspect the host now; the status command reports what is live.$detail"
    exit 3
    ;;
  4)
    annotate 'App release lock timeout' "Another app-release operation held the lock for unit $unit longer than the wait timeout. Nothing changed; re-run this job once that operation has finished.$detail"
    exit 4
    ;;
  255)
    annotate 'App release connection failed' "SSH to root@$host failed: the connection, host key, or key authentication was refused, or the connection dropped. A dropped connection does not stop an operation that already started; check the outcome with the status command."
    exit 255
    ;;
  *)
    annotate 'App release failed' "The app-release host exited with unexpected code $ssh_status.$detail"
    exit 1
    ;;
esac

if [ -z "$report" ]; then
  fail "The host exited 0 without a valid APP_RELEASE_RESULT line, so the outcome is unknown; check it with the status command."
fi
case "$command:$result" in
  release:released | release:unchanged | release:superseded | rollback:rolled-back | status:status) ;;
  *) fail "The host reported result $result for the $command command." ;;
esac
if [ "$result" = released ] || [ "$result" = unchanged ]; then
  live_matches_request=true
  if [ "${#app_names[@]}" -ne "${#requested[@]}" ]; then
    live_matches_request=false
  fi
  for index in "${!app_names[@]}"; do
    if [ "${requested[${app_names[index]}]-}" != "${app_digests[index]}" ]; then
      live_matches_request=false
    fi
  done
  if [ "$live_matches_request" != true ]; then
    fail "The host reported $result, but its live apps and digests differ from the requested images."
  fi
fi

if [ "$tag_production" != true ] || { [ "$result" != released ] && [ "$result" != unchanged ] && [ "$result" != rolled-back ]; }; then
  exit 0
fi

# A rerun of a release is idempotent: the host reports unchanged, and the tags
# move then. A second rollback would switch back to the newer version instead.
if [ "$command" = release ]; then
  retry_hint="Re-run this job to retry."
else
  retry_hint="Do not re-run the rollback, which would switch back; point each tag at its live-images entry with docker buildx imagetools create --prefer-index=false."
fi

non_ghcr=()
for repository in "${app_repositories[@]}"; do
  if [[ $repository != ghcr.io/* ]]; then
    non_ghcr+=("$repository")
  fi
done
if [ "${#non_ghcr[@]}" -gt 0 ]; then
  fail "The $command succeeded, but the production tags of ${non_ghcr[*]} cannot move: this action only authenticates to ghcr.io."
fi

# A private Docker config keeps the registry login out of ~/.docker for later
# steps, and the work directory cleanup deletes it with the SSH key.
export DOCKER_CONFIG="$work/docker"
mkdir -m 700 "$DOCKER_CONFIG"
if ! docker login ghcr.io --username "${GITHUB_ACTOR:-app-release}" --password-stdin <<<"$registry_token" >/dev/null; then
  fail "The $command succeeded, but logging in to ghcr.io to move the production tags failed; the job needs packages: write. $retry_hint"
fi
printf '\n' >>"$GITHUB_STEP_SUMMARY"
for index in "${!app_names[@]}"; do
  repository=${app_repositories[index]}
  digest=${app_digests[index]}
  if ! docker buildx imagetools create --prefer-index=false --tag "$repository:production" "$repository@$digest"; then
    fail "The $command succeeded, but pointing $repository:production at $digest failed. $retry_hint"
  fi
  echo "Moved $repository:production to $digest"
  printf -- '- Moved `%s:production` to `%s`\n' "$repository" "$digest" >>"$GITHUB_STEP_SUMMARY"
done
