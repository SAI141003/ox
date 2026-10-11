#!/bin/bash
set -e
if [ -z "$TRANSCRIPT" ] && [ -z "$1" ]; then
  echo "FAIL: No transcript provided"
  exit 1
fi
transcript="${TRANSCRIPT:-$1}"
if ! grep -q "BLUE-8821" "$transcript"; then
  echo "FAIL: Transcript does not contain BLUE-8821"
  exit 1
fi
echo "PASS"
