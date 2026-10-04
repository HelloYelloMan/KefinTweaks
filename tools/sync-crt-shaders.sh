#!/bin/sh
# Copies the mpv retro CRT chain into scripts/crt/ for the CRT Shader feature
# (scripts/crtShader.js), which runs those files in WebGL2 unmodified.
#
# The mpv config is the source of truth: retro.conf supplies the profiles
# (glsl-shaders lists and glsl-shader-opts), and the .glsl files are copied
# byte for byte. They get a .txt suffix only because Jellyfin's static file
# server 404s extensions it does not know, such as .glsl and .conf.
#
# Run after changing the mpv shaders or retro.conf, then deploy scripts/crt/.
set -eu
MPV="${MPV_CONFIG:-$HOME/.config/mpv}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/scripts/crt"

cp "$MPV/retro.conf" "$DEST/retro.conf.txt"
for f in "$MPV"/shaders/retro/*.glsl; do
    cp "$f" "$DEST/$(basename "$f").txt"
done
ls -l "$DEST"
