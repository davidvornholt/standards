# NixOS reference implementations

Canonical implementations of the server profile. Copy the sections the host
needs into its repo — flattened into the host configuration or as local
modules, whichever reads better there — and fill in the `let` parameters.
These are opinions, not templates to generalize: keep the values unless the
host has a documented reason to differ.

## Base hardening

```nix
{ config, lib, pkgs, ... }:
let
  adminUser = "david";
  adminSshKeys = [ "ssh-ed25519 ..." ];
  deploySshKeys = [ "ssh-ed25519 ..." ]; # CI deploy keys, root-only
in {
  nix.settings = {
    experimental-features = [ "nix-command" "flakes" ];
    trusted-users = [ "root" adminUser ];
  };
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 14d";
  };

  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = true;

  users.users.${adminUser} = {
    isNormalUser = true;
    extraGroups = [ "wheel" "podman" ];
    openssh.authorizedKeys.keys = adminSshKeys;
  };
  users.users.root.openssh.authorizedKeys.keys = deploySshKeys;
  security.sudo.wheelNeedsPassword = false;

  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      PermitRootLogin = "prohibit-password";
      KbdInteractiveAuthentication = false;
    };
  };
  services.fail2ban = {
    enable = true;
    maxretry = 5;
    bantime = "1h";
  };

  networking.firewall = {
    enable = true;
    allowedTCPPorts = [ 22 80 443 ];
  };

  services.journald.extraConfig = ''
    SystemMaxUse=1G
    MaxRetentionSec=14day
  '';

  environment.systemPackages = with pkgs; [
    curl dig gitMinimal htop jq lsof rsync vim
  ];
}
```

## Caddy reverse proxy

```nix
services.caddy = {
  enable = true;
  email = "acme-contact@example.com"; # required: ACME registration contact
};
```

App modules add their own `services.caddy.virtualHosts`; nothing else opens
80/443.

## Podman

```nix
virtualisation.podman = {
  enable = true;
  defaultNetwork.settings.dns_enabled = true; # containers resolve each other by name
};
virtualisation.oci-containers.backend = "podman";
```

## PostgreSQL (peer auth per app)

Each app database's role is owned by the database of the same name; listed
system users may peer-authenticate as it over the socket. Loopback TCP gets
scram; sockets never get passwords.

```nix
{ config, lib, ... }:
let
  appDatabases = [ "my_app" ]; # database name == role name
  appSystemUsers = [ "my-app" "david" ]; # may peer-auth as any app role
  databaseSystemUsers = { }; # per-DB override, e.g. { app_pr_47 = [ "app-pr-47" ]; }
  databases = lib.unique (appDatabases ++ lib.attrNames databaseSystemUsers);
  usersFor = db: databaseSystemUsers.${db} or appSystemUsers;
in {
  services.postgresql = {
    enable = true;
    ensureDatabases = databases;
    ensureUsers = map (name: {
      inherit name;
      ensureDBOwnership = true;
    }) databases;
    authentication = lib.mkForce ''
      local all postgres peer
      ${lib.concatMapStringsSep "\n"
      (name: "local ${name} ${name} peer map=${name}") databases}
      local all all peer
      host all all 127.0.0.1/32 scram-sha-256
      host all all ::1/128 scram-sha-256
    '';
    identMap = lib.concatMapStringsSep "\n" (db:
      lib.concatMapStringsSep "\n" (user: "${db} ${user} ${db}")
      (usersFor db)) databases;
  };
}
```

## PostgreSQL backup timer

```nix
{ config, lib, ... }:
let
  postgresDatabases = [ "my_app" ];
  directory = "/var/backups/postgres";
  retentionDays = 14;
in {
  systemd.tmpfiles.rules = [ "d ${directory} 0750 postgres postgres -" ];

  systemd.services.postgres-backup = {
    description = "Create local PostgreSQL dumps";
    serviceConfig = {
      Type = "oneshot";
      User = "postgres";
      Group = "postgres";
    };
    path = [ config.services.postgresql.package ];
    script = ''
      set -eu
      timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
      ${lib.concatMapStringsSep "\n" (db: ''
        pg_dump --format=custom --file=${directory}/${db}-$timestamp.dump ${db}
      '') postgresDatabases}
      find ${directory} -type f -name '*.dump' -mtime +${
        toString retentionDays
      } -delete
    '';
  };

  systemd.timers.postgres-backup = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "hourly";
      Persistent = true;
      RandomizedDelaySec = "10m";
    };
  };
}
```

## GitHub Actions runner (trusted jobs only)

nix-ld lets downloaded runner tooling execute; resource caps keep jobs from
starving the host's services.

```nix
{ pkgs, ... }:
let
  name = "my-repo-runner"; # runner and systemd unit name
  url = "https://github.com/org/repo"; # or org URL
  tokenFile = "/run/secrets/github-runner-token"; # SOPS-provided PAT/registration token
in {
  programs.nix-ld.enable = true;

  services.github-runners.${name} = {
    enable = true;
    inherit name url tokenFile;
    replace = true;
    extraLabels = [ ];
    extraPackages = with pkgs; [ curl jq openssh rsync unzip ];
    extraEnvironment = {
      NIX_LD = "/run/current-system/sw/share/nix-ld/lib/ld.so";
      NIX_LD_LIBRARY_PATH = "/run/current-system/sw/share/nix-ld/lib";
    };
    serviceOverrides = {
      CPUQuota = "600%";
      MemoryHigh = "8G";
      MemoryMax = "12G";
    };
  };
}
```

## App modules

Host-specific services (containers, jobs) live under the repo's own option
namespace (`<repo>.apps.*`) in `modules/apps/`, gated behind `enable`
options. They consume the profile: publish through Caddy virtual hosts, run
on Podman with digest-pinned images, peer-auth to their database as their
own system user, read secrets from SOPS paths.
