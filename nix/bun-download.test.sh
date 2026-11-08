#!/usr/bin/env bash
set -euo pipefail

# Run manually when changing the Bun fetcher. Fresh fixed-output names avoid a
# cached archive hiding a broken fallback; only the test derivations change.
export BUN_DOWNLOAD_REPO
BUN_DOWNLOAD_REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export BUN_DOWNLOAD_PROBE="$(date +%s)-$$"
expression='
let
  flake = builtins.getFlake (builtins.getEnv "BUN_DOWNLOAD_REPO");
  pkgs = flake.inputs.nixpkgs.legacyPackages.${builtins.currentSystem};
  system = builtins.getEnv "BUN_DOWNLOAD_SYSTEM";
  version = builtins.getEnv "BUN_DOWNLOAD_VERSION";
  archives = builtins.fromJSON (builtins.readFile (flake.outPath + "/nix/bun-archives.json"));
  source = (pkgs.callPackage (flake.outPath + "/nix/standards-bun.nix") {
    packageManager = "bun@${version}";
    stdenv = { hostPlatform = { inherit system; }; };
  }).src;
in
assert source.name == archives.${version}.${system}.asset;
source.overrideAttrs {
  name = "bun-download-${builtins.getEnv "BUN_DOWNLOAD_PROBE"}-${system}-${version}-${builtins.getEnv "BUN_DOWNLOAD_CORRUPT"}.zip";
  urls = [ "file:///missing-bun-browser-download" ] ++ builtins.tail source.urls;
  curlOptsList = source.curlOptsList ++ [ "--retry" "0" "--connect-timeout" "10" "--max-time" "60" ];
  preferHashedMirrors = false;
  hashedMirrors = [];
  outputHash = if builtins.getEnv "BUN_DOWNLOAD_CORRUPT" == "yes"
    then pkgs.lib.fakeHash else source.outputHash;
}
'

export BUN_DOWNLOAD_SYSTEM BUN_DOWNLOAD_VERSION BUN_DOWNLOAD_CORRUPT=no
# A plain assignment, unlike a process substitution, stops the script when the
# table can't be read.
archives=$(jq -er 'to_entries[] | .key as $version | .value | keys[] | [$version, .] | @tsv' "$BUN_DOWNLOAD_REPO/nix/bun-archives.json")
while IFS=$'\t' read -r BUN_DOWNLOAD_VERSION BUN_DOWNLOAD_SYSTEM; do
  nix build --no-link --impure --expr "$expression" -L
done <<<"$archives"

BUN_DOWNLOAD_VERSION=$(jq -er '.packageManager | ltrimstr("bun@")' "$BUN_DOWNLOAD_REPO/package.json")
BUN_DOWNLOAD_SYSTEM=x86_64-linux
BUN_DOWNLOAD_CORRUPT=yes
log=$(mktemp)
trap 'rm -f "$log"' EXIT
if nix build --no-link --impure --expr "$expression" -L >"$log" 2>&1; then
  echo 'Incorrect Bun checksum unexpectedly succeeded' >&2
  exit 1
fi
grep -F 'hash mismatch in fixed-output derivation' "$log"
echo 'Every pinned Bun archive recovered through the API; incorrect checksum rejected.'
