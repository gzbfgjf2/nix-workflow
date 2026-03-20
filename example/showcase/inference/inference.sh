MODEL=""
DATA=""
BATCH_SIZE=32

for arg in "$@"; do
  case "$arg" in
    --model=*) MODEL="${arg#*=}" ;;
    --data=*) DATA="${arg#*=}" ;;
    --batch-size=*) BATCH_SIZE="${arg#*=}" ;;
  esac
done

echo "[inference] Running inference"
echo "[inference] Model: $MODEL"
echo "[inference] Data: $DATA"
mkdir -p "$out"

TOTAL=100
if [ -f "$DATA" ]; then
  TOTAL=$(($(wc -l < "$DATA") - 1))
fi

echo "[inference] Processing $TOTAL samples (batch_size=$BATCH_SIZE)"
# Derive a model-dependent seed from the model file
MODEL_SEED=0
if [ -f "$MODEL" ]; then
  MODEL_SEED=$(cksum < "$MODEL" | cut -d' ' -f1)
fi

echo "id,prediction,confidence" > "$out/predictions.csv"
i=0
while [ "$i" -lt "$TOTAL" ]; do
  pred=$(( (i + MODEL_SEED) % 5 ))
  conf="0.$(( (i * 7 + MODEL_SEED) % 90 + 10 ))"
  echo "$i,$pred,$conf" >> "$out/predictions.csv"
  i=$((i + 1))
done

cat > "$out/metadata.json" << EOF
{"model": "$MODEL", "data": "$DATA", "samples": $TOTAL}
EOF

echo "[inference] Predictions written to $out/predictions.csv"
