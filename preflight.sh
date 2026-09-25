#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
NODE=/home/radar/node-v22.12.0-linux-x64/bin/node   # same binary as ExecStart; never bare `node`
"$NODE" --version | grep -q '^v22' || { echo "[PREFLIGHT][OPERATOR] wrong node: $("$NODE" --version)" >> data/bot.log; exit 1; }
# 1. syntax — every source file
find src -name '*.js' -print0 | xargs -0 -n1 "$NODE" --check
# 2+3. module-scope AND the four boot gates — `--preflight` (v0.32.5, fixture 68):
#    loads state read-only, runs admit/tier-route/classifiers/pagination gates, prints
#    the banner, exits 0. No Telegram, no poll, no write.
"$NODE" src/index.js --preflight \
  || { echo "[PREFLIGHT][OPERATOR] boot gates refused — see above" >> data/bot.log; exit 1; }
