#!/bin/bash
set -e
if [ ! -f ".agent/MEMORY.md" ]; then
  echo "FAIL: .agent/MEMORY.md does not exist"
  exit 1
fi
if ! grep -q "BLUE-8821" ".agent/MEMORY.md"; then
  echo "FAIL: .agent/MEMORY.md does not contain BLUE-8821"
  exit 1
fi
echo "PASS"
