#!/bin/bash
# Packages the ghosthunter CLI for distribution.
#
#   ./Scripts/release.sh <version>        e.g. ./Scripts/release.sh 1.0.0
#
# Unlike chapterize and quicksubs, this is not a compiled binary. GhostHunter
# ships as TypeScript sources run directly by Node 26, so there is nothing to
# codesign and nothing to notarize: Gatekeeper only applies to Mach-O binaries,
# and Homebrew installs skip quarantine anyway.
#
# Output: build/ghosthunter-<version>.zip, ready to attach to a GitHub release.
# Prints the sha256 for the Homebrew formula.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?Usage: ./Scripts/release.sh <version>}"
ZIP_PATH="build/ghosthunter-${VERSION}.zip"

PKG_VERSION=$(node -p "require('./package.json').version")
if [[ "$PKG_VERSION" != "$VERSION" ]]; then
  echo "package.json says $PKG_VERSION but you asked for $VERSION." >&2
  echo "Update package.json and the VERSION constant in src/cli.ts first." >&2
  exit 1
fi

CLI_VERSION=$(node bin/ghosthunter.ts --version)
if [[ "$CLI_VERSION" != "$VERSION" ]]; then
  echo "The CLI reports $CLI_VERSION but you asked for $VERSION." >&2
  echo "Update the VERSION constant in src/cli.ts." >&2
  exit 1
fi

echo "Running tests..."
npm test

echo "Packaging ghosthunter ${VERSION}..."
mkdir -p build
rm -f "$ZIP_PATH"

# Everything the formula installs. No node_modules, because there are none.
zip -q -r "$ZIP_PATH" bin src package.json README.md LICENSE

SHA256=$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')
echo ""
echo "Done: $ZIP_PATH"
echo "  sha256: $SHA256"
echo ""
echo "Next steps:"
echo "  1. Create a GitHub release with human-readable notes and attach the zip."
echo "  2. Update Formula/ghosthunter.rb in homebrew-tap with the URL and sha256."
