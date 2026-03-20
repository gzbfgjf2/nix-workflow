let
  output = (import ../../nix-workflow).lib.output;
  # template = (import ../25 { }).env;
  # minidata = (import ../mini/minidata { }).env;
  # sources = import ./npins;
  # minidata_original = (import sources.minidata_automathtextv2_original { }).env;
  # minidata_remember = (import sources.minidata_automathtextv2_remember { }).env;

  # Showcase scripts
  build_data_bin = import ./showcase/build-data {};
  train_bin = import ./showcase/train {};
  inference_bin = import ./showcase/inference {};
  evaluate_bin = import ./showcase/evaluate {};
  compare_bin = import ./showcase/compare {};
in
rec {
  # # inherit minidata minidata_1;
  #
  # # hello_world_data = output ''
  # #   ${minidata}/bin/minidata build hello_world
  # # '';
  #
  # automathtextv2_original = output ''
  #   ${minidata_original}/bin/minidata build automathtextv2 --kwarg=n=15_000_000
  # '';
  #
  # automathtextv2_remember = output ''
  #   ${minidata_remember}/bin/minidata build automathtextv2_remember
  #   --kwarg=automathtextv2_original_path=${automathtextv2_original}
  # '';

  # --- Showcase pipeline ---

  dataset = output ''
    ${build_data_bin}/bin/build-data --name=demo --samples=500 --seed=42
  '';

  model_small = output ''
    ${train_bin}/bin/train
    --data=${dataset}/data.csv
    --epochs=5 --lr=0.01 --batch-size=128
  '';

  model_base = output ''
    ${train_bin}/bin/train
    --data=${dataset}/data.csv
    --epochs=10 --lr=0.001 --batch-size=32
  '';

  model_large = output ''
    ${train_bin}/bin/train
    --data=${dataset}/data.csv
    --epochs=50 --lr=0.0001 --batch-size=64 --seed=123
  '';

  # Duplicate of model_base with explicit --seed=42 (the default).
  # Different recipe, but identical output → demonstrates CA dedup.
  model_dup = output ''
    ${train_bin}/bin/train
    --data=${dataset}/data.csv
    --epochs=10 --lr=0.001 --batch-size=32 --seed=42
  '';

  predict_small = output ''
    ${inference_bin}/bin/inference
    --model=${model_small}/model.json
    --data=${dataset}/data.csv
  '';

  predict_base = output ''
    ${inference_bin}/bin/inference
    --model=${model_base}/model.json
    --data=${dataset}/data.csv
  '';

  predict_large = output ''
    ${inference_bin}/bin/inference
    --model=${model_large}/model.json
    --data=${dataset}/data.csv
  '';

  # predict_dup uses model_dup which has same content as model_base
  # → resolved cmd identical to predict_base → CA cache hit
  predict_dup = output ''
    ${inference_bin}/bin/inference
    --model=${model_dup}/model.json
    --data=${dataset}/data.csv
  '';

  eval_small = output ''
    ${evaluate_bin}/bin/evaluate
    --predictions=${predict_small}/predictions.csv
    --ground-truth=${dataset}/data.csv
  '';

  eval_base = output ''
    ${evaluate_bin}/bin/evaluate
    --predictions=${predict_base}/predictions.csv
    --ground-truth=${dataset}/data.csv
  '';

  eval_large = output ''
    ${evaluate_bin}/bin/evaluate
    --predictions=${predict_large}/predictions.csv
    --ground-truth=${dataset}/data.csv
  '';

  # eval_dup uses predict_dup which has same content as predict_base
  # → resolved cmd identical to eval_base → CA cache hit
  eval_dup = output ''
    ${evaluate_bin}/bin/evaluate
    --predictions=${predict_dup}/predictions.csv
    --ground-truth=${dataset}/data.csv
  '';

  comparison = output ''
    ${compare_bin}/bin/compare
    --result=${eval_small}
    --result=${eval_base}
    --result=${eval_large}
  '';
}
