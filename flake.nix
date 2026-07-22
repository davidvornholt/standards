{
  description = "Nix package for the davidvornholt standards CLI and poller";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          standardsCli = pkgs.callPackage ./nix/standards-cli.nix { src = self; };
        in
        {
          standards-cli = standardsCli;
          default = standardsCli;
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          standardsCli = self.packages.${system}.standards-cli;
        in
        {
          standards-cli = pkgs.callPackage ./nix/standards-cli-check.nix {
            inherit standardsCli;
          };
        }
      );
    };
}
