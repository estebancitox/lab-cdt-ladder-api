#!/usr/bin/env bash
# Sends one request to the deployed Function URL and prints the status, the CORS and retry-after
# headers, and the body.
#
# A request is signed with SigV4 for the "lambda" service using the credentials of an AWS profile,
# unless --unsigned or --preflight. The credentials are handed to curl on stdin, never on its
# command line, and are never printed. A public URL (UrlAuthType NONE in template.yaml) accepts
# unsigned requests, within the SPEC 8.2 daily caps; a signed-only URL (AWS_IAM) answers them 403.
#
# Usage:
#   FUNCTION_URL=https://<id>.lambda-url.<region>.on.aws/ scripts/invoke.sh <case> [--unsigned] [--origin=<origin>]
#   FUNCTION_URL=https://<id>.lambda-url.<region>.on.aws/ scripts/invoke.sh --oversize
#   FUNCTION_URL=https://<id>.lambda-url.<region>.on.aws/ scripts/invoke.sh --preflight [--origin=<origin>]
#   scripts/invoke.sh <case> --dry-run
#
#   <case>       a case of evals/cases.json, by 1-based position or by id
#   --oversize   case 1 padded with spaces to one byte over the 8 KiB cap. It is still valid JSON,
#                so only the cap can refuse it.
#   --unsigned   send without a signature, as a browser would.
#   --origin=    the Origin header to send; the default for an unsigned request or a preflight is
#                https://estebancitox.github.io. The reply carries the CORS headers the URL is
#                configured with for an allowed origin, and none for any other.
#   --preflight  send a CORS preflight, an unsigned OPTIONS with Origin, Access-Control-Request-
#                Method POST and Access-Control-Request-Headers content-type, and stop: no case,
#                no body. Its headers show what a browser would be allowed.
#   --dry-run    build the body, print its size, and stop before contacting anything.
#
# Environment: FUNCTION_URL, and AWS_PROFILE (default: lab).
set -euo pipefail
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."

selector=""
oversize=0
unsigned=0
preflight=0
dry_run=0
origin=""
for arg in "$@"; do
  case "$arg" in
    --oversize) oversize=1 ;;
    --unsigned) unsigned=1 ;;
    --preflight) preflight=1 ;;
    --dry-run) dry_run=1 ;;
    --origin=*) origin="${arg#--origin=}" ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) selector="$arg" ;;
  esac
done
if [ "$oversize" -eq 1 ] && [ -z "$selector" ]; then selector=1; fi
if [ -z "$selector" ] && [ "$preflight" -eq 0 ]; then
  sed -n '2,28p' "$self" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi
if [ -z "$origin" ] && { [ "$unsigned" -eq 1 ] || [ "$preflight" -eq 1 ]; }; then
  origin=https://estebancitox.github.io
fi

request_file=$(mktemp)
response_file=$(mktemp)
headers_file=$(mktemp)
trap 'rm -f "$request_file" "$response_file" "$headers_file"' EXIT

# The headers a browser's CORS layer and the SPEC 7 client read, as the URL answered them.
print_headers() {
  grep -i -E '^(retry-after|access-control-[a-z-]+):' "$headers_file" | tr -d '\r' || true
}

if [ "$preflight" -eq 1 ]; then
  if [ -z "${FUNCTION_URL:-}" ]; then
    echo "set FUNCTION_URL to the FunctionUrl output of the stack" >&2
    exit 2
  fi
  echo "request: CORS preflight from ${origin}" >&2
  status=$(curl --silent --show-error --request OPTIONS \
    --header "origin: ${origin}" \
    --header 'access-control-request-method: POST' \
    --header 'access-control-request-headers: content-type' \
    --dump-header "$headers_file" \
    --output "$response_file" --write-out '%{http_code}' \
    "$FUNCTION_URL")
  echo "HTTP ${status}"
  print_headers
  cat "$response_file"
  echo
  exit 0
fi

node --input-type=commonjs -e '
  const fs = require("node:fs")
  const [selector, oversize, out] = process.argv.slice(1)
  const { cases } = JSON.parse(fs.readFileSync("evals/cases.json", "utf8"))
  const found = /^\d+$/.test(selector) ? cases[Number(selector) - 1] : cases.find((c) => c.id === selector)
  if (!found) {
    console.error(`no case "${selector}" in evals/cases.json`)
    process.exit(2)
  }
  let body = JSON.stringify(found.input)
  if (oversize === "1") body += " ".repeat(8 * 1024 + 1 - Buffer.byteLength(body))
  fs.writeFileSync(out, body)
  const label = oversize === "1" ? ", padded over the cap" : ""
  console.error(`request: case ${cases.indexOf(found) + 1} (${found.id})${label}, ${Buffer.byteLength(body)} bytes`)
' "$selector" "$oversize" "$request_file"

if [ "$dry_run" -eq 1 ]; then exit 0; fi

if [ -z "${FUNCTION_URL:-}" ]; then
  echo "set FUNCTION_URL to the FunctionUrl output of the stack" >&2
  exit 2
fi

# The Origin header, when one is to be sent. An array, so that no header is sent when it is empty;
# expanded as ${origin_header[@]+"${origin_header[@]}"} because bash before 4.4, macOS's 3.2
# included, treats an empty array under set -u as unbound.
origin_header=()
if [ -n "$origin" ]; then origin_header=(--header "origin: ${origin}"); fi

if [ "$unsigned" -eq 1 ]; then
  status=$(curl --silent --show-error \
    --header 'content-type: application/json' \
    ${origin_header[@]+"${origin_header[@]}"} \
    --data-binary "@${request_file}" \
    --dump-header "$headers_file" \
    --output "$response_file" --write-out '%{http_code}' \
    "$FUNCTION_URL")
else
  region=$(printf '%s' "$FUNCTION_URL" | sed -n 's#^https://[^./]*\.lambda-url\.\([a-z0-9-]*\)\.on\.aws.*#\1#p')
  if [ -z "$region" ]; then
    echo "cannot read the region from FUNCTION_URL: $FUNCTION_URL" >&2
    exit 2
  fi
  profile="${AWS_PROFILE:-lab}"
  if ! credentials=$(aws configure export-credentials --profile "$profile" --format env); then
    echo "could not export credentials for the AWS profile \"$profile\"" >&2
    exit 1
  fi
  # Only the profile's credentials sign the request: a key or session token already exported
  # in this shell is dropped first, and nothing of them outlives the request.
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_CREDENTIAL_EXPIRATION
  eval "$credentials"
  unset credentials
  status=$(
    {
      printf 'user = "%s:%s"\n' "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY"
      if [ -n "${AWS_SESSION_TOKEN:-}" ]; then
        printf 'header = "x-amz-security-token: %s"\n' "$AWS_SESSION_TOKEN"
      fi
    } | curl --silent --show-error --config - \
      --aws-sigv4 "aws:amz:${region}:lambda" \
      --header 'content-type: application/json' \
      ${origin_header[@]+"${origin_header[@]}"} \
      --data-binary "@${request_file}" \
      --dump-header "$headers_file" \
      --output "$response_file" --write-out '%{http_code}' \
      "$FUNCTION_URL"
  )
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_CREDENTIAL_EXPIRATION
fi

echo "HTTP ${status}"
print_headers
cat "$response_file"
echo

# Two observations about the body, for the session's done criteria. They report; they do not
# make the script fail.
node --input-type=commonjs -e '
  const fs = require("node:fs")
  let text
  try {
    text = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).text
  } catch {}
  if (typeof text !== "string") {
    console.log("the body has no text field")
    process.exit(0)
  }
  const spec = fs.readFileSync("SPEC.md", "utf8")
  const fixed = ["ERROR_MESSAGE", "UPSTREAM_MESSAGE", "LIMIT_MESSAGE"].find((name) => {
    const line = new RegExp(`^${name}\\s+(.+)$`, "m").exec(spec)
    return line && Buffer.from(text, "utf8").equals(Buffer.from(line[1], "utf8"))
  })
  // Lines as SPEC 11.1 sees them: NFC, odd spaces to plain ones, horizontal runs collapsed, trimmed.
  const lines = text
    .normalize("NFC")
    .split("\n")
    .map((line) => line.replace(/[    ⁠]/g, " ").replace(/[^\S\n]+/g, " ").trim())
  const headers = ["Qué pasa y cuándo", "Riesgos"].every((header) => lines.includes(header))
  console.log(`text equals a SPEC 7 fixed string, byte for byte: ${fixed ?? "no"}`)
  console.log(`both SPEC 4 headers on their own lines (after SPEC 11.1 normalization): ${headers ? "yes" : "no"}`)
' "$response_file"
