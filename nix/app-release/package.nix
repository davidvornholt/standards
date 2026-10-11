{
  bash,
  cacert,
  coreutils,
  lib,
  podman,
  python3Packages,
  systemd,
  caFile ? "${cacert}/etc/ssl/certs/ca-bundle.crt",
}:
let
  pyproject = lib.importTOML ./pyproject.toml;
  toolPath = lib.makeBinPath [
    bash
    coreutils
    podman
    systemd
  ];
in
python3Packages.buildPythonApplication {
  pname = pyproject.project.name;
  inherit (pyproject.project) version;
  pyproject = true;

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./pyproject.toml
      ./src
    ];
  };

  build-system = [ python3Packages.setuptools ];
  dependencies = [
    python3Packages.cryptography
    python3Packages.pyjwt
  ];

  # Every external tool is pinned by store path. Health and pre-stop commands
  # run with the pinned tools first and the system profile after them.
  makeWrapperArgs = [
    "--set APP_RELEASE_PODMAN ${lib.getExe' podman "podman"}"
    "--set APP_RELEASE_SYSTEMCTL ${lib.getExe' systemd "systemctl"}"
    "--set APP_RELEASE_SYSTEMD_RUN ${lib.getExe' systemd "systemd-run"}"
    "--set APP_RELEASE_BASH ${lib.getExe bash}"
    "--set APP_RELEASE_CA_FILE ${caFile}"
    "--set APP_RELEASE_CONFIG_DIR /etc/app-release"
    "--set APP_RELEASE_STATE_DIR /var/lib/app-release"
    "--set APP_RELEASE_RUN_DIR /run/app-release"
    "--set APP_RELEASE_CACHE_DIR /var/cache/app-release"
    "--set PATH ${toolPath}:/run/current-system/sw/bin"
  ];

  preFixup = ''
    makeWrapperArgs+=(--set APP_RELEASE_EXECUTABLE "$out/bin/app-release")
  '';

  pythonImportsCheck = [ "app_release" ];

  meta = {
    description = "Zero-downtime app releases for NixOS hosts";
    mainProgram = "app-release";
    platforms = lib.platforms.linux;
  };
}
