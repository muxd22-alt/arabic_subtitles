#!/data/data/com.termux/files/usr/bin/bash
# Arabic Subs — Termux bootstrap
#
# Safe to run any number of times: every step checks whether it is already
# done and says so instead of asking again, so the second run looks exactly
# like the first one.
#
# Usage: bash scripts/setup-termux.sh [--yes]
#   --yes   allow the model downloads without being asked
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WANT_YES=0
if [ "${1:-}" = "--yes" ]; then WANT_YES=1; fi

# Self-update: an old checkout on the phone runs an old copy of this script,
# so pull first and re-exec the fresh one. Offline / detached → keep going.
if [ "${ARABIC_SUBS_BOOTSTRAPPED:-0}" != "1" ] && [ -d "$ROOT/.git" ]; then
    if command -v git >/dev/null 2>&1; then
        if git -C "$ROOT" pull --ff-only >/dev/null 2>&1; then
            echo "[setup] repo updated to the latest version"
        fi
    fi
    ARABIC_SUBS_BOOTSTRAPPED=1 exec bash "$0" "$@"
fi

step() { echo; echo "[setup] $*"; }

# ── 1. storage link ────────────────────────────────────────────────────────
step "storage link"
if [ -e "$HOME/storage/shared" ]; then
    echo "[setup]   already linked — skipping (no prompt)"
else
    termux-setup-storage || true
fi

# ── 2. packages ────────────────────────────────────────────────────────────
step "packages"
export DEBIAN_FRONTEND=noninteractive
# ArabicSubs.sh already refreshed the index — don't do it twice
if [ "${ARABIC_SUBS_SKIP_UPDATE:-0}" != "1" ]; then
    pkg update -y
fi
# an upgrade is what repairs "CANNOT LINK EXECUTABLE cmake … missing symbol",
# which happens when the toolchain was built against a newer libc++
apt-get -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" upgrade || true
pkg install -y nodejs ffmpeg git

# ── 3. llama-server ────────────────────────────────────────────────────────
step "llama-server (translation engine)"
if command -v llama-server >/dev/null 2>&1; then
    echo "[setup]   already installed — skipping"
else
    pkg install -y llama-cpp || true
fi

ensure_cmake() {
    if ! command -v cmake >/dev/null 2>&1; then
        pkg install -y cmake || true
    fi
    if cmake --version >/dev/null 2>&1; then return 0; fi
    echo "[setup]   cmake cannot run (missing symbol) — reinstalling cmake + libc++"
    pkg install -y --reinstall cmake libc++ || true
    if cmake --version >/dev/null 2>&1; then return 0; fi
    echo "[setup]   upgrading the toolchain"
    pkg upgrade -y || true
    if cmake --version >/dev/null 2>&1; then return 0; fi
    echo "[setup]   FATAL: cmake is still broken."
    echo "[setup]   fix it by hand: pkg upgrade -y && pkg install -y --reinstall cmake libc++"
    exit 1
}

if ! command -v llama-server >/dev/null 2>&1; then
    step "building llama.cpp from source (this takes a while)"
    ensure_cmake
    cd "$HOME"
    rm -rf llama.cpp
    git clone --depth 1 https://github.com/ggml-org/llama.cpp.git
    cd llama.cpp
    cmake -B build -DGGML_NATIVE=ON -DLLAMA_CURL=OFF
    cmake --build build --config Release -j "$(nproc)"
    ln -sf "$HOME/llama.cpp/build/bin/llama-server" "$PREFIX/bin/llama-server"
    cd "$HOME"
fi

# ── 4. whisper (audio path) ────────────────────────────────────────────────
step "whisper.cpp (audio path)"
if command -v whisper-cli >/dev/null 2>&1 || command -v whisper >/dev/null 2>&1; then
    echo "[setup]   already installed — skipping"
else
    ensure_cmake
    cd "$HOME"
    rm -rf whisper.cpp
    git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git
    cd whisper.cpp
    cmake -B build -DGGML_NATIVE=ON
    cmake --build build --config Release -j "$(nproc)"
    if [ -x "$HOME/whisper.cpp/build/bin/whisper-cli" ]; then
        ln -sf "$HOME/whisper.cpp/build/bin/whisper-cli" "$PREFIX/bin/whisper-cli"
    else
        ln -sf "$HOME/whisper.cpp/build/bin/whisper" "$PREFIX/bin/whisper"
    fi
    cd "$HOME"
fi

echo
echo "[setup] toolchain:"
for tool in node ffmpeg ffprobe llama-server; do
    printf '  %-14s %s\n' "$tool" "$(command -v "$tool" || echo 'NOT FOUND')"
done
printf '  %-14s %s\n' "whisper" "$(command -v whisper-cli || command -v whisper || echo 'NOT FOUND')"

# ── 5. models — only with the user's permission ────────────────────────────
step "models (Hy-MT2 440 MB + whisper 150 MB)"
echo "[setup]   Hy-MT2 model card: https://huggingface.co/tencent/Hy-MT2-1.8B"
echo "[setup]   both models feed ONE engine: subtitles and audio alike"
echo "[setup]   stored in: \$HOME/.arabic-subs/models (download once, reused forever)"

ANSWER=""
if [ "$WANT_YES" -eq 1 ]; then
    ANSWER=y
elif [ -t 0 ]; then
    printf '[setup]   Download now? [y/N] '
    read -r ANSWER || ANSWER=""
elif [ -r /dev/tty ]; then
    # `curl … | bash` leaves stdin as a pipe — ask on the terminal itself
    printf '[setup]   Download now? [y/N] ' > /dev/tty
    read -r ANSWER < /dev/tty || ANSWER=""
else
    echo "[setup]   not a terminal — nothing downloaded."
fi

case "$ANSWER" in
    y|Y|yes|YES)
        npm install -g "$ROOT" || true
        if command -v arabic-subs >/dev/null 2>&1; then
            arabic-subs setup
        else
            node "$ROOT/bin/arabic-subs.js" setup
        fi
        ;;
    *)
        echo "[setup]   models skipped. Download them later with:"
        echo "[setup]     node bin/arabic-subs.js setup"
        echo "[setup]   (run will ask again before downloading)"
        ;;
esac

echo
echo "[setup] done. Start the engine with:"
echo "  node bin/arabic-subs.js run --media /sdcard/Movies"
