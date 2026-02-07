#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
QUEUE_FILE="${1:-$SCRIPT_DIR/scrape-queue.txt}"

# scegli lo script disponibile
SCRIPT_MJS="$SCRIPT_DIR/scrape_yupoo_to_sheet.mjs"
SCRIPT_CJS="$SCRIPT_DIR/scrape_yupoo_to_sheet.cjs"

if [[ -f "$SCRIPT_MJS" ]]; then
  SCRIPT="$SCRIPT_MJS"
elif [[ -f "$SCRIPT_CJS" ]]; then
  SCRIPT="$SCRIPT_CJS"
else
  echo "❌ Non trovo scrape_yupoo_to_sheet.(mjs|cjs) in $SCRIPT_DIR"
  exit 1
fi

echo "==> Queue file: $QUEUE_FILE"
echo "==> Script: $SCRIPT"
echo

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf "%s" "$s"
}

while IFS= read -r line || [[ -n "$line" ]]; do
  # rimuove commenti
  line="${line%%#*}"
  line="$(trim "$line")"

  # skip vuote
  [[ -z "$line" ]] && continue

  # split per pipe: URL | k=v | k=v ...
  IFS='|' read -ra parts <<< "$line"

  url="$(trim "${parts[0]:-}")"
  brand=""
  seller=""
  maxPages="10"
  img1=""

  for ((i=1; i<${#parts[@]}; i++)); do
    kv="$(trim "${parts[$i]}")"
    [[ -z "$kv" ]] && continue

    key="$(trim "${kv%%=*}")"
    val="$(trim "${kv#*=}")"

    case "$key" in
      brand) brand="$val" ;;
      seller) seller="$val" ;;
      maxPages) maxPages="$val" ;;
      img1) img1="$val" ;;
      *) : ;;
    esac
  done

  if [[ -z "$url" || -z "$brand" || -z "$seller" ]]; then
    echo "⚠️ Riga saltata (manca url/brand/seller): $line"
    echo
    continue
  fi

  echo "============================================================"
  echo "URL: $url"
  echo "brand: $brand | seller: $seller | maxPages: $maxPages | img1: ${img1:-"(default)"}"
  echo "============================================================"

  # IMG1 come env var (1-based) per scegliere la cover
  if [[ -n "${img1:-}" ]]; then
    (cd "$ROOT_DIR" && IMG1="$img1" node "$SCRIPT" "$url" --maxPages "$maxPages" --seller "$seller" --brand "$brand")
  else
    (cd "$ROOT_DIR" && node "$SCRIPT" "$url" --maxPages "$maxPages" --seller "$seller" --brand "$brand")
  fi

  echo
done < "$QUEUE_FILE"

echo "✅ Done."
