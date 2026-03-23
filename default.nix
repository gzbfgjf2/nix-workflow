let
  sources = import ./npins;
  inherit (pkgs) lib;

  pkgs = import sources."nixos-25.11" {
    config = {
      config.allowUnfree = true;
      config.cudaSupport = true;
    };
  };
  pyproject-nix = import sources."pyproject.nix" { inherit lib; };
  uv2nix = import sources.uv2nix { inherit pyproject-nix lib; };
  pyproject-build-systems = import sources.build-system-pkgs {
    inherit
      pyproject-nix
      uv2nix
      lib
      ;
  };
  cli = import ./cli {
    inherit
      pkgs
      pyproject-nix
      uv2nix
      pyproject-build-systems
      ;
  };
  nwlib = import ./lib { inherit pkgs; };
  visual = import ./visual { inherit pkgs; };
in
{
  lib = nwlib;
  env = cli.env;
  testEnv = cli.testEnv;
  shell = pkgs.mkShell {
    inputsFrom = [ cli.shell ];
    packages = [ visual.bin ];
    shellHook = ''
      git config core.hooksPath .githooks
    '';
  };
  visual-shell = visual.shell;
}
