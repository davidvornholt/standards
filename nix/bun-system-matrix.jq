# Maps every system with a pinned archive of the root packageManager's Bun to
# the native GitHub runner that builds its Nix checks. Run with
# `--slurpfile manifest package.json` on nix/bun-archives.json.
def runners: {
  "aarch64-linux": "ubuntu-24.04-arm",
  "x86_64-linux": "ubuntu-24.04"
};

$manifest[0].packageManager as $packageManager
| if ($packageManager | type == "string") and ($packageManager | test("^bun@(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$")) then
    .
  else
    error("package.json packageManager must pin an exact bun@x.y.z version")
  end
| ($packageManager | ltrimstr("bun@")) as $version
| if type != "object" then
    error("nix/bun-archives.json must be a JSON object")
  else
    .
  end
| .[$version]
| if type != "object" or length == 0 then
    error("nix/bun-archives.json has no archives for Bun \($version)")
  else
    .
  end
| keys
| map(
    . as $system
    | (runners | .[$system]) as $runner
    | if $runner == null then
        error("No native GitHub runner builds the Nix checks for \($system); add one to nix/bun-system-matrix.jq")
      else
        { runner: $runner, system: $system }
      end
  )
| { include: . }
