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
    else if builtins.isAttrs arg then
      let
        canonical = cliparser.parseCanonicalCliString arg.cmd;
      in
      {
        inherit canonical;
        canonicalCmd = cliparser.toCanonicalCommandString canonical;
      }
      // (if arg ? hash then { inherit (arg) hash; } else { })
    else
      throw "preprocess: expected string or attrset";

  mkRecipe =
    { name, recipeContent }:
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
          (builtins.toJSON (recipeContent // { out = getPlaceholderStr (builtins.placeholder "out"); }))
        ];
        builder = "${pkgs.bash}/bin/bash";
      };
      pathRecipeUnresolvedDrv = recipeDerivation.drvPath;
      pathRecipeUnresolved = recipeDerivation.outPath;
      taskOutputPath = getPlaceholderStr recipeDerivation.outPath;
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
      inherit
        pathRecipeUnresolvedDrv
        pathRecipeUnresolved
        taskOutputPath
        taskStatePath
        dirName
        ;
      id = pathRecipeUnresolved;
    };

  process =
    {
      canonical,
      canonicalCmd,
      name ? "unnamed",
      hash ? null,
      _untracked ? null,
    }:
    let
      recipe = mkRecipe {
        inherit name;
        recipeContent = { inherit canonical canonicalCmd; } // (if hash != null then { inherit hash; } else { });
      };
    in
    {
      __toString = self: recipe.taskOutputPath;
      "__type__" = "task";
      inherit
        name
        hash
        _untracked
        canonical
        canonicalCmd
        ;
      inherit (recipe)
        pathRecipeUnresolvedDrv
        pathRecipeUnresolved
        taskOutputPath
        taskStatePath
        dirName
        id
        ;
    };

  output =
    x:
    pkgs.lib.pipe x [
      preprocess
      process
    ];

  static =
    { path ? null, hash, info ? null, name ? "static" }:
    let
      recipe = mkRecipe {
        inherit name;
        recipeContent = { inherit hash; };
      };
    in
    {
      __toString = self: recipe.taskOutputPath;
      "__type__" = "static";
      inherit path hash info;
      inherit (recipe)
        pathRecipeUnresolvedDrv
        pathRecipeUnresolved
        taskOutputPath
        taskStatePath
        dirName
        id
        ;
    };
}
