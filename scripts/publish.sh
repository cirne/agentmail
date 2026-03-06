#!/usr/bin/env bash
set -euo pipefail

# Publish script for @cirne/zmail
# Generates timestamp-based version, builds, and publishes to npm

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

error() {
    echo -e "${RED}Error:${NC} $1" >&2
    exit 1
}

info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

success() {
    echo -e "${GREEN}✓${NC} $1"
}

warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# Get base version from package.json
BASE_VERSION=$(node -p "require('./package.json').version" | sed 's/-alpha.*//')

# Generate timestamp-based version
TIMESTAMP=$(date -u +"%Y%m%d.%H%M%S")
VERSION="${BASE_VERSION}-alpha.${TIMESTAMP}"

# Determine dist tag (default: latest for main branch, or use --tag flag)
DIST_TAG="${1:-latest}"

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Publishing @cirne/zmail${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
info "Base version: $BASE_VERSION"
info "Generated version: $VERSION"
info "Dist tag: $DIST_TAG"
echo ""

# Check if logged in to npm
if ! npm whoami &> /dev/null; then
    error "Not logged in to npm. Run 'npm login' first."
fi

NPM_USER=$(npm whoami)
success "Logged in as: $NPM_USER"
echo ""

# Update version in package.json
info "Updating package.json version to $VERSION..."
npm pkg set version="$VERSION" || error "Failed to update version"
success "Version updated"
echo ""

# Build
info "Building TypeScript..."
npm run build || error "Build failed"
success "Build complete"
echo ""

# Check if version already exists
if npm view "@cirne/zmail@$VERSION" version &> /dev/null; then
    error "Version $VERSION already exists on npm. Wait a moment and try again."
fi

# Publish
info "Publishing @cirne/zmail@$VERSION to npm..."
if npm publish --access public --tag="$DIST_TAG"; then
    success "Published @cirne/zmail@$VERSION with tag '$DIST_TAG'"
    echo ""
    echo "Package available at: https://www.npmjs.com/package/@cirne/zmail"
    echo ""
    echo "Install with:"
    echo "  npm install -g @cirne/zmail"
    echo ""
else
    error "Publish failed"
fi
