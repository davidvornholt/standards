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
  sources = {
    "1.4.0" = {
      x86_64-linux = {
        asset = "bun-linux-x64-baseline.zip";
        assetId = 521571115;
        hash = "sha256-GE+0WV8NQBohfPfHjBvEMLqDMU2reouUgFurv3+nCX8=";
      };
      aarch64-linux = {
        asset = "bun-linux-aarch64.zip";
        assetId = 521567814;
        hash = "sha256-SxozLuhhmD65O8/m93D/+U4+MbLDiL2uo8jtNeWO7Q4=";
      };
    };
    "1.4.2" = {
      x86_64-linux = {
        asset = "bun-linux-x64-baseline.zip";
        assetId = 545309055;
        hash = "sha256-xngEDxT+BEDrg503y9DOTAUaMtpygGrJfeamqra/co8=";
      };
      aarch64-linux = {
        asset = "bun-linux-aarch64.zip";
        assetId = 545308380;
        hash = "sha256-VDKLvC2cjgyfiSxUTWbFeoO4QTnjSQnl7oF1jxrI/ac=";
      };
    };
    "1.4.3" = {
      x86_64-linux = {
        asset = "bun-linux-x64-baseline.zip";
        assetId = 626789490;
        hash = "sha256-H8LtrIQxApCeOhvh2NmALMYHHPB05n6IIx9P/g+LOXs=";
      };
      aarch64-linux = {
        asset = "bun-linux-aarch64.zip";
        assetId = 626788529;
        hash = "sha256-76mBPaXtckI7+Ef5FujSxHwNd2rdlyNUAmp14Q2pqiE=";
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
bun.overrideAttrs (
  _final: _previous: {
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
      inherit (source) hash;
    };
  }
)
