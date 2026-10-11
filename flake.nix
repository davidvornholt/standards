{
  description = "Nix packages for the davidvornholt standards CLI, poller and app-release host module";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      bunSystemMetadata = builtins.fromJSON (builtins.readFile ./nix/bun-system-metadata.json);
      manifest = builtins.fromJSON (builtins.readFile ./package.json);
      systems = builtins.attrNames bunSystemMetadata;
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          standardsCli = pkgs.callPackage ./nix/standards-cli.nix {
            inherit bunSystemMetadata;
            src = self;
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
            inherit bunSystemMetadata standardsCli;
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

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          bun = pkgs.callPackage ./nix/standards-bun.nix {
            inherit (manifest) packageManager;
          };
        in
        {
          default = pkgs.mkShell {
            packages = [ bun ];
          };
        }
      );
    };
}
