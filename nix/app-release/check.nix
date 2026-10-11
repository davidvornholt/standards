{
  appRelease,
  lib,
  python3,
  ruff,
  runCommand,
}:
let
  python = python3.withPackages (ps: [
    ps.cryptography
    ps.mypy
    ps.pyjwt
  ]);
in
runCommand "app-release-check-${appRelease.version}"
  {
    nativeBuildInputs = [
      python
      ruff
    ];
    src = lib.fileset.toSource {
      root = ./.;
      fileset = lib.fileset.unions [
        ./pyproject.toml
        ./src
        ./tests
        ./vm-test.py
      ];
    };
  }
  ''
    cp -R "$src/." source
    chmod -R u+w source
    cd source
    export HOME="$TMPDIR"
    ruff check --no-cache .
    ruff format --check --no-cache .
    python -m mypy --strict --cache-dir "$TMPDIR/mypy" src tests
    PYTHONPATH=src python -m unittest discover --start-directory tests --top-level-directory . --verbose
    ${appRelease}/bin/app-release --help >/dev/null
    grep -Fq "APP_RELEASE_EXECUTABLE='${appRelease}/bin/app-release'" ${appRelease}/bin/app-release-ssh
    touch "$out"
  ''
