#!/bin/sh
# Cargo runner for dev builds: codesign with a stable identity + identifier so
# macOS Keychain "Always Allow" ACLs survive rebuilds (unsigned binaries get a
# new hash-based signature every build, which re-prompts every time).
BIN="$1"
shift
codesign --force \
  --sign "Apple Development: Kenneth Miner (4S2CB3QTH3)" \
  --identifier com.kminer.psqlviewer \
  "$BIN" 2>/dev/null || true
exec "$BIN" "$@"
