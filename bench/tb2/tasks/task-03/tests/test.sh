#!/bin/bash
set -e
if [ ! -f "solution.js" ]; then
  echo "FAIL: solution.js does not exist"
  exit 1
fi
output=$(node -e "const {solve}=require('./solution.js'); console.log(solve(6))")
if [ "$output" != "36" ]; then
  echo "FAIL: solve(6) returned '$output', expected '36'"
  exit 1
fi
echo "PASS"
