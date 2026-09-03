{
  bun,
  fetchurl,
  lib,
  packageManager,
  stdenv,
}:
let
  bunVersion =
    if builtins.match "^bun@(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$" packageManager == null then
      throw "packageManager must pin an exact bun@x.y.z version"
    else
      lib.removePrefix "bun@" packageManager;
  sources = {
    "1.4.0" = {
      x86_64-linux = {
        asset = "bun-linux-x64-baseline.zip";
        hash = "sha256-GE+0WV8NQBohfPfHjBvEMLqDMU2reouUgFurv3+nCX8=";
      };
      aarch64-linux = {
        asset = "bun-linux-aarch64.zip";
        hash = "sha256-SxozLuhhmD65O8/m93D/+U4+MbLDiL2uo8jtNeWO7Q4=";
      };
    };
  };
  versionSources =
    sources.${bunVersion}
      or (throw "Unsupported Bun version ${bunVersion}; add its official archive hashes to nix/standards-bun.nix");
  source =
    versionSources.${stdenv.hostPlatform.system}
      or (throw "Bun ${bunVersion} is not available for ${stdenv.hostPlatform.system}");
in
bun.overrideAttrs (_final: _previous: {
  version = bunVersion;
  src = fetchurl {
    url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/${source.asset}";
    inherit (source) hash;
  };
})
