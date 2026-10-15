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
        rm -f "$ROOT/ArabicSubs.sh"
        rm -rf "$ROOT/arabic_subtitles"
        if git -C "$ROOT" fetch origin main >/dev/null 2>&1 && git -C "$ROOT" reset --hard origin/main >/dev/null 2>&1; then
            echo "[setup] repo updated to the latest version"
        elif git -C "$ROOT" pull --ff-only >/dev/null 2>&1; then
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
pkg install -y nodejs ffmpeg git debianutils curl unzip

# ── 3. llama-server ────────────────────────────────────────────────────────
step "llama-server (translation engine)"
# The shipped model is a standard, ordinary quant (Q4_K_M), so any recent
# llama.cpp reads it and the engine no longer needs a pinned fork commit. Only
# the opt-in extreme-bit flavour (HYMT_MODEL_FLAVOR=stq — the 440 MB 1.25-bit
# file) needs the STQ1_0 kernel from the llama.cpp fork of PR #22836.
#
# Two ways to get the engine, in order of cost:
#   1. the prebuilt arm64 binary published with this repo — cross-compiled with
#      the Android NDK (static libc++, no external .so, 16KB-page ready), 16 MB
#      and a few seconds instead of a 15-40 minute compile that can also die on
#      a phone (we have seen it segfault before it ever printed a version);
#   2. building on the phone — the fallback for when the download is blocked,
#      the phone is not arm64, or the archive is damaged.
MODEL_FLAVOR="${HYMT_MODEL_FLAVOR:-q4_k_m}"
if [ "$MODEL_FLAVOR" = "stq" ]; then
    LLAMA_REPO="${ARABIC_SUBS_LLAMA_REPO:-https://github.com/sjl623/llama.cpp}"
    LLAMA_BRANCH="${ARABIC_SUBS_LLAMA_BRANCH:-STQ_0}"
    LLAMA_PIN="1e411d8f5a1e23525fa3265dfb4bd76265465397"
    LLAMA_WHY="the STQ1_0 kernel (llama.cpp PR #22836)"
else
    LLAMA_REPO="${ARABIC_SUBS_LLAMA_REPO:-https://github.com/ggml-org/llama.cpp}"
    LLAMA_BRANCH="${ARABIC_SUBS_LLAMA_BRANCH:-master}"
    LLAMA_PIN=""
    LLAMA_WHY="the stock engine (a standard quant needs no fork)"
fi
LLAMA_STAMP="$HOME/.arabic-subs/llama-engine.sha"

# The prebuilt: a release asset, so the URL is immutable and a fresh install
# never downloads half of somebody else's build. Bump the tag + sha together.
# Since 2.2 the engine ships from the app release itself (`v2.2`), so there is a
# single release carrying both the APK and the engines (llama-server +
# whisper-cli) — nothing is compiled on the phone unless the download fails.
LLAMA_PREBUILT_TAG="${ARABIC_SUBS_PREBUILT_TAG:-v2.2}"
LLAMA_PREBUILT_URL="${ARABIC_SUBS_PREBUILT_URL:-https://github.com/muxd22-alt/arabic_subtitles/releases/download/$LLAMA_PREBUILT_TAG/arabic-subs-engine-android-arm64.zip}"
LLAMA_PREBUILT_SHA256="${ARABIC_SUBS_PREBUILT_SHA256:-42585d0b08b9156f28f06f9571f978b4d7fb1cba6f3763d7d37663b979e0756c}"
LLAMA_PREBUILT_DIR="${ARABIC_SUBS_PREBUILT_DIR:-$HOME/.arabic-subs/engine}"
LLAMA_PREBUILT_STAMP="$HOME/.arabic-subs/llama-prebuilt.sha"

llama_source_ready() {
    [ -s "$LLAMA_STAMP" ] || return 1
    [ "$(cat "$LLAMA_STAMP")" = "${LLAMA_PIN:-$LLAMA_BRANCH}" ] || return 1
    [ -x "$HOME/llama.cpp/build/bin/llama-server" ] || return 1
    return 0
}

# a binary that answers --version is a binary that can run: this is the check
# that catches a damaged download or a CPU the build does not fit, before the
# engine is ever asked to load the model
prebuilt_works() {
    [ -x "$LLAMA_PREBUILT_DIR/llama-server" ] || return 1
    "$LLAMA_PREBUILT_DIR/llama-cli" --version >/dev/null 2>&1
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | cut -d' ' -f1
    else
        echo ""
    fi
}

install_llama_prebuilt() {
    if [ "$(uname -m)" != "aarch64" ] && [ "$(uname -m)" != "arm64" ]; then
        echo "[setup]   this prebuilt is android-arm64 only (this phone: $(uname -m))"
        return 1
    fi
    echo "[setup]   downloading the prebuilt engine (16 MB, no compiling)"
    mkdir -p "$(dirname "$LLAMA_PREBUILT_STAMP")"
    rm -rf "$LLAMA_PREBUILT_DIR"
    mkdir -p "$LLAMA_PREBUILT_DIR"
    if ! curl -fL --retry 3 --connect-timeout 30 -o "$LLAMA_PREBUILT_DIR/engine.zip" "$LLAMA_PREBUILT_URL"; then
        echo "[setup]   the download failed"
        return 1
    fi
    if ! command -v unzip >/dev/null 2>&1; then
        pkg install -y unzip >/dev/null 2>&1 || true
    fi
    if ! unzip -oq "$LLAMA_PREBUILT_DIR/engine.zip" -d "$LLAMA_PREBUILT_DIR"; then
        echo "[setup]   the archive would not open"
        return 1
    fi
    got="$(sha256_of "$LLAMA_PREBUILT_DIR/engine.zip")"
    if [ -n "$LLAMA_PREBUILT_SHA256" ] && [ -n "$got" ] && [ "$got" != "$LLAMA_PREBUILT_SHA256" ]; then
        echo "[setup]   the archive is not the one this setup expects (sha256 $got)"
        rm -rf "$LLAMA_PREBUILT_DIR"
        return 1
    fi
    rm -f "$LLAMA_PREBUILT_DIR/engine.zip"
    chmod +x "$LLAMA_PREBUILT_DIR"/llama-server "$LLAMA_PREBUILT_DIR"/llama-cli 2>/dev/null || true
    if [ -f "$LLAMA_PREBUILT_DIR/whisper-cli" ]; then
        chmod +x "$LLAMA_PREBUILT_DIR/whisper-cli" 2>/dev/null || true
    fi
    if ! prebuilt_works; then
        echo "[setup]   the downloaded binary does not run here"
        rm -rf "$LLAMA_PREBUILT_DIR"
        return 1
    fi
    ln -sf "$LLAMA_PREBUILT_DIR/llama-server" "$PREFIX/bin/llama-server" || true
    if [ -x "$LLAMA_PREBUILT_DIR/whisper-cli" ] && [ -x "$PREFIX/bin/whisper-cli" -o -w "$PREFIX/bin" ]; then
        ln -sf "$LLAMA_PREBUILT_DIR/whisper-cli" "$PREFIX/bin/whisper-cli" || true
    fi
    echo "$LLAMA_PREBUILT_TAG" > "$LLAMA_PREBUILT_STAMP"
    return 0
}

llama_prebuilt_ready() {
    [ -s "$LLAMA_PREBUILT_STAMP" ] || return 1
    [ "$(cat "$LLAMA_PREBUILT_STAMP")" = "$LLAMA_PREBUILT_TAG" ] || return 1
    prebuilt_works
}

link_llama() {
    # keep whichever engine we have in front of any packaged binary on PATH
    if prebuilt_works; then
        ln -sf "$LLAMA_PREBUILT_DIR/llama-server" "$PREFIX/bin/llama-server" 2>/dev/null || true
    elif llama_source_ready; then
        ln -sf "$HOME/llama.cpp/build/bin/llama-server" "$PREFIX/bin/llama-server" 2>/dev/null || true
    fi
}

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

build_llama_from_source() {
    step "building llama-server from source ($LLAMA_WHY)"
    echo "[setup]   this is the fallback: 15 to 40 minutes on a phone, once."
    ensure_cmake
    mkdir -p "$(dirname "$LLAMA_STAMP")"
    cd "$HOME"
    rm -rf llama.cpp
    git clone --depth 1 --branch "$LLAMA_BRANCH" "$LLAMA_REPO" llama.cpp
    cd llama.cpp
    llama_head="$(git rev-parse HEAD 2>/dev/null || true)"
    if [ -n "$LLAMA_PIN" ] && [ -n "$llama_head" ] && [ "$llama_head" != "$LLAMA_PIN" ]; then
        echo "[setup]   note: $LLAMA_BRANCH has moved past the tested commit — using the branch tip"
    fi
    cmake -B build -DGGML_NATIVE=ON -DLLAMA_CURL=OFF
    cmake --build build --config Release -j "$(nproc)"
    if [ ! -x "$HOME/llama.cpp/build/bin/llama-server" ]; then
        echo "[setup]   FATAL: the build produced no llama-server binary."
        exit 1
    fi
    # keep the source build in front of any packaged binary on PATH
    ln -sf "$HOME/llama.cpp/build/bin/llama-server" "$PREFIX/bin/llama-server"
    echo "${LLAMA_PIN:-$LLAMA_BRANCH}" > "$LLAMA_STAMP"
    cd "$HOME"
}

if [ "${ARABIC_SUBS_FORCE_LLAMA_BUILD:-0}" = "1" ]; then
    echo "[setup]   ARABIC_SUBS_FORCE_LLAMA_BUILD=1 — building on the phone"
    build_llama_from_source
elif llama_prebuilt_ready; then
    echo "[setup]   prebuilt engine already installed ($LLAMA_PREBUILT_TAG) — skipping"
    link_llama
elif [ "${ARABIC_SUBS_SKIP_LLAMA_BUILD:-0}" = "1" ]; then
    echo "[setup]   llama-server install skipped (ARABIC_SUBS_SKIP_LLAMA_BUILD=1)"
else
    if install_llama_prebuilt; then
        echo "[setup]   prebuilt engine installed — the 15-40 minute build is not needed"
    else
        echo "[setup]   the prebuilt could not be installed; building $LLAMA_WHY instead"
        build_llama_from_source
    fi
fi

# ── 4. whisper (audio path) ────────────────────────────────────────────────
# whisper-cli rides in the same prebuilt zip as llama-server, so this normally
# has nothing to do. The clone below is the fallback for when that download
# failed (or the device is not arm64).
step "whisper.cpp (audio path)"
if command -v whisper-cli >/dev/null 2>&1 || command -v whisper >/dev/null 2>&1; then
    echo "[setup]   already installed — skipping"
else
    echo "[setup]   building whisper from source — the prebuilt archive had no whisper-cli"
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
step "models (translation + whisper)"

models_ready() {
    node -e 'const m=require(process.argv[1]);process.exit(m.modelStatus().state==="ready"&&m.whisperStatus().state==="ready"?0:1)' \
        "$ROOT/src/model.js" 2>/dev/null
}

if models_ready; then
    echo "[setup]   both models already present — nothing to download"
else
MODEL_LABEL="$(node -e 'process.stdout.write(require(process.argv[1]).MODEL_LABEL)' "$ROOT/src/config.js" 2>/dev/null || echo 'Hy-MT2 1.8B Q4_K_M')"
MODEL_REPO="$(node -e 'process.stdout.write(require(process.argv[1]).MODEL_REPO)' "$ROOT/src/config.js" 2>/dev/null || echo 'https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF')"
echo "[setup]   flavour: $MODEL_LABEL"
echo "[setup]   model card: $MODEL_REPO"
echo "[setup]   both models feed ONE engine: subtitles and audio alike"
echo "[setup]   stored in: \$HOME/.arabic-subs/models (download once, reused forever)"

# The extreme-bit GGUFs (1.25-bit STQ1_0 and 2-bit Stride16) abort on a stock
# llama.cpp. Drop them so the standard file is fetched instead — unless the user
# explicitly asked for the STQ1_0 flavour, in which case that file is the point.
if [ "$MODEL_FLAVOR" != "stq" ]; then
    for stale in Hy-MT2-1.8B-1.25Bit.gguf Hy-MT1.5-1.8B-1.25bit.gguf; do
        if [ -f "$HOME/.arabic-subs/models/$stale" ]; then
            echo "[setup]   removing the unreadable $stale ($(du -h "$HOME/.arabic-subs/models/$stale" | cut -f1))"
            rm -f "$HOME/.arabic-subs/models/$stale"
        fi
    done
fi

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
        # Always go through the repo copy: the global shim in $PREFIX/bin is not
        # always executable on Termux, and "Permission denied" used to abort
        # the whole setup before the models were fetched.
        node "$ROOT/bin/arabic-subs.js" setup
        ;;
    *)
        echo "[setup]   models skipped. Download them later with:"
        echo "[setup]     node bin/arabic-subs.js setup"
        echo "[setup]   (run will ask again before downloading)"
        ;;
esac
fi

echo
echo "[setup] done. Start the engine with:"
echo "  node bin/arabic-subs.js run --media /sdcard/Movies"
