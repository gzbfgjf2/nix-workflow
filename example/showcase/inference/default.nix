{ pkgs ? import <nixpkgs> {} }:
pkgs.writeShellScriptBin "inference" (builtins.readFile ./inference.sh)
