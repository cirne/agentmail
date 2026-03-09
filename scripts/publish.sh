#!/usr/bin/env bash
set -euo pipefail

# Publish script for @cirne/zmail
# Generates timestamp-based version, builds, and publishes to npm

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

# Store original version for rollback
ORIGINAL_VERSION=$(node -p "require('./package.json').version" | sed 's/-alpha.*//')

# Rollback function to restore package.json version on failure
rollback_version() {
    if [ -n "${ORIGINAL_VERSION:-}" ]; then
        warn "Rolling back package.json version to $ORIGINAL_VERSION"
        npm pkg set version="$ORIGINAL_VERSION" || true
    fi
}

# Set trap to rollback on error or exit
trap rollback_version ERR EXIT

# Get base version from package.json (use original if available, otherwise read current)
BASE_VERSION="${ORIGINAL_VERSION:-$(node -p "require('./package.json').version" | sed 's/-alpha.*//')}"

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
    # Clear trap on success (don't rollback)
    trap - ERR EXIT
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
