{
  pkgs,
  pyproject-nix,
  uv2nix,
  pyproject-build-systems,
}:
let
  inherit (pkgs) lib;
  python = pkgs.python312;
  hacks = pkgs.callPackage pyproject-nix.build.hacks { };


  src = lib.fileset.toSource rec {
    root = ./.;
    fileset = lib.fileset.unions [
      (root + "/pyproject.toml")
      (root + "/uv.lock")
      (root + "/src")
      (root + "/README.md")
      (root + "/default.nix")
    ];
  };
  workspace = uv2nix.lib.workspace.loadWorkspace { workspaceRoot = src; };

  overlay = workspace.mkPyprojectOverlay {
    sourcePreference = "wheel";
  };

  pythonSet =
    (pkgs.callPackage pyproject-nix.build.packages { inherit python; })
    .overrideScope
      (
        lib.composeManyExtensions [
          pyproject-build-systems.wheel
          overlay
        ]
      );
  env = pythonSet.mkVirtualEnv "nix-workflow-env" (
    workspace.deps.default
  );
  testEnv = pythonSet.mkVirtualEnv "nix-workflow-test-env" (
    workspace.deps.all
  );

in
{
  inherit env testEnv;
  shell = pkgs.mkShell {
    packages = [
      testEnv
      pkgs.uv
      pkgs.fish
    ];

    env = {
      UV_NO_SYNC = "1";
      UV_PYTHON = pythonSet.python.interpreter;
      UV_PYTHON_DOWNLOADS = "never";
    };

    shellHook = ''
      # unset PYTHONPATH
      # export REPO_ROOT=$(git rev-parse --show-toplevel)
      # exec fish
    '';
  };
}
