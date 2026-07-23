{
  bun,
  cacert,
  fetchurl,
  lib,
  makeWrapper,
  src,
  stdenvNoCC,
}:
let
  rootManifest = builtins.fromJSON (builtins.readFile (src + "/package.json"));
  cliManifest = builtins.fromJSON (builtins.readFile (src + "/packages/standards-cli/package.json"));
  packageName = cliManifest.name;
  version = cliManifest.version;
  bunVersion = lib.removePrefix "bun@" rootManifest.packageManager;
  bunPlatform =
    {
      aarch64-linux = "aarch64";
      x86_64-linux = "x64";
    }
    .${stdenvNoCC.hostPlatform.system};
  bunArchiveHash =
    {
      aarch64-linux = "sha256-on/7Y6gxA3WDbg1vZorhf6jY0YuIw3yCHGUzGXOhmjs=";
      x86_64-linux = "sha256-lR7iruhV8IWVruxiJSJqKY0/6oOj3NZGXAnLzN9+hI8=";
    }
    .${stdenvNoCC.hostPlatform.system};
  standardsBun = bun.overrideAttrs {
    version = bunVersion;
    src = fetchurl {
      url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-linux-${bunPlatform}.zip";
      hash = bunArchiveHash;
    };
  };
  runtimeDependencies = stdenvNoCC.mkDerivation {
    pname = "standards-cli-runtime-dependencies";
    inherit src version;
    nativeBuildInputs = [ standardsBun ];
    SSL_CERT_FILE = "${cacert}/etc/ssl/certs/ca-bundle.crt";
    buildPhase = ''
      runHook preBuild
      export HOME="$TMPDIR/home"
      mkdir -p "$HOME"
      bun install \
        --backend=copyfile \
        --filter=${lib.escapeShellArg packageName} \
        --frozen-lockfile \
        --ignore-scripts \
        --production
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/packages/standards-cli"
      cp -R node_modules "$out/node_modules"
      cp -R packages/standards-cli/node_modules "$out/packages/standards-cli/node_modules"
      runHook postInstall
    '';
    outputHash = "sha256-VbwHHtCVE0ASZxPIr5yiybBJqiB5FTbvUOcA7OLwV24=";
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
  };
in
assert rootManifest.packageManager == "bun@${bunVersion}";
assert cliManifest.engines.bun == ">=${bunVersion}";
stdenvNoCC.mkDerivation {
  pname = "standards-cli";
  inherit src version;
  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    cliRoot="$out/lib/standards/packages/standards-cli"
    mkdir -p "$cliRoot" "$out/bin" "$out/lib/standards"
    cp -R packages/standards-cli/src "$cliRoot/src"
    cp packages/standards-cli/package.json "$cliRoot/package.json"
    cp -R ${runtimeDependencies}/node_modules "$out/lib/standards/node_modules"
    cp -R ${runtimeDependencies}/packages/standards-cli/node_modules "$cliRoot/node_modules"
    ln -s ${standardsBun}/bin/bun "$out/bin/bun"
    ln -s ${standardsBun}/bin/bunx "$out/bin/bunx"
    makeWrapper ${standardsBun}/bin/bun "$out/bin/standards" \
      --add-flags "$cliRoot/src/cli.ts" \
      --prefix PATH : "$out/bin"
    runHook postInstall
  '';
  passthru = {
    bun = standardsBun;
    inherit cliManifest runtimeDependencies src;
  };
  meta = {
    description = cliManifest.description;
    homepage = cliManifest.homepage;
    license = lib.licenses.mit;
    mainProgram = "standards";
    platforms = [
      "aarch64-linux"
      "x86_64-linux"
    ];
  };
}
