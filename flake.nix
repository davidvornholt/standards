{
  description = "Nix packages for the davidvornholt standards CLI and app-release host module";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      manifest = builtins.fromJSON (builtins.readFile ./package.json);
      bunArchives = builtins.fromJSON (builtins.readFile ./nix/bun-archives.json);
      # The flake supports exactly the systems with a pinned archive of the
      # root packageManager's Bun.
      systems = builtins.attrNames bunArchives.${nixpkgs.lib.removePrefix "bun@" manifest.packageManager};
      forAllSystems = nixpkgs.lib.genAttrs systems;
      standardsBun =
        system:
        nixpkgs.legacyPackages.${system}.callPackage ./nix/standards-bun.nix {
          inherit (manifest) packageManager;
        };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          standardsCli = pkgs.callPackage ./nix/standards-cli.nix {
            src = self;
            standardsBun = standardsBun system;
          };
        in
        {
          standards-cli = standardsCli;
          default = standardsCli;
          app-release = pkgs.callPackage ./nix/app-release/package.nix { };
        }
      );

      nixosModules.app-release = ./nix/app-release/module.nix;

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          standardsCli = self.packages.${system}.standards-cli;
        in
        {
          standards-cli = pkgs.callPackage ./nix/standards-cli-check.nix {
            inherit standardsCli systems;
          };
          app-release = pkgs.callPackage ./nix/app-release/check.nix {
            appRelease = self.packages.${system}.app-release;
          };
        }
        # The VM test needs KVM, which CI only provides on x86_64-linux runners.
        // nixpkgs.lib.optionalAttrs (system == "x86_64-linux") {
          app-release-vm = pkgs.testers.runNixOSTest (import ./nix/app-release/vm-test.nix { inherit pkgs; });
        }
      );

      devShells = forAllSystems (system: {
        default = nixpkgs.legacyPackages.${system}.mkShell {
          packages = [ (standardsBun system) ];
        };
      });
    };
}
