#!/usr/bin/bash
cd "$(dirname "$0")"

source "$(git rev-parse --show-toplevel)/.scripts/tools/tools.sh"

unattended_upgrade
