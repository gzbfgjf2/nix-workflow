{ pkgs }:
let
  visual = pkgs.buildNpmPackage {
    pname = "nix-workflow-visual";
    version = "0.0.1";
    src = ./.;
    npmDepsHash = "sha256-eHwKRqaG7/CpQ+fV0VFck+e3d94QXm0ke1SljHJXGYQ=";
    buildPhase = ''
      npm run build
    '';
    installPhase = ''
      mkdir -p $out/lib/nix-workflow-visual
      cp -r dist $out/lib/nix-workflow-visual/dist
      cp -r server $out/lib/nix-workflow-visual/server
    '';
  };

  nw-visual = pkgs.writeShellScriptBin "nw-visual" ''
    if [ -z "$DAG_DIR" ]; then
      echo "DAG_DIR is required. Usage: DAG_DIR=./nix-workflow-output nw-visual"
      exit 1
    fi
    exec ${pkgs.nodejs}/bin/node ${visual}/lib/nix-workflow-visual/server/standalone.mjs
  '';
in
{
  package = visual;
  bin = nw-visual;
  shell = pkgs.mkShell {
    packages = [ nw-visual ];
  };
}
