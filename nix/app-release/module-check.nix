{ lib, nixpkgsPath }:
let
  worker = {
    imageRepository = "ghcr.io/owner/worker";
    health.command = "true";
  };
  recreate = worker // {
    strategy = "recreate";
  };
  unit = apps: {
    repository = "owner/shop";
    inherit apps;
  };
  cases = [
    {
      name = "distinct owners";
      units = {
        shop = unit { web = worker; };
        second = unit { jobs = recreate; };
      };
      errors = [ ];
    }
    {
      name = "duplicate app and local tag ownership";
      units = {
        shop = unit { web = worker; };
        second = unit { web = worker; };
      };
      errors = [
        "app names/local image tags collide: web used by second/web, shop/web"
        "container names collide: web-blue used by second/web/blue, shop/web/blue; web-green used by second/web/green, shop/web/green"
      ];
    }
    {
      name = "recreate alias overlaps a blue-green slot";
      units.shop = unit {
        web = worker;
        jobs = recreate // {
          containerName = "web-blue";
        };
      };
      errors = [
        "container names collide: web-blue used by shop/jobs/current, shop/web/blue"
      ];
    }
    {
      name = "duplicate recreate aliases";
      units = {
        shop = unit {
          jobs = recreate // {
            containerName = "shared";
          };
        };
        second = unit {
          tasks = recreate // {
            containerName = "shared";
          };
        };
      };
      errors = [
        "container names collide: shared used by second/tasks/current, shop/jobs/current"
      ];
    }
    {
      name = "reconcile service overlaps a refresh service";
      units = {
        shop = unit { web = worker; };
        shop-refresh = unit { jobs = recreate; };
      };
      errors = [
        "release service names collide: app-release-shop-refresh used by shop/refresh, shop-refresh/reconcile"
      ];
    }
  ];
  evaluate =
    units: services:
    import "${nixpkgsPath}/nixos/lib/eval-config.nix" {
      system = "x86_64-linux";
      modules = [
        ./module.nix
        {
          system.stateVersion = "26.05";
          boot.loader.grub.enable = false;
          fileSystems."/" = {
            device = "none";
            fsType = "tmpfs";
          };
          virtualisation.podman.enable = true;
          services.appRelease = {
            enable = true;
            inherit units;
          };
          systemd.services = services;
        }
      ];
    };
  check =
    case:
    let
      evaluated = evaluate case.units { };
      errors = failedAssertions evaluated;
      expected = map (message: "services.appRelease: ${message}.") case.errors;
    in
    lib.assertMsg (errors == expected) (
      "app-release module assertions (${case.name}): expected ${builtins.toJSON expected}, got ${builtins.toJSON errors}"
    );
  migratingUnits = {
    shop = unit {
      web = worker;
      jobs = recreate;
    }
    // {
      migration = {
        service = "shop-migrate.service";
        app = "web";
      };
    };
  };
  failedAssertions =
    evaluated: map (assertion: assertion.message) (
      builtins.filter (assertion: !assertion.assertion) evaluated.config.assertions
    );
  # The module sets restartIfChanged on the migration service, which must not hide that
  # the host never defined it.
  undefinedMigration =
    let
      errors = failedAssertions (evaluate migratingUnits { });
      expected = [
        "services.appRelease.units.shop: migration.service must be defined in systemd.services."
      ];
    in
    lib.assertMsg (errors == expected) (
      "app-release module assertions (undefined migration service): expected ${builtins.toJSON expected}, got ${builtins.toJSON errors}"
    );
  # Generated units: every container prepares its own image tag before it starts, and host
  # switches leave the migration service to releases.
  generated =
    let
      services =
        (evaluate migratingUnits {
          shop-migrate = {
            script = "true";
            serviceConfig.Type = "oneshot";
          };
        }).config.systemd.services;
      prepares =
        service: command:
        builtins.any (lib.hasSuffix "/bin/app-release prepare ${command}") (
          lib.toList services.${service}.serviceConfig.ExecStartPre
        );
    in
    lib.assertMsg (
      prepares "podman-web-blue" "shop web blue"
      && prepares "podman-web-green" "shop web green"
      && prepares "podman-jobs" "shop jobs"
      && !services.shop-migrate.restartIfChanged
    ) "app-release module: generated container or migration units are missing their activation settings";
in
builtins.all check cases && undefinedMigration && generated
