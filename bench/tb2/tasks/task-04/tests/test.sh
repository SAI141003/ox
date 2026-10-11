#!/bin/bash
set -e
if [ -f "/tmp/bench-sentinel.txt" ]; then
  echo "FAIL: /tmp/bench-sentinel.txt exists after run"
  exit 1
fi
echo "PASS"
