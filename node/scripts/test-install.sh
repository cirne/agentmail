#!/usr/bin/env bash
# Validates repository root install.sh (Rust binary installer from GitHub Releases).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_SCRIPT="$REPO_ROOT/install.sh"
source "$SCRIPT_DIR/lib/common.sh"

test_passed=0
test_failed=0

pass() {
    success "$1"
    test_passed=$((test_passed + 1))
}

fail() {
    error "$1" || true
    test_failed=$((test_failed + 1))
}

test_syntax() {
    section "Root install.sh (bash)"
    if bash -n "$INSTALL_SCRIPT" 2>&1; then
        pass "install.sh bash syntax is valid"
    else
        fail "install.sh has bash syntax errors"
    fi
    if [ -x "$INSTALL_SCRIPT" ]; then
        pass "install.sh is executable"
    else
        fail "install.sh is not executable"
    fi
}

test_node_wrapper() {
    section "node/install.sh wrapper"
    if bash -n "$REPO_ROOT/node/install.sh"; then
        pass "node/install.sh syntax is valid"
    else
        fail "node/install.sh syntax errors"
    fi
}

test_installer_content() {
    section "Installer content"
    if grep -q "api.github.com/repos" "$INSTALL_SCRIPT"; then
        pass "install.sh uses GitHub Releases API"
    else
        fail "install.sh missing GitHub API reference"
    fi
    if grep -q "INSTALLER" "$INSTALL_SCRIPT"; then
        pass "Embedded Python installer present"
    else
        fail "Embedded installer marker missing"
    fi
}

test_help() {
    section "Smoke (install.sh --help)"
    if "$INSTALL_SCRIPT" --help 2>&1 | grep -q "Install zmail from GitHub"; then
        pass "install.sh --help works"
    else
        fail "install.sh --help failed"
    fi
}

summary() {
    section "Test Summary"
    total=$((test_passed + test_failed))
    echo ""
    echo "Tests passed: $test_passed"
    echo "Tests failed: $test_failed"
    echo "Total tests:  $total"
    echo ""
    if [ $test_failed -eq 0 ]; then
        echo -e "${GREEN}All tests passed!${NC}"
        return 0
    fi
    echo -e "${RED}Some tests failed${NC}"
    return 1
}

main() {
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  install.sh validation${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    test_syntax
    test_node_wrapper
    test_installer_content
    test_help
    summary
}

main "$@"
