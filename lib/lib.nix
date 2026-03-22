{
  pkgs,
}:
rec {
  system = builtins.currentSystem;
  cliparser = pkgs.callPackage ./cli_parser.nix { };

  preprocess =
    arg:
    if builtins.isString arg then
      let
        canonical = cliparser.parseCanonicalCliString arg;
      in
      {
        inherit canonical;
        canonicalCmd = cliparser.toCanonicalCommandString canonical;
      }
    # else if builtins.isAttrs arg then
    #   {
    #     input = arg;
    #   }
    else
      throw "preprocess: expected string or attrset";
  process =
    {
      canonical,
      canonicalCmd,
      name ? "unnamed",
      _untracked ? null,
    }:
    let
      getPlaceholderStr =
        str: (builtins.replaceStrings [ "/nix/store/" ] [ "" ] str) + "-ca-placeholder";
      recipeDerivation = derivation {
        name = "${name}-nix-workflow-task-recipe";
        inherit system;
        PATH = pkgs.lib.makeBinPath [
          pkgs.coreutils
          pkgs.jq
        ];

        args = [
          "-c"
          ''
            set -eu
            mkdir -p "$out"
            printf '%s' "$1" | jq --indent 2 '.' > "$out/recipe.json"
          ''
          "dummy"
          (builtins.toJSON {
            inherit canonical canonicalCmd;
            out = getPlaceholderStr (builtins.placeholder "out");
          })
        ];
        builder = "${pkgs.bash}/bin/bash";
      };
      type = "task";
      pathRecipeUnresolvedDrv = recipeDerivation.drvPath;
      pathRecipeUnresolved = recipeDerivation.outPath;
      taskOutputPath = getPlaceholderStr recipeDerivation.outPath;
      # builtins.replaceStrings
      #   [ "/nix/store/" "-nix-workflow-task-recipe" ]
      #   [
      #     "/nix-workflow/store/"
      #     ""
      #   ]
      #   recipeDerivation.outPath;
      taskStatePath =
        builtins.replaceStrings
          [ "/nix/store/" "-nix-workflow-task-recipe" ]
          [ "/nix-workflow/state/" "" ]
          recipeDerivation.outPath;
      dirName =
        builtins.replaceStrings [ "/nix/store/" "-nix-workflow-task-recipe" ] [ "" "" ]
          recipeDerivation.outPath;
    in
    {
      __toString = self: taskOutputPath;
      "__type__" = type;
      id = pathRecipeUnresolved;
      inherit
        name
        pathRecipeUnresolvedDrv
        pathRecipeUnresolved
        taskOutputPath
        taskStatePath
        dirName
        _untracked
        canonical
        canonicalCmd
        ;
    };

  output =
    x:
    pkgs.lib.pipe x [
      preprocess
      process
    ];

  static =
    { path, hash, info ? null }:
    let
      taskOutputPath = "/nix-workflow/store/${hash}";
    in
    {
      __toString = self: taskOutputPath;
      "__type__" = "static";
      inherit path hash info taskOutputPath;
    };
}
