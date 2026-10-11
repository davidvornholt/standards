# NixOS VM test of the app-release module and CLI on one host: a local
# registry, Caddy, sshd with the forced command, and one unit with a
# blue-green web app, a port-less blue-green worker and a recreate app.
{ pkgs }:
let
  inherit (pkgs) lib;

  sshKeys = import "${pkgs.path}/nixos/tests/ssh-keys.nix" pkgs;
  registry = "localhost:5000";
  apps = [
    "web"
    "worker"
    "jobs"
  ];

  # One image per release candidate, pushed to every app repository. `v2b`
  # has the content of `v2` under another revision label, so it gets a new
  # digest without changing what runs. The broken images serve no /health.
  images = {
    v1 = {
      version = "v1";
      revision = lib.strings.replicate 40 "1";
      healthy = true;
    };
    v2 = {
      version = "v2";
      revision = lib.strings.replicate 40 "2";
      healthy = true;
    };
    v2b = {
      version = "v2";
      revision = lib.strings.replicate 40 "b";
      healthy = true;
    };
    broken = {
      version = "broken";
      revision = lib.strings.replicate 40 "e";
      healthy = false;
    };
    v3 = {
      version = "v3";
      revision = lib.strings.replicate 40 "3";
      healthy = true;
    };
    v3broken = {
      version = "v3-broken";
      revision = lib.strings.replicate 40 "3";
      healthy = false;
    };
  };

  site =
    image:
    pkgs.runCommand "app-release-test-site-${image.version}" { } ''
      mkdir -p "$out/www"
      echo ${image.version} > "$out/www/index.html"
      ${lib.optionalString image.healthy ''echo ok > "$out/www/health"''}
    '';

  imageArchive =
    tag: image:
    pkgs.dockerTools.buildLayeredImage {
      name = "app-release-test";
      inherit tag;
      contents = [
        pkgs.busybox
        (site image)
      ];
      config = {
        Cmd = [
          "/bin/sh"
          "-c"
          "trap 'exit 0' TERM; httpd -f -p 3000 -h /www & wait"
        ];
        Labels."org.opencontainers.image.revision" = image.revision;
      };
    };

  seedRegistry = pkgs.writeShellApplication {
    name = "seed-registry";
    runtimeInputs = [
      pkgs.curl
      pkgs.skopeo
    ];
    text = ''
      until curl -fsS http://${registry}/v2/ >/dev/null; do sleep 0.5; done
      ${lib.concatMapStrings (
        app:
        lib.concatStrings (
          lib.mapAttrsToList (tag: image: ''
            skopeo copy --quiet --dest-tls-verify=false \
              docker-archive:${imageArchive tag image} docker://${registry}/owner/${app}:${tag}
          '') images
        )
        + ''
          skopeo copy --quiet --src-tls-verify=false --dest-tls-verify=false \
            docker://${registry}/owner/${app}:v1 docker://${registry}/owner/${app}:production
        ''
      ) apps}
    '';
  };

  mintToken = pkgs.writers.writePython3Bin "mint-token" {
    libraries = [
      pkgs.python3Packages.cryptography
      pkgs.python3Packages.pyjwt
    ];
    # checks.app-release runs ruff and mypy --strict on this file.
    doCheck = false;
  } (builtins.readFile ./tests/mint_token.py);

  loadGenerator = pkgs.writeShellApplication {
    name = "load-generator";
    runtimeInputs = [ pkgs.curl ];
    text = ''
      while [ ! -e /run/load/stop ]; do
        if body=$(curl -fsS -m 5 http://localhost/ 2>>/run/load/errors); then
          echo "$body" >>/run/load/served
        else
          echo failed >>/run/load/failed
        fi
      done
    '';
  };

  testHeader = ''
    REVISIONS = ${builtins.toJSON (lib.mapAttrs (_: image: image.revision) images)}
  '';
in
{
  name = "app-release";

  nodes.machine =
    { config, ... }:
    {
      imports = [ ./module.nix ];

      virtualisation = {
        memorySize = 2048;
        diskSize = 4096;
        podman.enable = true;
        oci-containers.backend = "podman";
        containers.registries.insecure = [ registry ];
      };

      environment.systemPackages = [
        loadGenerator
        mintToken
        pkgs.skopeo
      ];
      environment.etc."app-release-test/ssh-key" = {
        source = sshKeys.snakeOilEd25519PrivateKey;
        mode = "0600";
      };

      services.openssh.enable = true;
      services.dockerRegistry = {
        enable = true;
        # Keep the test log readable: no access log lines or trace export errors.
        extraConfig.log = {
          level = "warn";
          accesslog.disabled = true;
        };
      };
      systemd.services.docker-registry.environment.OTEL_TRACES_EXPORTER = "none";

      services.caddy = {
        enable = true;
        globalConfig = "grace_period 5s";
        virtualHosts."http://localhost".extraConfig = ''
          reverse_proxy {
            ${config.services.appRelease.units.shop.apps.web.caddyUpstreamImport}
          }
        '';
      };

      systemd.services.seed-registry = {
        description = "Push the test images into the local registry";
        requires = [ "docker-registry.service" ];
        after = [ "docker-registry.service" ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          ExecStart = lib.getExe seedRegistry;
        };
      };

      systemd.services.shop-migrate = {
        description = "Run the shop migrations from the candidate image";
        path = [ config.virtualisation.podman.package ];
        serviceConfig.Type = "oneshot";
        script = ''
          if [ -e /run/fail-migration ]; then
            echo "migration failed on purpose" >&2
            exit 1
          fi
          podman run --rm --network=none localhost/app-release/web:candidate \
            cat /www/index.html >>/var/lib/migrations.log
        '';
      };

      services.appRelease = {
        enable = true;
        oidc.jwksUrl = "file:///var/lib/test-oidc/jwks.json";
        units.shop = {
          repository = "owner/shop";
          sshKeys = [ sshKeys.snakeOilEd25519PublicKey ];
          serviceDependencies = [ "seed-registry.service" ];
          migration = {
            service = "shop-migrate.service";
            app = "web";
          };
          drainSeconds = 2;
          apps = {
            web = {
              imageRepository = "${registry}/owner/web";
              containerPort = 3000;
              slotPorts = {
                blue = 8001;
                green = 8002;
              };
              health = {
                path = "/health";
                timeoutSeconds = 15;
              };
            };
            worker = {
              imageRepository = "${registry}/owner/worker";
              retireWithoutWaiting = true;
              # A worker that needs 30 s to finish its jobs after SIGTERM.
              container = {
                cmd = [
                  "/bin/sh"
                  "-c"
                  "trap 'sleep 30; exit 0' TERM; while :; do sleep 1 & wait $!; done"
                ];
                extraOptions = [ "--stop-timeout=60" ];
              };
              health = {
                command = ''podman exec "$APP_RELEASE_CONTAINER" test -e /www/index.html'';
                timeoutSeconds = 15;
              };
            };
            jobs = {
              imageRepository = "${registry}/owner/jobs";
              strategy = "recreate";
              priority = 10;
              container.ports = [ "127.0.0.1:9000:3000" ];
              health = {
                port = 9000;
                path = "/health";
                timeoutSeconds = 15;
              };
              preStopCommand = ''echo "pre-stop $APP_RELEASE_APP $APP_RELEASE_CONTAINER" >>/run/pre-stop.log'';
            };
          };
        };
      };

      # Switching to this specialisation changes the web container definition.
      specialisation.changed.configuration = {
        services.appRelease.units.shop.apps.web.container.environment.TEST_CHANGED = "1";
      };
    };

  testScript = testHeader + builtins.readFile ./vm-test.py;
}
