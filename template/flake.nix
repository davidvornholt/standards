{
  description = "Development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      manifest = builtins.fromJSON (builtins.readFile ./package.json);
      bunVersion =
        assert builtins.match "bun@[0-9]+\\.[0-9]+\\.[0-9]+" manifest.packageManager != null;
        nixpkgs.lib.removePrefix "bun@" manifest.packageManager;
      bunSources = {
        x86_64-linux = {
          asset = "bun-linux-x64-baseline.zip";
          hash = "sha256-GE+0WV8NQBohfPfHjBvEMLqDMU2reouUgFurv3+nCX8=";
        };
        aarch64-linux = {
          asset = "bun-linux-aarch64.zip";
          hash = "sha256-SxozLuhhmD65O8/m93D/+U4+MbLDiL2uo8jtNeWO7Q4=";
        };
      };
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          bunSource = bunSources.${system};
          bun = pkgs.bun.overrideAttrs (_final: _previous: {
            version = bunVersion;
            src = pkgs.fetchurl {
              url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/${bunSource.asset}";
              inherit (bunSource) hash;
            };
          });
        in
        {
          default = pkgs.mkShell {
            packages = [ bun ];
          };
        }
      );
    };
}
