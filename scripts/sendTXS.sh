#!/usr/bin/env bash
set -euo pipefail

# Uso:
#   ./send-batch-meta.sh <PRIMER_NONCE>
#
# Ejemplo:
#   ./send-batch-meta.sh 258

if [ $# -lt 1 ]; then
  echo "Uso: $0 <PRIMER_NONCE>"
  exit 1
fi

FIRST_NONCE="$1"
TX_COUNT=10  # cantidad de transacciones a mandar

echo "🚀 Enviando $TX_COUNT meta-txs empezando en nonce = $FIRST_NONCE"
echo

for ((i = 0; i < TX_COUNT; i++)); do
  NONCE=$((FIRST_NONCE + i))

  echo "============================================================"
  echo "📤 Enviando transacción #$((i + 1)) con nonce = $NONCE"
  echo "============================================================"

  # Importante: los parámetros del script van después de '--'
  N=$NONCE npx hardhat run scripts/deployStorageNonce.ts \
    --network lnetmain &\
 
  sleep 1

  echo "✅ Transacción #$((i + 1)) enviada y confirmada (script terminó)"
  echo
done

echo "🎉 Lote completo: $TX_COUNT transacciones desde nonce $FIRST_NONCE"
