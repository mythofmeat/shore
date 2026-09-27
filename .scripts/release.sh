#!/usr/bin/bash

source "$(git rev-parse --show-toplevel)/.scripts/tools/tools.sh"

release_and_package "$1"
