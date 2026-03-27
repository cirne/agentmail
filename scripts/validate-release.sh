#!/usr/bin/env bash
# Quick validation for install script and package config before release
# Run this before pushing or running scripts/publish.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

errors=0

check() {
    local description="$1"
    shift
    if "$@" >/dev/null 2>&1; then
        success "$description"
    else
        error "$description" || true  # Don't exit on check failure
        ((errors++))
    fi
}

section "Release Validation Checklist"

# Install script checks
section "Install Script"
check "install.sh syntax valid" bash -n "$REPO_ROOT/install.sh"
check "install.sh is executable" [ -x "$REPO_ROOT/install.sh" ]
check "install.sh references npm package" grep -q "@cirne/zmail" "$REPO_ROOT/install.sh"

# Package.json checks
section "Package Configuration"
check "package.json exists" [ -f "$REPO_ROOT/package.json" ]
check "package name is @cirne/zmail" grep -q '"name": "@cirne/zmail"' "$REPO_ROOT/package.json"
check "bin field configured" bash -c "grep -q '\"bin\"' '$REPO_ROOT/package.json' && grep -q '\"zmail\"' '$REPO_ROOT/package.json'"
check "Node.js 20+ required" bash -c "grep -q '\"engines\"' '$REPO_ROOT/package.json' && grep -q '\"node\"' '$REPO_ROOT/package.json' && grep -q '>=20' '$REPO_ROOT/package.json'"

# Documentation checks
section "Documentation"
check "AGENTS.md exists" [ -f "$REPO_ROOT/AGENTS.md" ]
check "install.sh in AGENTS.md" grep -q "install.sh" "$REPO_ROOT/AGENTS.md" || echo -e "${YELLOW}⚠${NC} install.sh not mentioned in AGENTS.md"
check "OPP-007 doc exists" [ -f "$REPO_ROOT/docs/opportunities/archive/OPP-007-packaging-npm-homebrew.md" ]

# Git checks
section "Git Status"
if [ -d "$REPO_ROOT/.git" ]; then
    cd "$REPO_ROOT"
    if git diff --quiet install.sh package.json 2>/dev/null; then
        echo -e "${GREEN}✓${NC} No uncommitted changes to release files"
    else
        echo -e "${YELLOW}⚠${NC} Uncommitted changes detected (this is OK for testing)"
    fi
else
    echo -e "${YELLOW}⚠${NC} Not a git repository"
fi

# Summary
section "Summary"
if [ $errors -eq 0 ]; then
    echo -e "${GREEN}All checks passed!${NC}"
    echo ""
    echo "Ready to push. Next steps:"
    echo "1. git push origin main"
    echo "2. Monitor GitHub Actions (if repo is public)"
    echo "3. Check package: https://www.npmjs.com/package/@cirne/zmail"
    echo "4. Test install: npm install -g @cirne/zmail"
    exit 0
else
    echo -e "${RED}$errors check(s) failed${NC}"
    exit 1
fi
