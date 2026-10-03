#!/usr/bin/env bash
# Sends one request to the deployed Function URL and prints the status and the body.
#
# The URL is private (AuthType AWS_IAM), so the request is signed with SigV4 for the "lambda"
# service using the credentials of an AWS profile. The credentials are handed to curl on stdin,
# never on its command line, and are never printed.
#
# Usage:
#   FUNCTION_URL=https://<id>.lambda-url.<region>.on.aws/ scripts/invoke.sh <case> [--unsigned]
#   FUNCTION_URL=https://<id>.lambda-url.<region>.on.aws/ scripts/invoke.sh --oversize
#   scripts/invoke.sh <case> --dry-run
#
#   <case>      a case of evals/cases.json, by 1-based position or by id
#   --oversize  case 1 padded with spaces to one byte over the 8 KiB cap. It is still valid JSON,
#               so only the cap can refuse it.
#   --unsigned  send without a signature. The Function URL itself answers 403.
#   --dry-run   build the body, print its size, and stop before contacting anything.
#
# Environment: FUNCTION_URL, and AWS_PROFILE (default: lab).
set -euo pipefail
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."

selector=""
oversize=0
unsigned=0
dry_run=0
for arg in "$@"; do
  case "$arg" in
    --oversize) oversize=1 ;;
    --unsigned) unsigned=1 ;;
    --dry-run) dry_run=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) selector="$arg" ;;
  esac
done
if [ "$oversize" -eq 1 ] && [ -z "$selector" ]; then selector=1; fi
if [ -z "$selector" ]; then
  sed -n '2,19p' "$self" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi

request_file=$(mktemp)
response_file=$(mktemp)
trap 'rm -f "$request_file" "$response_file"' EXIT

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

if [ "$unsigned" -eq 1 ]; then
  status=$(curl --silent --show-error \
    --header 'content-type: application/json' \
    --data-binary "@${request_file}" \
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
      --data-binary "@${request_file}" \
      --output "$response_file" --write-out '%{http_code}' \
      "$FUNCTION_URL"
  )
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_CREDENTIAL_EXPIRATION
fi

echo "HTTP ${status}"
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
  const fixed = /^ERROR_MESSAGE\s+(.+)$/m.exec(spec)[1]
  const same = Buffer.from(text, "utf8").equals(Buffer.from(fixed, "utf8"))
  // Lines as SPEC 11.1 sees them: NFC, odd spaces to plain ones, horizontal runs collapsed, trimmed.
  const lines = text
    .normalize("NFC")
    .split("\n")
    .map((line) => line.replace(/[    ⁠]/g, " ").replace(/[^\S\n]+/g, " ").trim())
  const headers = ["Qué pasa y cuándo", "Riesgos"].every((header) => lines.includes(header))
  console.log(`text equals ERROR_MESSAGE of SPEC 7, byte for byte: ${same ? "yes" : "no"}`)
  console.log(`both SPEC 4 headers on their own lines (after SPEC 11.1 normalization): ${headers ? "yes" : "no"}`)
' "$response_file"
