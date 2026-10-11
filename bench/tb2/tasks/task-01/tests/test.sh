#!/bin/bash
set -e
if [ ! -f "message.txt" ]; then
  echo "FAIL: message.txt does not exist"
  exit 1
fi
content=$(cat message.txt)
if [ "$content" != "BENCH-MARKER-8821" ]; then
  echo "FAIL: message.txt content is '$content', expected 'BENCH-MARKER-8821'"
  exit 1
fi
echo "PASS"
