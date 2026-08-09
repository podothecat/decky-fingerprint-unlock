#!/usr/bin/env bash
# Drive N consecutive verifies through the plugin backend over CDP and print a table.
#
#     ./measure-verify.sh <runs> <timeout_s> <label>
#
# Why via CDP rather than `sudo fprintd-verify`: the backend is the thing we actually
# ship, it already runs as root with the polkit rule, and it wraps each verify in
# systemd-inhibit --what=handle-power-key -- which matters, because the sensor IS the
# power button. Measuring the real path avoids proving something about a path we do not
# use.
#
# Arm-then-poll rather than one blocking evaluate: cdp.py's socket read times out well
# before a long verify finishes, and a client-side timeout does NOT cancel the verify --
# it keeps running and the next call gets refused with result=busy. Learned the hard way.
set -euo pipefail

RUNS="${1:-6}"
TIMEOUT_S="${2:-20}"
LABEL="${3:-run}"
CDP="$(dirname "$(realpath "$0")")/cdp.py"
OUT="$(dirname "$(realpath "$0")")/investigation/verify-${LABEL}.txt"
mkdir -p "$(dirname "$OUT")"

echo "== $RUNS runs, ${TIMEOUT_S}s timeout each, label=$LABEL" | tee "$OUT"
echo "| run | result | elapsedMs | detail |" | tee -a "$OUT"
echo "|---|---|---|---|" | tee -a "$OUT"

for i in $(seq 1 "$RUNS"); do
  "$CDP" "window.__probe={state:'running',t0:Date.now()};
          window.__allyFP.backend.verify($TIMEOUT_S)
            .then(r=>{window.__probe.r=r; window.__probe.wallMs=Date.now()-window.__probe.t0; window.__probe.state='done';})
            .catch(e=>{window.__probe.r={result:'threw',detail:String(e)}; window.__probe.state='done';});
          'armed'" >/dev/null

  # Poll until the backend hands back a result. Cap at timeout + 15s of slack for claim
  # and process teardown; anything past that is a hang worth seeing rather than hiding.
  deadline=$(( TIMEOUT_S + 15 ))
  waited=0
  while [ "$waited" -lt "$deadline" ]; do
    sleep 2
    waited=$(( waited + 2 ))
    probe="$("$CDP" 'JSON.stringify(window.__probe)' 2>/dev/null | tail -1)"
    case "$probe" in *'"done"'*) break;; esac
  done

  line="$(python3 -c '
import json,sys
raw=sys.argv[1]
try:
    p=json.loads(json.loads(raw))
except Exception:
    print("| ? | parse-failed | ? | %s |" % raw[:60]); raise SystemExit
r=p.get("r") or {}
print("| %s | %s | %s | %s |" % (sys.argv[2], r.get("result","?"), p.get("wallMs","?"),
      (r.get("detail") or "").replace("\n"," ")[:70]))
' "$probe" "$i")"
  echo "$line" | tee -a "$OUT"

  sleep 2   # let fprintd settle before the next claim
done

echo | tee -a "$OUT"
echo "written to $OUT"
