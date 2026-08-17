#!/usr/bin/env bash
# Read the site usage report out of Workers Analytics Engine.
#
# WHY A SCRIPT AND NOT A PAGE: querying the dataset needs an account-scoped API
# token. A token that reaches the browser is a token that leaks, so the numbers
# are read here, on your machine, and the token never leaves this shell.
#
# WHAT IS STORED (see worker/index.js): the event name, a short detail from a
# closed list, mobile/desktop, and a country code. No wallet address, no amount,
# no token, no IP, no user-agent, no session or visitor id. That means these
# numbers are counts, never people: the funnel below is a ratio between counts,
# not a path followed by one visitor.
#
# SETUP, ONCE:
#   1. Cloudflare dashboard -> Manage Account -> Account API Tokens -> Create.
#      Permission: Account -> Account Analytics -> Read. Nothing else.
#   2. Copy your 32-character Account ID from the dashboard sidebar.
#
# USAGE:
#   ./scripts/ev_report.sh                  # asks for the token, nothing echoes
#   CF_ACCOUNT_ID=... CF_API_TOKEN=... ./scripts/ev_report.sh
#
# Counts use SUM(_sample_interval), not COUNT(*). Analytics Engine samples high
# volume events, and COUNT(*) would silently under-report once that kicks in.
set -uo pipefail

DATASET="zaexa_events"
DAYS="${DAYS:-14}"

if [ -z "${CF_ACCOUNT_ID:-}" ]; then
  read -rp "Cloudflare Account ID: " CF_ACCOUNT_ID
fi
if [ -z "${CF_API_TOKEN:-}" ]; then
  read -rsp "API token (Account Analytics: Read): " CF_API_TOKEN
  echo
fi
# Witness line. A silently empty paste is the reason a 401 once got read as
# "the plan does not cover this", which was wrong. Never trust an empty var.
echo "account=${CF_ACCOUNT_ID:0:6}...  token_len=${#CF_API_TOKEN}"
if [ "${#CF_API_TOKEN}" -lt 20 ] || [ -z "$CF_ACCOUNT_ID" ]; then
  echo "The account id or token looks empty. Stopping before blaming the API." >&2
  exit 1
fi

API="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql"

# Control target first. A curl that cannot connect returns 000, which is not an
# answer from the server - it means the request never arrived. Without this we
# cannot tell "my link is down" from "the token is wrong".
probe="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  https://api.cloudflare.com/client/v4/user/tokens/verify 2>/dev/null || true)"
case "$probe" in
  200) : ;;
  000) echo "No connection to api.cloudflare.com at all (curl 000). Check the link/VPN, not the token." >&2; exit 1 ;;
  401|403) echo "Reached Cloudflare, but the token was rejected (HTTP $probe). Check the token and its permission." >&2; exit 1 ;;
  *)   echo "Token check answered HTTP $probe - continuing, the query below will say more." >&2 ;;
esac

q() {  # q "<title>" "<sql>"
  echo
  echo "=== $1"
  local body code
  body="$(curl -sS --max-time 45 -w $'\n%{http_code}' \
    -H "Authorization: Bearer $CF_API_TOKEN" --data "$2" "$API" 2>/dev/null || true)"
  code="$(printf '%s' "$body" | tail -n1)"
  body="$(printf '%s' "$body" | sed '$d')"
  if [ "$code" = "000" ]; then
    echo "  no connection (curl 000) - the query never reached Cloudflare"
    return
  fi
  if [ "$code" != "200" ]; then
    echo "  HTTP $code"
    printf '%s\n' "$body" | head -c 600
    echo
    return
  fi
  # No jq dependency: python3 is already required by the test suite.
  printf '%s' "$body" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception as e:
    print("  could not parse the answer: %s" % e); sys.exit()
rows=d.get("data") or []
if not rows:
    print("  no rows yet. If the site has traffic, check that the ZX_EV binding is")
    print("  deployed and that some events have been written since.")
    sys.exit()
cols=list(rows[0].keys())
w=[max(len(c),*(len(str(r.get(c,""))) for r in rows)) for c in cols]
print("  " + "  ".join(c.ljust(w[i]) for i,c in enumerate(cols)))
print("  " + "  ".join("-"*w[i] for i,_ in enumerate(cols)))
for r in rows:
    print("  " + "  ".join(str(r.get(c,"")).ljust(w[i]) for i,c in enumerate(cols)))
'
}

echo
echo "ZAEXA usage - last $DAYS days - dataset $DATASET"

# toStartOfDay, not toDate: toDate is not in Analytics Engine's supported
# date/time function list. Checked against the SQL reference, not guessed.
q "Page opens per day" "
SELECT toStartOfDay(timestamp) AS day, SUM(_sample_interval) AS opens
FROM $DATASET
WHERE timestamp > NOW() - INTERVAL '$DAYS' DAY AND blob1 = 'load'
GROUP BY day ORDER BY day"

q "Which view people open" "
SELECT blob1 AS view, SUM(_sample_interval) AS opens
FROM $DATASET
WHERE timestamp > NOW() - INTERVAL '$DAYS' DAY AND blob1 LIKE 'view:%'
GROUP BY view ORDER BY opens DESC"

# The drop-off funnel. Read it as ratios between rows: of every 100 page opens,
# how many connected a wallet, got a price, pressed swap, and finished.
q "Drop-off funnel" "
SELECT blob1 AS step, SUM(_sample_interval) AS n
FROM $DATASET
WHERE timestamp > NOW() - INTERVAL '$DAYS' DAY
  AND blob1 IN ('load','wallet:open','wallet:on','quote:ok','quote:none',
                'approve:click','approve:done','swap:click','swap:blocked',
                'swap:sim-fail','swap:sent','swap:done','swap:revert',
                'swap:lost','swap:fail')
GROUP BY step ORDER BY n DESC"

q "Mobile or desktop" "
SELECT blob3 AS surface, SUM(_sample_interval) AS opens
FROM $DATASET
WHERE timestamp > NOW() - INTERVAL '$DAYS' DAY AND blob1 = 'load'
GROUP BY surface ORDER BY opens DESC"

q "Where visitors are (top 15)" "
SELECT blob4 AS country, SUM(_sample_interval) AS opens
FROM $DATASET
WHERE timestamp > NOW() - INTERVAL '$DAYS' DAY AND blob1 = 'load'
GROUP BY country ORDER BY opens DESC LIMIT 15"

q "Wallet kind" "
SELECT blob2 AS kind, SUM(_sample_interval) AS connects
FROM $DATASET
WHERE timestamp > NOW() - INTERVAL '$DAYS' DAY AND blob1 = 'wallet:on'
GROUP BY kind ORDER BY connects DESC"

echo
echo "Note: visitors with Global Privacy Control enabled are not counted, so"
echo "every number here is a floor, not an exact total."
