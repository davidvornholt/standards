# Fails when package-source.nix and git disagree about whether a path is
# ignored. It asks `git check-ignore` about every path in the repository, about
# a sample path for each .gitignore pattern, such as
# .env.local.standards-x.tmp for `.env.local.standards-*.tmp`, and about cases
# below that the repository's .gitignore files don't show.
{
  git,
  lib,
  runCommand,
  src,
}:
let
  source = import ./package-source.nix { inherit lib; };
  rootString = toString src.origSrc;
  join = dir: name: if dir == "" then name else "${dir}/${name}";
  keepsPath = relative: type: src.filter "${rootString}/${relative}" type;

  # Every path in the root, as { relative; type; }, except below a directory
  # the source drops, which would take long for node_modules.
  existingPaths =
    let
      walk =
        dir:
        lib.concatLists (
          lib.mapAttrsToList (
            name: type:
            let
              relative = join dir name;
            in
            [ { inherit relative type; } ]
            ++ lib.optionals (type == "directory" && keepsPath relative type) (walk relative)
          ) (builtins.readDir (if dir == "" then rootString else "${rootString}/${dir}"))
        );
    in
    # lib.cleanSource also drops .git and editor backups, which git never ignores.
    lib.filter ({ relative, type }: lib.cleanSourceFilter "${rootString}/${relative}" type) (walk "");

  # The .gitignore files git reads: each regular one in a directory the source
  # keeps, also when the source drops the file itself. git doesn't follow a
  # symlinked one.
  gitignores = lib.filter (
    { relative, type }: type == "regular" && baseNameOf relative == ".gitignore"
  ) existingPaths;

  # A path that each .gitignore pattern matches, also one directory deeper for
  # a pattern that applies at any depth.
  patternSamples = lib.concatMap (
    { relative, ... }:
    let
      base = dirOf relative;
      sample =
        line:
        let
          pattern = lib.removePrefix "!" line;
          directory = lib.hasSuffix "/" pattern;
          trimmed = lib.removePrefix "/" (lib.removeSuffix "/" pattern);
          name =
            builtins.replaceStrings
              [
                "**/"
                "**"
                "*"
                "?"
              ]
              [
                ""
                "x"
                "x"
                "x"
              ]
              trimmed;
          anchored = lib.hasInfix "/" (lib.removeSuffix "/" pattern);
          at = prefix: {
            relative = join (if base == "." then "" else base) (prefix + name);
            type = if directory then "directory" else "regular";
          };
        in
        [ (at "") ] ++ lib.optional (!anchored) (at "sample-directory/");
    in
    lib.concatMap sample (source.patternsOf (builtins.readFile "${rootString}/${relative}"))
  ) gitignores;

  # Whether keeps keeps a path that may not exist, which needs every directory
  # above it kept as well.
  keepsWithParents =
    keeps:
    { relative, type }:
    lib.all (parent: keeps parent "directory") (parentsOf relative) && keeps relative type;
  parentsOf =
    relative:
    let
      parts = lib.splitString "/" relative;
    in
    lib.genList (count: lib.concatStringsSep "/" (lib.take (count + 1) parts)) (lib.length parts - 1);

  # Cases with the .gitignore files for each directory, by its path, and the
  # paths to ask about, where a trailing slash marks a directory.
  cases = {
    trailing-spaces = {
      gitignores."" = "private.yaml   \nprivate/   \n";
      paths = [
        "private.yaml"
        "private/"
        "private/data"
        "public.yaml"
      ];
    };
    carriage-returns = {
      gitignores."" = "private.yaml\r\nlocal/\r\n";
      paths = [
        "private.yaml"
        "local/"
        "local/data"
      ];
    };
    byte-order-mark = {
      gitignores."" = builtins.fromJSON ''"﻿private.yaml\n"'';
      paths = [ "private.yaml" ];
    };
    tab-name = {
      gitignores."" = "\t\n";
      paths = [
        "\t"
        "public"
      ];
    };
    directory-negation = {
      gitignores."" = "bar/\n!foo/\n";
      paths = [
        "foo/"
        "foo/bar/"
        "foo/bar/private.yaml"
      ];
    };
    negated-directory-name = {
      gitignores."" = "*.yaml\n!foo\n!a/**/b.yaml\n";
      paths = [
        "foo/"
        "foo/private.yaml"
        "a/"
        "a/b.yaml"
        "a/x/"
        "a/x/b.yaml"
        "a/x/c.yaml"
      ];
    };
    metacharacters = {
      gitignores."" = "a+b.yaml\nc|d\n(e)\n^f\n$g\n{h}\n.i\n";
      paths = [
        "a+b.yaml"
        "aab.yaml"
        "c|d"
        "c"
        "d"
        "(e)"
        "e"
        "^f"
        "f"
        "$g"
        "g"
        "{h}"
        "h"
        ".i"
        "xi"
      ];
    };
    anchoring = {
      gitignores."" = "/root-only\nmid/dle\n*.log\n**/build\nlogs/**\n/top/**/deep\n";
      paths = [
        "root-only"
        "a/root-only"
        "mid/"
        "mid/dle"
        "a/mid/dle"
        "x.log"
        "a/b/x.log"
        "build"
        "a/b/build"
        "logs/"
        "logs/x"
        "logs/a/b"
        "top/"
        "top/deep"
        "top/a/b/deep"
        "a/top/deep"
      ];
    };
    ignored-gitignore = {
      gitignores = {
        "" = "sub/.gitignore\n";
        sub = "private.txt\n";
      };
      paths = [
        "sub/"
        "sub/.gitignore"
        "sub/private.txt"
      ];
    };
    nested = {
      gitignores = {
        "" = "*.yaml\nanchored\n";
        sub = "!keep.yaml\n/anchored\n!/deeper/\n";
      };
      paths = [
        "sub/"
        "sub/keep.yaml"
        "sub/other.yaml"
        "sub/anchored"
        "sub/deeper/"
        "sub/deeper/anchored"
        "sub/deeper/keep.yaml"
        "anchored"
      ];
    };
  };

  # Lines git accepts that package-source.nix must refuse rather than guess.
  unsupportedLines = [
    "private\\.yaml"
    "private\\ "
    "[!a].yaml"
    "a[/]b.yaml"
    "private[.yaml"
    "a**b"
    "private/**/**"
    "**/**"
  ];
  acceptedUnsupportedLines = lib.filter (
    line: (builtins.tryEval (builtins.deepSeq (source.rulesOf "" line) true)).success
  ) unsupportedLines;

  lineFile = name: paths: builtins.toFile name (lib.concatMapStrings (path: path + "\n") paths);

  # A script that builds a tree with the samples and .gitignore files and
  # compares git's answers with keeps.
  compare =
    {
      name,
      samples,
      keeps,
      copyGitignores,
    }:
    let
      relativesOf = list: map (sample: sample.relative) list;
    in
    ''
      compare ${lib.escapeShellArg name} \
        ${
          lineFile "directories" (relativesOf (lib.filter (sample: sample.type == "directory") samples))
        } \
        ${lineFile "files" (relativesOf (lib.filter (sample: sample.type != "directory") samples))} \
        ${lineFile "all" (relativesOf samples)} \
        ${
          lineFile "dropped" (relativesOf (lib.filter (sample: !keepsWithParents keeps sample) samples))
        } \
        ${lib.escapeShellArg copyGitignores}
    '';

  # One sample per path. A path that exists keeps its type, a pattern sample
  # below an existing file is left out, and one that another sample is below
  # becomes a directory.
  repositorySamples =
    let
      byPath =
        samples:
        builtins.listToAttrs (
          map (sample: {
            name = sample.relative;
            value = sample;
          }) samples
        );
      existing = byPath existingPaths;
      placeable = lib.filter (
        sample:
        !existing ? ${sample.relative}
        && lib.all (parent: (existing.${parent}.type or "directory") == "directory") (
          parentsOf sample.relative
        )
      ) patternSamples;
      parents = lib.genAttrs (lib.concatMap (sample: parentsOf sample.relative) placeable) (_: true);
    in
    lib.attrValues existing
    ++ lib.attrValues (
      byPath (
        map (
          sample: if parents ? ${sample.relative} then sample // { type = "directory"; } else sample
        ) placeable
      )
    );

  caseScript =
    name:
    { gitignores, paths }:
    let
      rulesFor =
        dir:
        (if dir == "" then [ ] else rulesFor (source.parentOf dir))
        ++ lib.optionals (gitignores ? ${dir}) (source.rulesOf dir gitignores.${dir});
    in
    compare {
      name = "case ${name}";
      samples = map (
        path:
        if lib.hasSuffix "/" path then
          {
            relative = lib.removeSuffix "/" path;
            type = "directory";
          }
        else
          {
            relative = path;
            type = "regular";
          }
      ) paths;
      keeps = relative: source.keeps (rulesFor (source.parentOf relative)) relative;
      copyGitignores = lib.concatStrings (
        lib.mapAttrsToList (dir: text: ''
          mkdir -p ./${lib.escapeShellArg dir}
          cp ${builtins.toFile "gitignore" text} ./${lib.escapeShellArg dir}/.gitignore
        '') gitignores
      );
    };
in
runCommand "package-source-check" { nativeBuildInputs = [ git ]; } ''
  export HOME=$TMPDIR GIT_CONFIG_NOSYSTEM=1
  failed=0
  compare() {
    local name=$1 directories=$2 files=$3 all=$4 dropped=$5 copy_gitignores=$6
    local tree
    tree=$(mktemp -d)
    (
      cd "$tree"
      git init --quiet
      # git matches a pattern that ends in a slash only against a directory it
      # can see, so each directory gets a file.
      while IFS= read -r path; do
        mkdir -p -- "$path"
        touch -- "$path/.sample"
      done < "$directories"
      while IFS= read -r path; do
        mkdir -p -- "$(dirname -- "$path")"
        touch -- "$path"
      done < "$files"
      eval "$copy_gitignores"
      # check-ignore exits with 1 when it ignores nothing and above 1 on errors.
      status=0
      tr '\n' '\0' < "$all" | git check-ignore --no-index -z --stdin > "$TMPDIR/ignored" || status=$?
      if [ "$status" -gt 1 ]; then exit "$status"; fi
      tr '\0' '\n' < "$TMPDIR/ignored" | sort > "$TMPDIR/ignored-by-git"
      sort "$dropped" > "$TMPDIR/dropped-by-nix"
      diff -u --label "dropped by the package source" --label "ignored by git" \
        "$TMPDIR/dropped-by-nix" "$TMPDIR/ignored-by-git"
    ) || {
      echo "The package source and git disagree on the paths above, in $name." >&2
      failed=1
    }
  }

  ${compare {
    name = "the repository";
    samples = repositorySamples;
    keeps = keepsPath;
    copyGitignores = lib.concatMapStrings (
      { relative, ... }:
      ''
        mkdir -p ./${lib.escapeShellArg (dirOf relative)}
        cp ${builtins.toFile "gitignore" (builtins.readFile "${rootString}/${relative}")} ./${lib.escapeShellArg relative}
      ''
    ) gitignores;
  }}
  ${lib.concatStrings (lib.mapAttrsToList caseScript cases)}
  ${lib.optionalString (acceptedUnsupportedLines != [ ]) ''
    echo "package-source.nix accepted lines it can't match as git does:" >&2
    printf '%s\n' ${lib.escapeShellArgs acceptedUnsupportedLines} >&2
    failed=1
  ''}
  if [ "$failed" -ne 0 ]; then exit 1; fi
  touch "$out"
''
