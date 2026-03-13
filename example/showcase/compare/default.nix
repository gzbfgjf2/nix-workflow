{ pkgs ? import <nixpkgs> {} }:
pkgs.writeShellScriptBin "compare" (builtins.readFile ./compare.sh)
