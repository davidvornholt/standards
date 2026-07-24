{
  bunSystemMetadata,
  lib,
  runCommand,
  standardsCli,
}:
assert lib.assertMsg (
  standardsCli.meta.platforms == builtins.attrNames bunSystemMetadata
) "standards CLI advertised platforms must match the Bun system metadata";
runCommand "standards-cli-check-${standardsCli.version}"
  {
    nativeBuildInputs = [ standardsCli ];
  }
  ''
    standards help >"$TMPDIR/help.txt"
    grep -F "poller      Run one fix-poller tick" "$TMPDIR/help.txt"
    test "$(bun --version)" = ${lib.escapeShellArg standardsCli.bun.version}

    cd ${standardsCli}/lib/standards/packages/standards-cli
    bun -e '
      const manifest = await Bun.file(process.argv[1]).json();
      const lock = Bun.JSONC.parse(await Bun.file(process.argv[2]).text());
      for (const dependencyName of Object.keys(manifest.dependencies)) {
        const lockedId = lock.packages[dependencyName]?.[0];
        if (typeof lockedId !== "string") {
          throw new Error(`''${dependencyName} has no bun.lock package entry`);
        }
        const installedPath = Bun.resolveSync(
          `''${dependencyName}/package.json`,
          process.argv[3],
        );
        const installed = await Bun.file(installedPath).json();
        if (lockedId !== `''${dependencyName}@''${installed.version}`) {
          throw new Error(
            `''${dependencyName}: packaged ''${installed.version}, bun.lock has ''${lockedId}`,
          );
        }
      }
    ' \
      ${standardsCli.src}/packages/standards-cli/package.json \
      ${standardsCli.src}/bun.lock \
      ${standardsCli}/lib/standards/packages/standards-cli

    pollerConfig="$TMPDIR/poller.json"
    printf '%s\n' \
      '{' \
      '  "repos": ["davidvornholt/standards"],' \
      '  "model": "test-model",' \
      '  "reasoningEffort": "test-effort",' \
      '  "cacheDir": "./cache"' \
      '}' >"$pollerConfig"
    standards poller --print-units --config "$pollerConfig" >"$TMPDIR/units.txt"
    grep -F "standards-poller.service" "$TMPDIR/units.txt"
    grep -F "standards-poller-acknowledgements.service" "$TMPDIR/units.txt"
    grep -F "standards-poller.timer" "$TMPDIR/units.txt"

    mkdir "$out"
    cp "$TMPDIR/help.txt" "$TMPDIR/units.txt" "$out/"
  ''
