let
  output = (import ../../nix-workflow).lib.output;
  # Showcase scripts
  build_data_bin = import ./showcase/build-data {};
  train_bin = import ./showcase/train {};
  inference_bin = import ./showcase/inference {};
  evaluate_bin = import ./showcase/evaluate {};
  compare_bin = import ./showcase/compare {};
in
rec {

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

  comparison = output ''
    ${compare_bin}/bin/compare
    --result=${eval_small}
    --result=${eval_base}
    --result=${eval_large}
  '';
}
