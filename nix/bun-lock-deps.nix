# A Bun workspace's production dependencies, installed from the packages that
# bun.lock records, each fetched by the integrity hash the lockfile holds. A
# change to bun.lock, such as a Dependabot update, needs no other edit, where a
# fixed-output install needs a new hash by hand.
#
# A repository that packages its CLI in nix/package.nix calls it as
#
#   nodeModules = callPackage ./bun-lock-deps.nix {
#     inherit bun src;
#     name = "${pname}-node-modules";
#     installFlags = [ "--filter" "@<project>/cli" ];
#   };
#
# and copies the result into its build tree before building. It holds every
# node_modules directory of the install, at the same paths as in src.
# installFlags go to `bun install` after
# `--frozen-lockfile --production --ignore-scripts`.
#
# Workspace entries are skipped. Every other bun.lock package must come from
# the default npm registry; a git, tarball or other-registry entry stops
# evaluation with a message. It builds for x86_64-linux and aarch64-linux and
# fetches only the packages that install there, development dependencies
# included, because bun.lock doesn't say which packages only they need.
{
  bun,
  fetchurl,
  lib,
  stdenvNoCC,
  name,
  src,
  installFlags ? [ ],
}:
let
  # Nix's JSON reader rejects the trailing commas Bun writes, so they go first;
  # no string in bun.lock holds a comma before a closing bracket.
  lock = builtins.fromJSON (
    lib.concatMapStrings (part: if builtins.isList part then builtins.head part else part) (
      builtins.split ",[[:space:]]*([]}])" (builtins.readFile "${src}/bun.lock")
    )
  );
  # An os or cpu field lists the values a package installs on, or, prefixed
  # with "!", the ones it doesn't.
  allows =
    field: value:
    let
      values = lib.toList field;
    in
    values == [ ]
    || lib.elem value values
    || (lib.all (lib.hasPrefix "!") values && !lib.elem "!${value}" values);
  cpu =
    {
      x86_64 = "x64";
      aarch64 = "arm64";
    }
    .${stdenvNoCC.hostPlatform.parsed.cpu.name};
  # The tarball path Bun requests from a registry for each package, and the
  # fetched tarball it gets there.
  tarballs = lib.listToAttrs (
    lib.concatMap (
      entry:
      let
        parsed = builtins.match "(@?[^@]+)@(.*)" (builtins.head entry);
        package = builtins.elemAt parsed 0;
        version = builtins.elemAt parsed 1;
        info = builtins.elemAt entry 2;
        tarball = "/${package}/-/${baseNameOf package}-${version}.tgz";
      in
      if lib.hasPrefix "workspace:" version then
        [ ]
      else if builtins.length entry != 4 || builtins.elemAt entry 1 != "" then
        throw "nix/bun-lock-deps.nix can only install packages from the default npm registry, not ${builtins.head entry} from bun.lock"
      else
        lib.optional (allows (info.os or [ ]) "linux" && allows (info.cpu or [ ]) cpu) (
          lib.nameValuePair tarball (fetchurl {
            url = "https://registry.npmjs.org${tarball}";
            hash = builtins.elemAt entry 3;
          })
        )
    ) (builtins.attrValues lock.packages)
  );
in
# Bun installs without a network from a registry on the build's loopback that
# serves the fetched tarballs. Filling Bun's install cache directly would need
# its folder names, which hold an internal hash of a prerelease version.
stdenvNoCC.mkDerivation {
  inherit name src;
  nativeBuildInputs = [ bun ];
  dontConfigure = true;
  tarballs = builtins.toJSON tarballs;
  passAsFile = [ "tarballs" ];
  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache
    bun -e "
      const [tarballs, portFile] = process.argv.slice(-2);
      const files = await Bun.file(tarballs).json();
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request) {
          const path = decodeURIComponent(new URL(request.url).pathname);
          if (Object.hasOwn(files, path)) return new Response(Bun.file(files[path]));
          console.error('The Nix build has no package at ' + path);
          return new Response(null, { status: 404 });
        },
      });
      await Bun.write(portFile, String(server.port));
    " "$tarballsPath" "$TMPDIR/registry-port" &
    registry=$!
    while [ ! -s "$TMPDIR/registry-port" ]; do
      kill -0 "$registry"
      sleep 0.1
    done
    BUN_CONFIG_REGISTRY="http://127.0.0.1:$(cat "$TMPDIR/registry-port")/" \
      bun install --frozen-lockfile --production --ignore-scripts --no-progress ${lib.escapeShellArgs installFlags}
    kill "$registry"
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mkdir "$out"
    find . -type d -name node_modules -prune -print0 | tar --null --files-from=- -cf - | tar -C "$out" -xf -
    runHook postInstall
  '';
  dontFixup = true;
}
