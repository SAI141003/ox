#!/bin/bash
set -e
if [ ! -f "config.txt" ]; then
  echo "FAIL: config.txt does not exist"
  exit 1
fi
if ! grep -q "debug = true" config.txt; then
  echo "FAIL: config.txt does not contain 'debug = true'"
  exit 1
fi
if grep -q "debug = false" config.txt; then
  echo "FAIL: config.txt still contains 'debug = false'"
  exit 1
fi
echo "PASS"
