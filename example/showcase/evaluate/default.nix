{ pkgs ? import <nixpkgs> {} }:
pkgs.writeShellScriptBin "evaluate" (builtins.readFile ./evaluate.sh)
