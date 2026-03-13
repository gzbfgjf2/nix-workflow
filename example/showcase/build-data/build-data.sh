NAME="dataset"
SAMPLES=1000
SEED=42

for arg in "$@"; do
  case "$arg" in
    --name=*) NAME="${arg#*=}" ;;
    --samples=*) SAMPLES="${arg#*=}" ;;
    --seed=*) SEED="${arg#*=}" ;;
  esac
done

echo "[build-data] Generating dataset '$NAME' ($SAMPLES samples, seed=$SEED)"
mkdir -p "$out"

echo "id,x0,x1,x2,label" > "$out/data.csv"
i=0
while [ "$i" -lt "$SAMPLES" ]; do
  echo "$i,$((RANDOM % 100)),$((RANDOM % 100)),$((RANDOM % 100)),$((i % 5))" >> "$out/data.csv"
  i=$((i + 1))
done

cat > "$out/metadata.json" << EOF
{"name": "$NAME", "samples": $SAMPLES, "seed": $SEED}
EOF

echo "[build-data] Written $SAMPLES samples to $out/data.csv"
