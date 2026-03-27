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
    packages = [ 
      visual.bin 
      pkgs.fish
 ];
    shellHook = ''
      git config core.hooksPath .githooks
      exec fish
    '';
    env = {
      # LD_LIBRARY_PATH = "/run/opengl-driver/lib";
      LD_LIBRARY_PATH="/run/opengl-driver/lib:/run/current-system/sw/share/nix-ld/lib";
    };
  };
  visual-shell = visual.shell;
}
