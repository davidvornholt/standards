{
  callPackage,
  lib,
  makeWrapper,
  src,
  standardsBun,
  stdenvNoCC,
}:
let
  rootManifest = builtins.fromJSON (builtins.readFile (src + "/package.json"));
  cliManifest = builtins.fromJSON (builtins.readFile (src + "/packages/standards-cli/package.json"));
  packageName = cliManifest.name;
  version = cliManifest.version;
  bunVersion = standardsBun.version;
  runtimeDependencies = callPackage ./bun-lock-deps.nix {
    inherit src;
    bun = standardsBun;
    name = "standards-cli-runtime-dependencies-${version}";
    installFlags = [
      "--filter"
      packageName
    ];
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
    inherit (standardsBun.meta) platforms;
  };
}
