#!/data/data/com.termux/files/usr/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  Arabic Subs — everything, in one file
#
#      pkg install -y curl; curl -fsSL -o ArabicSubs.sh https://raw.githubusercontent.com/muxd22-alt/arabic_subtitles/main/ArabicSubs.sh; bash ArabicSubs.sh
#
#  1. packages        2. code (clone or update)   3. npm deps
#  4. engines (llama-server + whisper, downloaded prebuilt)   5. models (asks first)
#
#  Safe to run again: every step reports "already …" instead of asking twice.
#  If anything fails it says where, and re-running resumes from that step.
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

REPO="https://github.com/muxd22-alt/arabic_subtitles.git"
DIR="$HOME/arabic_subtitles"
export DEBIAN_FRONTEND=noninteractive

step() { echo; echo "[ArabicSubs] $*"; }

fail() {
    echo
    echo "[ArabicSubs] FAILED at line $1."
    echo "[ArabicSubs] Re-run the same line — it resumes where it stopped:"
    echo "  bash ArabicSubs.sh"
}
trap 'fail $LINENO' ERR

step "1/5  packages (git, nodejs, ffmpeg, debianutils)"
pkg update -y || echo "[ArabicSubs] warning: the package index had errors — continuing"
pkg install -y git nodejs ffmpeg debianutils

step "2/5  code — clone first time, sync latest every time after"
if [ -d "$DIR/.git" ]; then
    echo "[ArabicSubs] updating checkout to latest..."
    rm -f "$DIR/ArabicSubs.sh"
    rm -rf "$DIR/arabic_subtitles"
    git -C "$DIR" fetch origin main || true
    git -C "$DIR" reset --hard origin/main || git -C "$DIR" pull --ff-only || true
else
    rm -rf "$DIR"
    git clone "$REPO" "$DIR"
fi
cd "$DIR"

step "3/5  node dependencies"
npm install || echo "[ArabicSubs] warning: npm install reported errors — continuing"

step "4/5  llama-server + whisper (both downloaded prebuilt — nothing compiled on the phone)"
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
