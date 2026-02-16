cd ~/Desktop/cravatta-app-optimized
cat > run-corrector.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$ROOT/corrector-category/corrector-category.mjs"

if [[ ! -f "$SCRIPT" ]]; then
  echo "❌ Non trovo lo script: $SCRIPT"
  exit 1
fi

PROBE_LOG="$(mktemp)"
cleanup() { rm -f "$PROBE_LOG" 2>/dev/null || true; }
trap cleanup EXIT

echo "🔎 PROBE (headless, DRY_RUN=1, LIMIT=1) ..."
set +e
CORRECTOR_HEADFUL=0 CORRECTOR_DRY_RUN=1 CORRECTOR_LIMIT=1 \
node "$SCRIPT" 2>&1 | tee "$PROBE_LOG"
PROBE_RC=${PIPESTATUS[0]}
set -e

# Se è bloccato, parte la quest headful
if grep -qi "bloccato" "$PROBE_LOG"; then
  echo
  echo "🧩 QUEST (headful, DRY_RUN=1, LIMIT=1) ..."
  CORRECTOR_HEADFUL=1 CORRECTOR_DRY_RUN=1 CORRECTOR_LIMIT=1 \
  node "$SCRIPT"
elif [[ $PROBE_RC -ne 0 ]]; then
  echo "❌ Probe fallita (exit=$PROBE_RC). Controlla i log sopra."
  exit $PROBE_RC
fi

echo
echo "🚀 FULL RUN (headless) ..."
CORRECTOR_HEADFUL=0 CORRECTOR_DRY_RUN=0 CORRECTOR_LIMIT=0 \
node "$SCRIPT"
EOF

chmod +x run-corrector.sh
