let
  pkgs = import <nixpkgs> {};
  python = pkgs.python3.withPackages (ps: [ ps.sphinx ps.furo ]);
in
pkgs.mkShell {
  packages = [ python ];
}
