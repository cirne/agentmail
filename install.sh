#!/usr/bin/env bash
set -euo pipefail

# zmail installer
# Installs @cirne/zmail from npm
# Usage: npm install -g @cirne/zmail
# Or if you have the install script locally: bash install.sh

ZMAIL_PACKAGE="@cirne/zmail"

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

# Check for Node.js (package engines: >=22.16.0 — node:sqlite + FTS5 in bundled SQLite)
check_node() {
    if ! command -v node &> /dev/null; then
        error "Node.js is not installed. Please install Node.js 22.16+ first:\n  https://nodejs.org/"
    fi
    
    NODE_VERSION=$(node -v | sed 's/^v//')
    NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
    NODE_MINOR=$(echo "$NODE_VERSION" | cut -d. -f2)
    NODE_MINOR=${NODE_MINOR:-0}

    if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 16 ]; }; then
        error "Node.js 22.16+ is required (built-in node:sqlite with FTS5). You have Node.js $NODE_VERSION. Please upgrade:\n  https://nodejs.org/"
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

# Install zmail
install_zmail() {
    info "Installing ${ZMAIL_PACKAGE}..."
    
    npm install -g "${ZMAIL_PACKAGE}" || \
        error "Installation failed"
    
    success "Installed ${ZMAIL_PACKAGE}"
}

# Get npm global bin directory
get_npm_bin_dir() {
    npm config get prefix | xargs -I {} echo "{}/bin"
}

# Check if directory is on PATH
is_on_path() {
    local dir="$1"
    echo "$PATH" | tr ':' '\n' | grep -Fxq "$dir"
}

# Detect shell profile file
detect_shell_profile() {
    if [ -n "${ZSH_VERSION:-}" ]; then
        echo "$HOME/.zshrc"
    elif [ -n "${BASH_VERSION:-}" ]; then
        if [ -f "$HOME/.bash_profile" ]; then
            echo "$HOME/.bash_profile"
        else
            echo "$HOME/.bashrc"
        fi
    else
        echo "$HOME/.profile"
    fi
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
        echo ""
        
        NPM_BIN_DIR=$(get_npm_bin_dir)
        info "npm installed zmail to: $NPM_BIN_DIR"
        
        if [ -f "$NPM_BIN_DIR/zmail" ]; then
            success "Binary exists at $NPM_BIN_DIR/zmail"
        else
            error "Binary not found at expected location: $NPM_BIN_DIR/zmail"
        fi
        
        echo ""
        if is_on_path "$NPM_BIN_DIR"; then
            warn "$NPM_BIN_DIR is on PATH, but zmail command not found"
            echo "This may be a shell caching issue. Try:"
            echo "  hash -r  # bash"
            echo "  rehash   # zsh"
        else
            warn "$NPM_BIN_DIR is not on your PATH"
            echo ""
            echo "Add this to your shell profile to make zmail available:"
            echo ""
            SHELL_PROFILE=$(detect_shell_profile)
            echo "  echo 'export PATH=\"$NPM_BIN_DIR:\$PATH\"' >> $SHELL_PROFILE"
            echo ""
            echo "Then reload your shell:"
            echo "  source $SHELL_PROFILE"
            echo ""
            echo "Or run this command now (temporary for current session):"
            echo "  export PATH=\"$NPM_BIN_DIR:\$PATH\""
        fi
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
    install_zmail
    verify_installation
    
    echo ""
    success "Installation complete!"
    echo ""
}

main "$@"
