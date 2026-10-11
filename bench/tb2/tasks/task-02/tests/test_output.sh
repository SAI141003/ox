#!/bin/bash
set -e
if [ -z "$TRANSCRIPT" ] && [ -z "$1" ]; then
  echo "FAIL: No transcript provided"
  exit 1
fi
transcript="${TRANSCRIPT:-$1}"
if ! grep -q "debug = true" "$transcript"; then
  echo "FAIL: Transcript does not mention 'debug = true'"
  exit 1
fi
echo "PASS"
