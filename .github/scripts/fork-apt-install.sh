#!/usr/bin/env bash
# Fork-only: installs apt packages within a fixed time, so a stalled mirror fails the job
# with a log instead of running into the step timeout. See docs/operations/fork.md.
set -uo pipefail

# The four calls together stay under the 10-minute step that waits for this script.
apt_get() {
  local limit=$1
  shift
  sudo timeout --kill-after=10 "$limit" apt-get \
    -o Acquire::Retries=3 \
    -o Acquire::http::Timeout=20 \
    -o Acquire::https::Timeout=20 \
    -o DPkg::Lock::Timeout=60 \
    "$@"
}

# Upstream's update skips translations, DEP-11 metadata and command-not-found indexes.
update_opts=(-o Acquire::Languages=none
  -o Acquire::IndexTargets::deb::DEP-11::DefaultEnabled=false
  -o Acquire::IndexTargets::deb::CNF::DefaultEnabled=false)

apt_get 90 "${update_opts[@]}" update && apt_get 150 install -y "$@" && exit

echo "fork-apt-install: failed with the runner's mirrors; retrying with mirrors.edge.kernel.org"
# A mirror outside ubuntu.com: the runner's mirrors and archive.ubuntu.com share that DNS zone.
sudo sed -i -E 's#^URIs: .*#URIs: https://mirrors.edge.kernel.org/ubuntu/#' /etc/apt/sources.list.d/ubuntu.sources
# Reads only the Ubuntu sources, so a stalled third-party repository cannot fail the retry.
apt_get 90 "${update_opts[@]}" -o APT::Update::Error-Mode=any \
  -o Dir::Etc::sourcelist=sources.list.d/ubuntu.sources -o Dir::Etc::sourceparts=- update &&
  apt_get 150 install -y "$@"
