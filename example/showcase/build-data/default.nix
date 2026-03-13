{ pkgs ? import <nixpkgs> {} }:
pkgs.writeShellScriptBin "build-data" (builtins.readFile ./build-data.sh)
