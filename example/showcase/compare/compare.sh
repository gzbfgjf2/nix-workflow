RESULTS=""

for arg in "$@"; do
  case "$arg" in
    --result=*) RESULTS="$RESULTS ${arg#*=}" ;;
  esac
done

echo "[compare] Comparing evaluation results"
mkdir -p "$out"

echo "source,accuracy,precision,recall,f1" > "$out/comparison.csv"
for r in $RESULTS; do
  if [ -f "$r/metrics.json" ]; then
    echo "[compare] Reading $r/metrics.json"
    acc=$(cat "$r/metrics.json" | grep -o '"accuracy": [0-9.]*' | grep -o '[0-9.]*')
    prec=$(cat "$r/metrics.json" | grep -o '"precision": [0-9.]*' | grep -o '[0-9.]*')
    rec=$(cat "$r/metrics.json" | grep -o '"recall": [0-9.]*' | grep -o '[0-9.]*')
    f1=$(cat "$r/metrics.json" | grep -o '"f1": [0-9.]*' | grep -o '[0-9.]*')
    echo "$r,$acc,$prec,$rec,$f1" >> "$out/comparison.csv"
  fi
done

echo "[compare] Comparison written to $out/comparison.csv"
