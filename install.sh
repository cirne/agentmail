#!/usr/bin/env bash
set -euo pipefail

# zmail installer
# Installs @cirne/zmail from GitHub Packages
# Usage: curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | bash

ZMAIL_PACKAGE="@cirne/zmail"
GITHUB_REGISTRY="https://npm.pkg.github.com"
GITHUB_SCOPE="@cirne"

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

# Check for Node.js
check_node() {
    if ! command -v node &> /dev/null; then
        error "Node.js is not installed. Please install Node.js 22+ first:\n  https://nodejs.org/"
    fi
    
    NODE_VERSION=$(node -v | sed 's/v//')
    NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
    
    if [ "$NODE_MAJOR" -lt 22 ]; then
        error "Node.js 22+ is required. You have Node.js $NODE_VERSION. Please upgrade:\n  https://nodejs.org/"
    fi
    
    success "Node.js $NODE_VERSION detected"
}

# Check for npm
check_npm() {
    if ! command -v npm &> /dev/null; then
        error "npm is not installed. Please install npm first."
    fi
    
    success "npm detected"
}

# Configure npm for GitHub Packages
configure_npm() {
    info "Configuring npm for GitHub Packages..."
    
    # Set registry for @cirne scope
    npm config set "${GITHUB_SCOPE}:registry" "${GITHUB_REGISTRY}" || \
        error "Failed to configure npm registry"
    
    success "npm configured for GitHub Packages"
}

# Check if user is authenticated
check_auth() {
    # Check if there's an auth token configured
    if npm config get "${GITHUB_SCOPE}:registry" | grep -q "${GITHUB_REGISTRY}"; then
        # Try to access the package (this will fail if not authenticated)
        if npm view "${ZMAIL_PACKAGE}" --registry="${GITHUB_REGISTRY}" &> /dev/null; then
            success "Already authenticated with GitHub Packages"
            return 0
        fi
    fi
    
    return 1
}

# Authenticate with GitHub Packages
authenticate() {
    warn "Authentication required for GitHub Packages"
    echo ""
    echo "You need a GitHub Personal Access Token (PAT) with 'read:packages' permission."
    echo ""
    echo "1. Create a token at: https://github.com/settings/tokens/new"
    echo "   - Select 'read:packages' scope"
    echo "   - Copy the token"
    echo ""
    echo "2. Run this command to authenticate:"
    echo ""
    echo "   npm login --scope=${GITHUB_SCOPE} --registry=${GITHUB_REGISTRY}"
    echo ""
    echo "   When prompted:"
    echo "   - Username: your GitHub username"
    echo "   - Password: paste your Personal Access Token"
    echo "   - Email: your GitHub email (optional)"
    echo ""
    
    read -p "Have you created a GitHub PAT? (y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        error "Please create a GitHub PAT and run the installer again"
    fi
    
    echo ""
    info "Running npm login..."
    npm login --scope="${GITHUB_SCOPE}" --registry="${GITHUB_REGISTRY}" || \
        error "Authentication failed. Please check your credentials."
    
    success "Authenticated with GitHub Packages"
}

# Install zmail
install_zmail() {
    info "Installing ${ZMAIL_PACKAGE}..."
    
    npm install -g "${ZMAIL_PACKAGE}" --registry="${GITHUB_REGISTRY}" || \
        error "Installation failed"
    
    success "Installed ${ZMAIL_PACKAGE}"
}

# Verify installation
verify_installation() {
    if command -v zmail &> /dev/null; then
        ZMAIL_VERSION=$(zmail --version 2>/dev/null || echo "installed")
        success "zmail is installed and available"
        echo ""
        echo "Run 'zmail setup' to configure your email account."
        echo "Run 'zmail --help' for usage information."
    else
        warn "zmail command not found in PATH"
        echo "You may need to add npm's global bin directory to your PATH:"
        echo "  export PATH=\"\$(npm config get prefix)/bin:\$PATH\""
    fi
}

# Main installation flow
main() {
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  zmail Installer${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    
    check_node
    check_npm
    configure_npm
    
    if ! check_auth; then
        authenticate
    fi
    
    install_zmail
    verify_installation
    
    echo ""
    success "Installation complete!"
    echo ""
}

main "$@"
