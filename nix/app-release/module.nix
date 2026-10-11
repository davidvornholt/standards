{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) mkOption types;

  cfg = config.services.appRelease;

  package = pkgs.callPackage ./package.nix {
    podman = config.virtualisation.podman.package;
    systemd = config.systemd.package;
    caFile = "/etc/ssl/certs/ca-certificates.crt";
  };

  stateRoot = "/var/lib/app-release";
  slots = [
    "blue"
    "green"
  ];

  isBlueGreen = app: app.strategy == "blue-green";
  hasPorts = app: app.containerPort != null || app.slotPorts != null;
  isPortless = app: isBlueGreen app && app.containerPort == null && app.slotPorts == null;

  slotContainerName = appName: slot: "${appName}-${slot}";

  # Names of the oci-containers entries an app owns, keyed by slot (or "current" for recreate).
  appContainers =
    appName: app:
    if isBlueGreen app then
      lib.genAttrs slots (slotContainerName appName)
    else
      {
        current = app.containerName;
      };

  containerUnit = containerName: "podman-${containerName}.service";

  forbiddenContainerAttrs =
    app:
    [
      "image"
      "autoStart"
      "serviceName"
    ]
    ++ lib.optional (isBlueGreen app) "ports";

  stripModuleArgs =
    value:
    if lib.isDerivation value then
      value
    else if builtins.isAttrs value then
      lib.mapAttrs (_: stripModuleArgs) (removeAttrs value [ "_module" ])
    else if builtins.isList value then
      map stripModuleArgs value
    else
      value;

  # sha256 of everything that defines how an app's container runs, minus the
  # fields that differ per slot. A change means the running container is stale.
  definitionHash =
    appName: app:
    let
      referenceContainer =
        if isBlueGreen app then slotContainerName appName "blue" else app.containerName;
      evaluated = config.virtualisation.oci-containers.containers.${referenceContainer};
      slotFields = [
        "image"
        "serviceName"
        "autoStart"
      ]
      ++ lib.optional (isBlueGreen app) "ports";
    in
    builtins.hashString "sha256" (
      builtins.toJSON {
        container = stripModuleArgs (removeAttrs evaluated slotFields);
        serviceConfig = stripModuleArgs app.serviceConfig;
        inherit (app) strategy containerPort;
        slotPorts = if app.slotPorts == null then null else { inherit (app.slotPorts) blue green; };
      }
    );

  unitJson =
    unitName: unit:
    pkgs.writeText "app-release-${unitName}.json" (
      builtins.toJSON {
        version = 1;
        unit = unitName;
        inherit (unit)
          repository
          ref
          registryAuthFile
          serviceDependencies
          migration
          drainSeconds
          refreshUnit
          ;
        oidc = {
          inherit (cfg.oidc) issuer jwksUrl audience;
        };
        apps = lib.mapAttrs (appName: app: {
          inherit (app)
            imageRepository
            strategy
            containerPort
            preStopCommand
            retireWithoutWaiting
            priority
            upstreamFile
            ;
          slotPorts = if app.slotPorts == null then null else { inherit (app.slotPorts) blue green; };
          health = {
            inherit (app.health)
              path
              port
              command
              timeoutSeconds
              ;
          };
          containers = appContainers appName app;
          units = lib.mapAttrs (_: containerUnit) (appContainers appName app);
          definitionHash = definitionHash appName app;
        }) unit.apps;
      }
    );

  appModule =
    unitName:
    { name, config, ... }:
    {
      options = {
        imageRepository = mkOption {
          type = types.str;
          example = "ghcr.io/davidvornholt/wordhold";
          description = "Registry repository the app's images are pulled from, without tag or digest.";
        };
        strategy = mkOption {
          type = types.enum [
            "blue-green"
            "recreate"
          ];
          default = "blue-green";
          description = ''
            `blue-green` runs the new version in the idle slot and switches traffic once it is healthy.
            `recreate` restarts one stable container and has downtime.
          '';
        };
        container = mkOption {
          type = types.attrs;
          default = { };
          description = ''
            Passed through to `virtualisation.oci-containers.containers.<name>`.
            The module sets `image`, `autoStart`, `serviceName` and, for blue-green apps, `ports` itself.
          '';
        };
        containerPort = mkOption {
          type = types.nullOr types.port;
          default = null;
          description = "Blue-green: the port the app listens on inside the container. Null for a port-less worker.";
        };
        slotPorts = mkOption {
          type = types.nullOr (
            types.submodule {
              options = {
                blue = mkOption {
                  type = types.port;
                  description = "Host loopback port of the blue slot.";
                };
                green = mkOption {
                  type = types.port;
                  description = "Host loopback port of the green slot.";
                };
              };
            }
          );
          default = null;
          description = "Blue-green: host loopback ports of the two slots. Null for a port-less worker.";
        };
        containerName = mkOption {
          type = types.str;
          default = name;
          description = "Recreate: the stable container name, so other containers can address it.";
        };
        health = {
          path = mkOption {
            type = types.nullOr types.str;
            default = "/";
            description = "HTTP probe path. Any 2xx or 3xx response counts as healthy.";
          };
          port = mkOption {
            type = types.nullOr types.port;
            default = null;
            description = "Recreate: host port of the HTTP probe. Blue-green apps probe their slot port.";
          };
          command = mkOption {
            type = types.nullOr types.str;
            default = null;
            description = ''
              Bash command that exits 0 when the app is healthy, used instead of the HTTP probe.
              It runs with `APP_RELEASE_UNIT`, `APP_RELEASE_APP`, `APP_RELEASE_SLOT` (empty for recreate),
              `APP_RELEASE_CONTAINER` (the container name) and `APP_RELEASE_PORT` (empty without a port) set.
            '';
          };
          timeoutSeconds = mkOption {
            type = types.ints.positive;
            default = 180;
            description = "How long to poll, once per second, before the app counts as unhealthy.";
          };
        };
        preStopCommand = mkOption {
          type = types.nullOr types.str;
          default = null;
          description = ''
            Recreate: bash command that runs before every restart of the container, for example to drain in-flight jobs.
            A non-zero exit aborts the operation before the container stops.
            It runs with the same environment as `health.command`.
          '';
        };
        retireWithoutWaiting = mkOption {
          type = types.bool;
          default = false;
          description = ''
            Port-less blue-green only: retire the old slot with `systemctl stop --no-block`,
            so a long drain does not hold the release. A release fails while the previous worker is still draining.
          '';
        };
        priority = mkOption {
          type = types.int;
          default = 100;
          description = "Recreate: restart order, lower first.";
        };
        serviceConfig = mkOption {
          type = types.attrs;
          default = { };
          description = "Merged into `systemd.services` of the generated container units (after, requires, partOf, serviceConfig and so on).";
        };
        upstreamFile = mkOption {
          type = types.nullOr types.str;
          readOnly = true;
          description = ''
            Blue-green with ports: the file holding the live slot address, `127.0.0.1:<port>`.
            A switch replaces it atomically. Null otherwise.
          '';
        };
        caddyUpstream = mkOption {
          type = types.nullOr types.str;
          readOnly = true;
          description = ''
            Blue-green with ports: the upstream for Caddy, `tcp/{file.<upstreamFile>}`, used as
            `reverse_proxy ''${app.caddyUpstream}` or `to ''${app.caddyUpstream}`. Caddy reads the
            file on every request, so a switch needs no Caddy reload. Null otherwise.
          '';
        };
      };

      config = {
        upstreamFile =
          if isBlueGreen config && hasPorts config then "${stateRoot}/${unitName}/${name}.upstream" else null;
        # `tcp/` keeps the Caddyfile adapter from appending a default port to the placeholder.
        caddyUpstream = if config.upstreamFile == null then null else "tcp/{file.${config.upstreamFile}}";
      };
    };

  unitModule =
    { name, ... }:
    {
      options = {
        repository = mkOption {
          type = types.str;
          example = "davidvornholt/wordhold";
          description = "The OIDC `repository` claim allowed to release this unit (case-sensitive).";
        };
        ref = mkOption {
          type = types.str;
          default = "refs/heads/main";
          description = "The OIDC `ref` claim allowed to release this unit.";
        };
        sshKeys = mkOption {
          type = types.listOf types.str;
          default = [ ];
          description = "Public SSH keys allowed to call this unit through the forced command.";
        };
        registryAuthFile = mkOption {
          type = types.nullOr types.str;
          default = null;
          description = "Passed to `podman pull --authfile`.";
        };
        serviceDependencies = mkOption {
          type = types.listOf types.str;
          default = [ ];
          description = "Units started before pulls and container starts, for example a registry login.";
        };
        migration = mkOption {
          type = types.nullOr (
            types.submodule {
              options = {
                service = mkOption {
                  type = types.str;
                  description = ''
                    Oneshot service, without `RemainAfterExit` and `wantedBy`, that runs migrations from
                    `localhost/app-release/<app>:candidate`. A failure fails the release before traffic moves.
                    The module sets its `restartIfChanged` to false, because only releases run it.
                  '';
                };
                app = mkOption {
                  type = types.str;
                  description = "The app whose candidate image the migration service uses.";
                };
              };
            }
          );
          default = null;
          description = "Migration run before a release starts new versions.";
        };
        drainSeconds = mkOption {
          type = types.ints.unsigned;
          default = 10;
          description = "Seconds to wait after switching traffic before stopping the old slots.";
        };
        apps = mkOption {
          type = types.attrsOf (types.submodule (appModule name));
          default = { };
          description = "Apps released together as one unit.";
        };
        refreshUnit = mkOption {
          type = types.str;
          readOnly = true;
          default = "app-release-${name}-refresh.service";
          defaultText = lib.literalExpression ''"app-release-<unit>-refresh.service"'';
          description = "Restart this unit (for example from sops `restartUnits`) to restart every app of the unit at its current digest.";
        };
      };
    };

  namePattern = "[a-z0-9][a-z0-9-]*";
  validName = name: builtins.match namePattern name != null;
  sshKeyPattern = "(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\\.com|sk-ecdsa-sha2-nistp256@openssh\\.com) [A-Za-z0-9+/]+=*( [^\"\n\r]*)?";

  allApps = lib.concatLists (
    lib.mapAttrsToList (
      unitName: unit:
      lib.mapAttrsToList (appName: app: {
        inherit
          unitName
          unit
          appName
          app
          ;
      }) unit.apps
    ) cfg.units
  );

  ownershipAssertion =
    resource: uses:
    let
      collisions = lib.filterAttrs (_: owners: builtins.length owners > 1) (
        lib.groupBy (use: use.name) uses
      );
    in
    {
      assertion = collisions == { };
      message = "services.appRelease: ${resource} collide: ${
        lib.concatStringsSep "; " (
          lib.mapAttrsToList (
            name: owners: "${name} used by ${lib.concatMapStringsSep ", " (use: use.owner) owners}"
          ) collisions
        )
      }.";
    };

  ownershipAssertions = [
    (ownershipAssertion "app names/local image tags" (
      map (entry: {
        name = entry.appName;
        owner = "${entry.unitName}/${entry.appName}";
      }) allApps
    ))
    (ownershipAssertion "container names" (
      lib.concatMap (
        entry:
        lib.mapAttrsToList (slot: name: {
          inherit name;
          owner = "${entry.unitName}/${entry.appName}/${slot}";
        }) (appContainers entry.appName entry.app)
      ) allApps
    ))
    (ownershipAssertion "release service names" (
      lib.concatLists (
        lib.mapAttrsToList (unitName: _: [
          {
            name = "app-release-${unitName}";
            owner = "${unitName}/reconcile";
          }
          {
            name = "app-release-${unitName}-refresh";
            owner = "${unitName}/refresh";
          }
        ]) cfg.units
      )
    ))
  ];

  slotPortUses = lib.concatMap (
    entry:
    lib.optionals (entry.app.slotPorts != null) (
      map (slot: {
        port = entry.app.slotPorts.${slot};
        owner = "${entry.unitName}/${entry.appName}/${slot}";
      }) slots
    )
  ) allApps;

  portCollisions = lib.filterAttrs (_: owners: builtins.length owners > 1) (
    lib.foldl' (
      acc: use:
      acc
      // {
        ${toString use.port} = (acc.${toString use.port} or [ ]) ++ [ use.owner ];
      }
    ) { } slotPortUses
  );

  isTruthy =
    value:
    builtins.elem value [
      true
      1
      "1"
      "yes"
      "true"
      "on"
    ];

  appAssertions =
    {
      unitName,
      appName,
      app,
      ...
    }:
    let
      where = "services.appRelease.units.${unitName}.apps.${appName}";
      containerNames = builtins.attrValues (appContainers appName app);
      evaluatedContainers = map (
        containerName: config.virtualisation.oci-containers.containers.${containerName}
      ) containerNames;
    in
    [
      {
        assertion = validName appName;
        message = "${where}: app names must match ^${namePattern}$.";
      }
      {
        assertion =
          !isBlueGreen app
          || (app.containerPort != null && app.slotPorts != null)
          || (isPortless app && app.health.command != null);
        message = "${where}: blue-green apps need both containerPort and slotPorts, or neither plus health.command for a port-less worker.";
      }
      {
        assertion = !app.retireWithoutWaiting || isPortless app;
        message = "${where}: retireWithoutWaiting is only allowed on port-less blue-green apps.";
      }
      {
        assertion = isBlueGreen app || app.slotPorts == null;
        message = "${where}: recreate apps cannot set slotPorts.";
      }
      {
        assertion = isBlueGreen app || app.containerPort == null;
        message = "${where}: recreate apps cannot set containerPort; publish ports through container.ports.";
      }
      {
        assertion = isBlueGreen app || app.health.port != null || app.health.command != null;
        message = "${where}: recreate apps need health.port or health.command.";
      }
      {
        assertion = app.health.command != null || app.health.path != null;
        message = "${where}: health.path is required when health.command is null.";
      }
      {
        assertion = isBlueGreen app || validName app.containerName;
        message = "${where}: containerName must match ^${namePattern}$.";
      }
      {
        assertion = !(isBlueGreen app) || app.preStopCommand == null;
        message = "${where}: preStopCommand is only supported for recreate apps.";
      }
      {
        assertion = builtins.all (attr: !(app.container ? ${attr})) (forbiddenContainerAttrs app);
        message = "${where}: container must not set ${lib.concatStringsSep ", " (forbiddenContainerAttrs app)}; the module sets them.";
      }
      {
        assertion = builtins.all (c: c.podman == null || c.podman.user == "root") evaluatedContainers;
        message = "${where}: app-release tags images in root's podman storage, so container.podman.user must stay root.";
      }
    ];

  unitAssertions =
    unitName: unit:
    let
      where = "services.appRelease.units.${unitName}";
      migrationService =
        if unit.migration == null then null else lib.removeSuffix ".service" unit.migration.service;
      # The module sets restartIfChanged on the migration service, so the service always
      # exists; one that runs nothing was never defined by the host.
      migrationDefinition =
        if migrationService == null then null else config.systemd.services.${migrationService};
      migrationDefined = migrationDefinition != null && migrationDefinition.serviceConfig ? ExecStart;
      generatedContainerUnits = lib.concatLists (
        lib.mapAttrsToList (
          appName: app:
          map (containerName: config.systemd.services."podman-${containerName}") (
            builtins.attrValues (appContainers appName app)
          )
        ) unit.apps
      );
    in
    [
      {
        assertion = validName unitName;
        message = "${where}: unit names must match ^${namePattern}$.";
      }
      {
        assertion = unit.migration == null || unit.apps ? ${unit.migration.app};
        message = "${where}: migration.app must name an app of this unit.";
      }
      {
        assertion = unit.migration == null || migrationDefined;
        message = "${where}: migration.service must be defined in systemd.services.";
      }
      {
        assertion =
          !migrationDefined
          || (
            (migrationDefinition.serviceConfig.Type or "simple") == "oneshot"
            && !(isTruthy (migrationDefinition.serviceConfig.RemainAfterExit or false))
          );
        message = "${where}: migration.service must be Type=oneshot without RemainAfterExit, so every release runs it.";
      }
      {
        assertion = !migrationDefined || migrationDefinition.wantedBy == [ ];
        message = "${where}: migration.service must not be wanted by any target; app-release starts it.";
      }
      {
        assertion =
          migrationService == null
          || builtins.all (
            service:
            !(builtins.elem "${migrationService}.service" (
              service.requires ++ service.wants ++ service.bindsTo
            ))
          ) generatedContainerUnits;
        message = "${where}: app containers must not require migration.service.";
      }
      {
        assertion = builtins.all (key: builtins.match sshKeyPattern key != null) unit.sshKeys;
        message = "${where}: every sshKeys entry must be one public key line without options or quotes.";
      }
      {
        assertion = unit.apps != { };
        message = "${where}: a unit needs at least one app.";
      }
    ];

  blueGreenContainers = lib.concatMap (
    { appName, app, ... }:
    lib.optionals (isBlueGreen app) (
      map (slot: {
        name = slotContainerName appName slot;
        value = lib.mkMerge [
          app.container
          {
            image = "localhost/app-release/${appName}:${slot}";
            autoStart = false;
            pull = lib.mkDefault "never";
            ports = lib.optional (
              app.slotPorts != null
            ) "127.0.0.1:${toString app.slotPorts.${slot}}:${toString app.containerPort}";
          }
        ];
      }) slots
    )
  ) allApps;

  recreateContainers = lib.concatMap (
    { appName, app, ... }:
    lib.optional (!isBlueGreen app) {
      name = app.containerName;
      value = lib.mkMerge [
        app.container
        {
          image = "localhost/app-release/${appName}:current";
          autoStart = false;
          pull = lib.mkDefault "never";
        }
      ];
    }
  ) allApps;

  containerServices = lib.concatMap (
    {
      unitName,
      appName,
      app,
      ...
    }:
    lib.mapAttrsToList (slot: containerName: {
      name = "podman-${containerName}";
      value = lib.mkMerge [
        {
          restartIfChanged = false;
          serviceConfig = {
            # A unit that starts the container before the reconcile does, for example on
            # the host's first activation, would otherwise find no image tag and fail.
            ExecStartPre = [
              "${package}/bin/app-release prepare ${unitName} ${appName}${
                lib.optionalString (isBlueGreen app) " ${slot}"
              }"
            ];
            # Stopping a container sends SIGTERM, after which runtimes such as Bun exit
            # with 143. Every retired slot would otherwise stay failed.
            SuccessExitStatus = [ "143" ];
          };
        }
        app.serviceConfig
      ];
    }) (appContainers appName app)
  ) allApps;

  # Releases run the migration service, so a host switch never should. Starting it during
  # a switch fails without a candidate image, and switch-to-configuration would roll back.
  migrationServices = lib.concatLists (
    lib.mapAttrsToList (
      _: unit:
      lib.optional (unit.migration != null) {
        name = lib.removeSuffix ".service" unit.migration.service;
        value.restartIfChanged = false;
      }
    ) cfg.units
  );

  unitServices = lib.concatLists (
    lib.mapAttrsToList (
      unitName: unit:
      let
        json = unitJson unitName unit;
      in
      [
        {
          name = "app-release-${unitName}";
          value = {
            description = "Reconcile app release unit ${unitName}";
            wantedBy = [ "multi-user.target" ];
            wants = [ "network-online.target" ] ++ unit.serviceDependencies;
            after = [ "network-online.target" ] ++ unit.serviceDependencies;
            restartTriggers = [ json ];
            serviceConfig = {
              Type = "oneshot";
              RemainAfterExit = true;
              ExecStart = "${package}/bin/app-release reconcile ${unitName}";
            };
          };
        }
        {
          name = "app-release-${unitName}-refresh";
          value = {
            description = "Restart every app of release unit ${unitName} at its current digest";
            after = [ "app-release-${unitName}.service" ];
            restartIfChanged = false;
            serviceConfig = {
              Type = "oneshot";
              ExecStart = "${package}/bin/app-release refresh ${unitName}";
            };
          };
        }
      ]
    ) cfg.units
  );

  tmpfileRules = lib.foldl' lib.recursiveUpdate { } (
    [
      {
        ${stateRoot}.d = {
          mode = "0755";
          user = "root";
          group = "root";
        };
        "/var/cache/app-release".d = {
          mode = "0700";
          user = "root";
          group = "root";
        };
        "/run/app-release".d = {
          mode = "0700";
          user = "root";
          group = "root";
        };
      }
    ]
    ++ lib.mapAttrsToList (unitName: _: {
      "${stateRoot}/${unitName}".d = {
        mode = "0755";
        user = "root";
        group = "root";
      };
    }) cfg.units
    ++ map (
      { app, ... }:
      {
        ${app.upstreamFile}.f = {
          mode = "0644";
          user = "root";
          group = "root";
          argument = "127.0.0.1:${toString app.slotPorts.blue}";
        };
      }
    ) (builtins.filter ({ app, ... }: app.upstreamFile != null) allApps)
  );
in
{
  options.services.appRelease = {
    enable = lib.mkEnableOption "app releases";
    oidc = {
      issuer = mkOption {
        type = types.str;
        default = "https://token.actions.githubusercontent.com";
        description = "Required `iss` claim of release tokens.";
      };
      jwksUrl = mkOption {
        type = types.str;
        default = "https://token.actions.githubusercontent.com/.well-known/jwks";
        description = "JWKS used to verify release tokens.";
      };
      audience = mkOption {
        type = types.str;
        default = "app-release";
        description = "Required `aud` claim of release tokens.";
      };
    };
    units = mkOption {
      type = types.attrsOf (types.submodule unitModule);
      default = { };
      description = "Release units. Each unit is released by one repository through one SSH forced command.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = portCollisions == { };
        message = "services.appRelease: slot ports collide: ${
          lib.concatStringsSep "; " (
            lib.mapAttrsToList (
              port: owners: "${port} used by ${lib.concatStringsSep ", " owners}"
            ) portCollisions
          )
        }.";
      }
      {
        assertion = config.virtualisation.oci-containers.backend == "podman";
        message = "services.appRelease requires virtualisation.oci-containers.backend = \"podman\".";
      }
    ]
    ++ ownershipAssertions
    ++ lib.concatMap appAssertions allApps
    ++ lib.concatLists (lib.mapAttrsToList unitAssertions cfg.units);

    environment.systemPackages = [ package ];

    environment.etc = lib.mapAttrs' (
      unitName: unit:
      lib.nameValuePair "app-release/${unitName}.json" {
        source = unitJson unitName unit;
      }
    ) cfg.units;

    virtualisation.oci-containers.containers = builtins.listToAttrs (
      blueGreenContainers ++ recreateContainers
    );

    systemd.services = lib.mkMerge [
      (builtins.listToAttrs (containerServices ++ unitServices))
      (builtins.listToAttrs migrationServices)
    ];

    systemd.tmpfiles.settings."10-app-release" = tmpfileRules;

    # Slot switches never reload Caddy, but configuration changes still do. Each reload
    # binds a new SO_REUSEPORT listener and closes the old one; without this setting the
    # kernel resets the connections still queued on the closed listener. Linux 5.14+.
    boot.kernel.sysctl."net.ipv4.tcp_migrate_req" = 1;

    users.users.root.openssh.authorizedKeys.keys = lib.mkAfter (
      lib.concatLists (
        lib.mapAttrsToList (
          unitName: unit:
          map (key: ''command="${package}/bin/app-release-ssh ${unitName}",restrict ${key}'') unit.sshKeys
        ) cfg.units
      )
    );
  };
}
