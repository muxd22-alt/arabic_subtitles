#!/data/data/com.termux/files/usr/bin/bash
# Arabic Subs — one-line bootstrap
#
#   curl -fsSL https://raw.githubusercontent.com/muxd22-alt/arabic_subtitles/main/scripts/bootstrap.sh | bash
#
# Works on a fresh Termux and on an existing checkout: installs the packages,
# clones or updates the project, then hands over to setup-termux.sh which
# repairs a broken cmake, builds/installs llama-server + whisper, and asks
# permission before downloading the models.
set -euo pipefail

REPO="https://github.com/muxd22-alt/arabic_subtitles.git"
DIR="$HOME/arabic_subtitles"

echo "[bootstrap] packages (git, nodejs, ffmpeg)"
export DEBIAN_FRONTEND=noninteractive
pkg update -y
pkg install -y git nodejs ffmpeg

if [ -d "$DIR/.git" ]; then
    echo "[bootstrap] existing checkout — updating"
    git -C "$DIR" pull --ff-only || true
else
    echo "[bootstrap] cloning the project"
    rm -rf "$DIR"
    git clone "$REPO" "$DIR"
fi

echo "[bootstrap] running the full setup"
ARABIC_SUBS_SKIP_UPDATE=1 exec bash "$DIR/scripts/setup-termux.sh" "$@"
