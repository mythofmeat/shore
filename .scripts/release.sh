#!/usr/bin/bash

source "$(git rev-parse --show-toplevel)/.scripts/tools/tools.sh"

current_versions || exit 1
new_version=$(version_increment "$1")
bump_version_to $new_version
release_gh
