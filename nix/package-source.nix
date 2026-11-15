# The repository's files that git doesn't ignore, as a package source.
#
# This keeps local env files, decrypted secrets, dependencies and build output
# out of the package when Nix evaluates it from a working tree. It can't keep
# them out of the Nix store for a path: flake, such as `nix build path:.`,
# which copies the whole directory, ignored files included, into the store
# before this runs. A git flake, such as `nix build .` in a checkout, copies
# only tracked files.
#
# Evaluation fails on a .gitignore line that this can't match exactly as git
# does, such as one with a backslash, a character class, ** inside a name, or
# ** twice in a row.
#
# A repository that packages its CLI in nix/package.nix builds it from
# `import ./package-source.nix { inherit lib; } ../.` and exposes
# package-source-check.nix, which compares the result with git, as
# `checks.<system>.package-source` with the package's src. The Standards
# workflow builds that check whenever nix/package.nix exists.
{ lib }:
let
  parentOf =
    dir:
    let
      parent = dirOf dir;
    in
    if parent == "." then "" else parent;
  byteOrderMark = builtins.fromJSON ''"﻿"'';

  # The patterns in a .gitignore's text, as git reads them.
  patternsOf =
    text:
    let
      withoutTrailingSpaces =
        line:
        let
          kept = builtins.match "(.*[^ ])[ ]*" (lib.removeSuffix "\r" line);
        in
        if kept == null then "" else builtins.head kept;
      lines = map withoutTrailingSpaces (lib.splitString "\n" (lib.removePrefix byteOrderMark text));
    in
    lib.filter (line: line != "" && !lib.hasPrefix "#" line) lines;

  # The rules of the .gitignore in dir, relative to the root, with its text.
  rulesOf =
    dir: text:
    map (
      line:
      let
        keep = lib.hasPrefix "!" line;
        pattern = lib.removePrefix "!" line;
        directoryOnly = lib.hasSuffix "/" pattern;
        body = lib.removeSuffix "/" pattern;
        segments = lib.splitString "/" (lib.removePrefix "/" body);
        supported =
          builtins.match ".*[][\\\\].*" pattern == null
          && !lib.hasInfix "**/**" pattern
          && lib.all (segment: segment != "" && (segment == "**" || !lib.hasInfix "**" segment)) segments;
        character =
          char:
          if char == "*" then
            "[^/]*"
          else if char == "?" then
            "[^/]"
          else if char == "^" then
            "\\^"
          else if builtins.match "[[:alnum:]_-]" char != null then
            char
          else
            "[${char}]";
        translated = builtins.replaceStrings [ "/**/" "**/" "/**" ] [ "/(.*/)?" "(.*/)?" "/.*" ] (
          lib.concatMapStringsSep "/" (
            segment:
            if segment == "**" then segment else lib.concatMapStrings character (lib.stringToCharacters segment)
          ) segments
        );
      in
      if !supported then
        throw "package-source.nix can't match the line `${line}` in ${
          if dir == "" then "" else "${dir}/"
        }.gitignore as git does. Write it without backslashes, character classes, ** inside a name, or ** twice in a row."
      else
        {
          base = dir;
          inherit keep directoryOnly;
          # A pattern with a slash other than at its end is relative to its
          # .gitignore's directory, and one without applies at any depth.
          regex =
            (if lib.hasInfix "/" body then "" else "(.*/)?")
            + (if translated == "**" then ".*" else translated);
        }
    ) (patternsOf text);

  # Whether git keeps a path, relative to the root, given the rules of the
  # .gitignore files above it, when it keeps every directory above the path.
  # A rule matches only the path itself; a path below an ignored directory is
  # left out because the directory is.
  keeps =
    rules: relative: type:
    let
      relativeTo = base: if base == "" then relative else lib.removePrefix "${base}/" relative;
      matches =
        rule:
        (!rule.directoryOnly || type == "directory")
        && builtins.match rule.regex (relativeTo rule.base) != null;
      matching = lib.filter matches rules;
    in
    matching == [ ] || (lib.last matching).keep;

  source =
    root:
    let
      rootString = toString root;
      pathOf = dir: if dir == "" then rootString else "${rootString}/${dir}";
      join = dir: name: if dir == "" then name else "${dir}/${name}";

      # The rules that apply inside each directory the source keeps, by its
      # path relative to the root. git doesn't follow a symlinked .gitignore.
      rulesByDirectory =
        let
          walk =
            dir: inherited:
            let
              entries = builtins.readDir (pathOf dir);
              rules =
                inherited
                ++ lib.optionals ((entries.".gitignore" or null) == "regular") (
                  rulesOf dir (builtins.readFile "${pathOf dir}/.gitignore")
                );
              subdirectories = lib.filter (
                name:
                entries.${name} == "directory"
                && lib.cleanSourceFilter "${rootString}/${join dir name}" "directory"
                && keeps rules (join dir name) "directory"
              ) (lib.attrNames entries);
            in
            lib.foldl' (acc: name: acc // walk (join dir name) rules) { ${dir} = rules; } subdirectories;
        in
        walk "" [ ];
      # A directory that doesn't exist has no .gitignore of its own.
      rulesFor = dir: rulesByDirectory.${dir} or (rulesFor (parentOf dir));
    in
    lib.cleanSourceWith {
      src = lib.cleanSource root;
      filter =
        path: type:
        let
          relative = lib.removePrefix "${rootString}/" path;
        in
        keeps (rulesFor (parentOf relative)) relative type;
    };
in
{
  inherit
    parentOf
    patternsOf
    rulesOf
    keeps
    ;
  __functor = _: source;
}
