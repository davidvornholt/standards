#!/usr/bin/env bash
set -euo pipefail

# Run manually when changing Bun fetchers. Fresh fixed-output names avoid a
# cached archive hiding a broken fallback; only the test derivations change.
export BUN_DOWNLOAD_REPO
BUN_DOWNLOAD_REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export BUN_DOWNLOAD_PROBE="$(date +%s)-$$"
expression='
let
  flake = builtins.getFlake (builtins.getEnv "BUN_DOWNLOAD_REPO");
  pkgs = flake.inputs.nixpkgs.legacyPackages.${builtins.currentSystem};
  system = builtins.getEnv "BUN_DOWNLOAD_SYSTEM";
  kind = builtins.getEnv "BUN_DOWNLOAD_KIND";
  metadata = builtins.fromJSON (builtins.readFile (flake.outPath + "/nix/bun-system-metadata.json"));
  source = if kind == "cli" then
    (pkgs.callPackage (flake.outPath + "/nix/standards-cli.nix") {
      src = flake.outPath;
      bunSystemMetadata = { ${builtins.currentSystem} = metadata.${system}; };
    }).bun.src
  else
    (pkgs.callPackage (flake.outPath + "/nix/standards-bun.nix") {
      packageManager = "bun@${builtins.getEnv "BUN_DOWNLOAD_VERSION"}";
      stdenv = { hostPlatform = { inherit system; }; };
    }).src;
  platform = if system == "aarch64-linux" then "aarch64"
    else if kind == "cli" then "x64" else "x64-baseline";
in
assert source.name == "bun-linux-${platform}.zip";
source.overrideAttrs {
  name = "bun-download-${builtins.getEnv "BUN_DOWNLOAD_PROBE"}-${kind}-${system}-${builtins.getEnv "BUN_DOWNLOAD_VERSION"}-${builtins.getEnv "BUN_DOWNLOAD_CORRUPT"}.zip";
  urls = [ "file:///missing-bun-browser-download" ] ++ builtins.tail source.urls;
  curlOptsList = source.curlOptsList ++ [ "--retry" "0" "--connect-timeout" "10" "--max-time" "60" ];
  preferHashedMirrors = false;
  hashedMirrors = [];
  outputHash = if builtins.getEnv "BUN_DOWNLOAD_CORRUPT" == "yes"
    then pkgs.lib.fakeHash else source.outputHash;
}
'

export BUN_DOWNLOAD_KIND BUN_DOWNLOAD_SYSTEM BUN_DOWNLOAD_VERSION BUN_DOWNLOAD_CORRUPT=no
for BUN_DOWNLOAD_KIND in cli shell; do
  versions=(1.4.3)
  if [[ "$BUN_DOWNLOAD_KIND" = shell ]]; then versions=(1.4.0 1.4.2 1.4.3); fi
  for BUN_DOWNLOAD_VERSION in "${versions[@]}"; do
    for BUN_DOWNLOAD_SYSTEM in x86_64-linux aarch64-linux; do
      nix build --no-link --no-substitute --impure --expr "$expression" -L
    done
  done
done

BUN_DOWNLOAD_KIND=cli
BUN_DOWNLOAD_SYSTEM=x86_64-linux
BUN_DOWNLOAD_CORRUPT=yes
log=$(mktemp)
trap 'rm -f "$log"' EXIT
if nix build --no-link --no-substitute --impure --expr "$expression" -L >"$log" 2>&1; then
  echo 'Incorrect Bun checksum unexpectedly succeeded' >&2
  exit 1
fi
grep -F 'hash mismatch in fixed-output derivation' "$log"
echo 'Both Bun fetchers recovered through the API on both architectures; incorrect checksum rejected.'
