#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
exec node ./setup-family.js "$@"
