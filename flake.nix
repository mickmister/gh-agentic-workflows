{
  description = "Repairable project environments for agentic workflow development";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/b6018f87da91d19d0ab4cf979885689b469cdd41";

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      # A project-specific, input-addressed output absent from public caches.
      # The proof agent adds this to web after observing that it is missing.
      probe = pkgs.writeShellScriptBin "agentic-nix-probe" ''
        echo agentic-nix-proof-v1
      '';
    in {
      packages.${system}.probe = probe;
      devShells.${system} = rec {
        web = pkgs.mkShell {
          packages = [ pkgs.nodejs_22 ];
        };
        default = web;
      };
    };
}
