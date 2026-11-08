{
  bun,
  fetchurl,
  lib,
  packageManager,
  stdenv,
}:
let
  bunVersion =
    if
      builtins.match "^bun@(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$" packageManager == null
    then
      throw "packageManager must pin an exact bun@x.y.z version"
    else
      lib.removePrefix "bun@" packageManager;
  # The x64 archives are Bun's baseline build, which also runs on CPUs without
  # AVX2. The canonical workflow's settings checker pins the same archives.
  archives = builtins.fromJSON (builtins.readFile ./bun-archives.json);
  versionSources =
    archives.${bunVersion}
      or (throw "Unsupported Bun version ${bunVersion}; add its official archives to nix/bun-archives.json");
  source =
    versionSources.${stdenv.hostPlatform.system}
      or (throw "Bun ${bunVersion} is not available for ${stdenv.hostPlatform.system}");
in
bun.overrideAttrs (
  _final: previous: {
    version = bunVersion;
    src = fetchurl {
      name = source.asset;
      urls = [
        "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/${source.asset}"
        "https://api.github.com/repos/oven-sh/bun/releases/assets/${toString source.assetId}"
      ];
      curlOptsList = [
        "-H"
        "Accept: application/octet-stream"
      ];
      inherit (source) sha256;
    };
    meta = previous.meta // {
      platforms = builtins.attrNames versionSources;
    };
  }
)
