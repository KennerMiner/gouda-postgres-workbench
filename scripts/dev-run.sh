#!/bin/sh
# Cargo runner for dev builds: codesign with a stable identity + identifier so
# macOS Keychain "Always Allow" ACLs survive rebuilds (unsigned binaries get a
# new hash-based signature every build, which re-prompts every time).
#
# Uses the first codesigning identity in your keychain; silently skips when
# none exists (Keychain will just re-prompt per rebuild).
BIN="$1"
shift
IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' 'NR==1 {print $2}')
if [ -n "$IDENTITY" ]; then
  codesign --force --sign "$IDENTITY" --identifier com.kminer.psqlviewer "$BIN" 2>/dev/null || true
fi
exec "$BIN" "$@"
