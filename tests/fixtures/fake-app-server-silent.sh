#!/bin/sh
# Fake app-server: consumes stdin forever, never answers. Ignores argv.
exec cat > /dev/null
