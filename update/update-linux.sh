#!/bin/bash
cd "$(dirname "$0")/.."
git pull --recurse-submodules
read -rp "Press Enter to continue..."
