#!/data/data/com.termux/files/usr/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  Arabic Subs — everything, in one file
#
#      pkg install -y curl; curl -fsSL -o ArabicSubs.sh https://raw.githubusercontent.com/muxd22-alt/arabic_subtitles/main/ArabicSubs.sh; bash ArabicSubs.sh
#
#  1. packages        2. code (clone or update)   3. npm deps
#  4. llama-server + whisper + cmake repair       5. models (asks first)
#
#  Safe to run again: every step reports "already …" instead of asking twice.
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

REPO="https://github.com/muxd22-alt/arabic_subtitles.git"
DIR="$HOME/arabic_subtitles"
export DEBIAN_FRONTEND=noninteractive

step() { echo; echo "[ArabicSubs] $*"; }

step "1/5  packages (git, nodejs, ffmpeg)"
pkg update -y
pkg install -y git nodejs ffmpeg

step "2/5  code — clone first time, git pull every time after"
if [ -d "$DIR/.git" ]; then
    git -C "$DIR" pull --ff-only || true
else
    rm -rf "$DIR"
    git clone "$REPO" "$DIR"
fi
cd "$DIR"

step "3/5  node dependencies"
npm install

step "4/5  llama-server + whisper (+ cmake repair if the toolchain is broken)"
ARABIC_SUBS_SKIP_UPDATE=1 bash scripts/setup-termux.sh

step "5/5  done"
echo
echo "  Now open the Arabic Subs app:"
echo "    1. add your Movies / TV Shows folder(s)"
echo "    2. press start — the engine runs through Termux"
echo
echo "  Start it by hand instead:"
echo "    cd ~/arabic_subtitles && node bin/arabic-subs.js run --media /sdcard/Movies"
echo
