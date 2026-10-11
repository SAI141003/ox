#!/bin/bash
set -e
if [ ! -f ".mcp.json" ]; then
  echo "FAIL: .mcp.json does not exist"
  exit 1
fi
if [ ! -f ".ox.json" ]; then
  echo "FAIL: .ox.json does not exist"
  exit 1
fi
echo "PASS"
