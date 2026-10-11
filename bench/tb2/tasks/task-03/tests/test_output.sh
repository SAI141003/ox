#!/bin/bash
set -e
if [ -z "$TRANSCRIPT" ] && [ -z "$1" ]; then
  echo "FAIL: No transcript provided"
  exit 1
fi
transcript="${TRANSCRIPT:-$1}"
if ! grep -q "solve" "$transcript"; then
  echo "FAIL: Transcript does not contain 'solve'"
  exit 1
fi
if ! grep -q "36" "$transcript"; then
  echo "FAIL: Transcript does not contain '36'"
  exit 1
fi
echo "PASS"
