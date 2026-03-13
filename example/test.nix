let
  output = (import ./work.nix).output;
  template = (import ../default.nix { }).env;
in
rec {
  fineweb_10bt = output ''
    ${template}/bin/prepare-data
    base.fineweb_10bt_recite
  '';

  # model_a_training = output ''
  #   ./train.sh
  #   --epoch=1
  # '';
  #
  # model_a_sample = output ''
  #   ./inference.sh
  #   --data=hello
  #   --model=${model_a_training}/model
  #   --seed=42
  # '';
  #
  # evalaute = output ''
  #   ./evaluate.sh
  #   --ground_truth=data
  #   --predictions=${model_a_sample}
  #   --metrics=accuracy
  # '';
}
