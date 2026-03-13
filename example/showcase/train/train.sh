DATA=""
EPOCHS=10
LR="0.001"
BATCH_SIZE=32
SEED=42

for arg in "$@"; do
  case "$arg" in
    --data=*) DATA="${arg#*=}" ;;
    --epochs=*) EPOCHS="${arg#*=}" ;;
    --lr=*) LR="${arg#*=}" ;;
    --batch-size=*) BATCH_SIZE="${arg#*=}" ;;
    --seed=*) SEED="${arg#*=}" ;;
  esac
done

echo "[train] Starting training (epochs=$EPOCHS, lr=$LR, batch_size=$BATCH_SIZE, seed=$SEED)"
echo "[train] Data: $DATA"
mkdir -p "$out"

e=1
while [ "$e" -le "$EPOCHS" ]; do
  loss="0.$((1000 / (e + 1)))"
  echo "[train] Epoch $e/$EPOCHS  loss=$loss"
  e=$((e + 1))
done

cat > "$out/model.json" << EOF
{"epochs": $EPOCHS, "lr": $LR, "batch_size": $BATCH_SIZE, "seed": $SEED, "data": "$DATA"}
EOF

cat > "$out/metrics.json" << EOF
{"final_loss": "$loss", "epochs": $EPOCHS}
EOF

echo "[train] Model saved to $out/model.json"
