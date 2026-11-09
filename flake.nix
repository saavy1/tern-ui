{
  description = "tern-ui: native Tern UI for coding agents (a Tern plugin and an MCP server)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.luau-lsp
          ];
        };
      });

      packages = forAll (pkgs: rec {
        # The MCP server, compiled to one executable (it has no runtime dependencies).
        tern-ui-mcp = pkgs.stdenvNoCC.mkDerivation {
          pname = "tern-ui-mcp";
          version = "0.1.0";
          src = ./server;
          nativeBuildInputs = [ pkgs.bun ];
          dontStrip = true;
          buildPhase = ''
            runHook preBuild
            export HOME=$TMPDIR
            bun build src/main.ts --compile --outfile tern-ui-mcp
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            install -Dm755 tern-ui-mcp $out/bin/tern-ui-mcp
            runHook postInstall
          '';
          meta.mainProgram = "tern-ui-mcp";
        };
        # The Tern plugin, for `tern plugin link` when installing from the store.
        tern-ui-plugin = pkgs.runCommand "tern-ui-plugin" { } "cp -r ${./plugin} $out";
        default = tern-ui-mcp;
      });
    };
}
