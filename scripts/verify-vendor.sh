#!/usr/bin/env bash
# Verifies that src/engine/ is a byte-for-byte copy of the pinned upstream commit and that
# VENDOR.md records it faithfully (SPEC §9). Reads commit objects only, never the upstream
# working tree, so the sibling checkout may be at any commit or dirty.
#
# Usage: npm run verify:vendor          (UPSTREAM defaults to ../lab-cdt-ladder)
#        UPSTREAM=/path/to/lab-cdt-ladder bash scripts/verify-vendor.sh
set -euo pipefail
cd "$(dirname "$0")/.."

UPSTREAM="${UPSTREAM:-../lab-cdt-ladder}"
RECORD=src/engine/VENDOR.md
PIN=$(sed -n 's/^Commit: \([0-9a-f]\{40\}\)$/\1/p' "$RECORD")
[ -n "$PIN" ] || { echo "FAIL: $RECORD has no 'Commit: <sha>' line"; exit 1; }
git -C "$UPSTREAM" cat-file -e "$PIN^{commit}" 2>/dev/null \
  || { echo "FAIL: commit $PIN not found in $UPSTREAM"; exit 1; }

fail=0

# 1. Same file set as the pinned tree (VENDOR.md itself is the only extra file allowed).
if ! diff <(git -C "$UPSTREAM" ls-tree -r --name-only "$PIN" -- src/engine | sed 's#^src/engine/##' | sort) \
          <(ls src/engine | grep -v '^VENDOR.md$' | sort); then
  echo "FAIL: file set differs from the pinned tree (see diff above)"; fail=1
fi

# 2. Byte identity with the commit object: blob id of the file on disk vs ls-tree at the pin.
while IFS=$'\t' read -r meta rel; do
  blob=${meta##* }
  mine=$(git hash-object "$rel")
  if [ "$blob" != "$mine" ]; then echo "FAIL: blob mismatch $rel (pin $blob, disk $mine)"; fail=1; fi
done < <(git -C "$UPSTREAM" ls-tree -r "$PIN" -- src/engine)

# 3. SHA-256 three ways: commit object == file on disk == VENDOR.md.
count=0
while read -r f recorded; do
  disk=$(shasum -a 256 "src/engine/$f" | cut -d' ' -f1)
  pinned=$(git -C "$UPSTREAM" show "$PIN:src/engine/$f" | shasum -a 256 | cut -d' ' -f1)
  if [ "$disk" = "$recorded" ] && [ "$pinned" = "$recorded" ]; then
    echo "ok  $recorded  $f"; count=$((count + 1))
  else
    echo "FAIL: sha256 mismatch $f (recorded $recorded, disk $disk, pin $pinned)"; fail=1
  fi
done < <(sed -n 's/^| \([^ |][^ |]*\) | \([0-9a-f]\{64\}\) |$/\1 \2/p' "$RECORD")

# 4. Every file on disk is recorded.
for f in $(ls src/engine | grep -v '^VENDOR.md$'); do
  grep -q "^| $f | " "$RECORD" || { echo "FAIL: $f is not recorded in $RECORD"; fail=1; }
done

if [ "$fail" -eq 0 ]; then
  echo "vendor OK: $count files match commit $PIN byte for byte, and VENDOR.md records them"
else
  echo "vendor FAILED"
fi
exit "$fail"
