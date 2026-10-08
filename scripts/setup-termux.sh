#!/data/data/com.termux/files/usr/bin/bash
# Arabic Subs — Termux bootstrap
# Installs every system dependency, then runs `arabic-subs setup`
# (model downloads + status check).
set -euo pipefail

echo "[setup] updating package index…"
pkg update -y

echo "[setup] installing runtime packages…"
pkg install -y nodejs ffmpeg

# llama-server: llama-cpp ships the server binary in Termux (v0.6.0+).
# Older mirrors may lack it — fall back to building llama.cpp from source.
if ! command -v llama-server >/dev/null 2>&1; then
    echo "[setup] llama-cpp package missing llama-server, installing pkg…"
    pkg install -y llama-cpp || true
fi

if ! command -v llama-server >/dev/null 2>&1; then
    echo "[setup] building llama.cpp from source (this takes a while)…"
    pkg install -y git cmake clang
    cd "$HOME"
    rm -rf llama.cpp
    git clone --depth 1 https://github.com/ggml-org/llama.cpp.git
    cd llama.cpp
    cmake -B build -DGGML_NATIVE=ON -DLLAMA_CURL=OFF
    cmake --build build --config Release -j "$(nproc)"
    ln -sf "$HOME/llama.cpp/build/bin/llama-server" "$PREFIX/bin/llama-server"
    cd "$HOME"
fi

# whisper.cpp is not packaged for Termux → build it for the audio path.
if ! command -v whisper-cli >/dev/null 2>&1 && ! command -v whisper >/dev/null 2>&1; then
    echo "[setup] building whisper.cpp from source…"
    pkg install -y git cmake clang
    cd "$HOME"
    rm -rf whisper.cpp
    git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git
    cd whisper.cpp
    cmake -B build -DGGML_NATIVE=ON
    cmake --build build --config Release -j "$(nproc)"
    ln -sf "$HOME/whisper.cpp/build/bin/whisper-cli" "$PREFIX/bin/whisper-cli" 2>/dev/null || \
        ln -sf "$HOME/whisper.cpp/build/bin/whisper" "$PREFIX/bin/whisper"
    cd "$HOME"
fi

echo
echo "[setup] toolchain ready:"
for tool in node ffmpeg ffprobe llama-server; do
    printf '  %-14s %s\n' "$tool" "$(command -v "$tool" || echo 'NOT FOUND')"
done
printf '  %-14s %s\n' "whisper" "$(command -v whisper-cli || command -v whisper || echo 'NOT FOUND')"

echo
echo "[setup] downloading the Hy-MT2 model (~440 MB) + whisper model…"
npm install -g . 2>/dev/null || npm install -g "$(dirname "$0")/.."
arabic-subs setup

echo
echo "[setup] done. Start the engine with:"
echo "  arabic-subs run --media /sdcard/Movies"
