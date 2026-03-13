{ pkgs ? import <nixpkgs> {} }:
pkgs.writeShellScriptBin "train" (builtins.readFile ./train.sh)
