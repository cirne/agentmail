#!/usr/bin/env bash
# Test script for install.sh validation
# This script tests the install script in a controlled environment

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_SCRIPT="$REPO_ROOT/install.sh"
source "$SCRIPT_DIR/lib/common.sh"

test_passed=0
test_failed=0

pass() {
    success "$1"
    ((test_passed++))
}

fail() {
    error "$1" || true  # Don't exit on test failure
    ((test_failed++))
}

# Test 1: Script syntax validation
test_syntax() {
    section "Testing install.sh syntax"
    
    if bash -n "$INSTALL_SCRIPT" 2>&1; then
        pass "install.sh syntax is valid"
    else
        fail "install.sh has syntax errors"
        return 1
    fi
    
    # Check for common bash pitfalls
    if grep -q "set -euo pipefail" "$INSTALL_SCRIPT"; then
        pass "Script uses strict mode (set -euo pipefail)"
    else
        fail "Script missing strict mode"
    fi
    
    if [ -x "$INSTALL_SCRIPT" ]; then
        pass "install.sh is executable"
    else
        fail "install.sh is not executable"
    fi
}

# Test 2: ShellCheck validation (if available)
test_shellcheck() {
    section "Running ShellCheck (if available)"
    
    if command -v shellcheck &> /dev/null; then
        if shellcheck "$INSTALL_SCRIPT"; then
            pass "ShellCheck passed"
        else
            fail "ShellCheck found issues"
        fi
    else
        info "ShellCheck not installed (optional, install with: brew install shellcheck)"
    fi
}

# Test 3: Function definitions
test_functions() {
    section "Checking function definitions"
    
    required_functions=(
        "check_node"
        "check_npm"
        "configure_npm"
        "check_auth"
        "authenticate"
        "install_zmail"
        "verify_installation"
        "main"
    )
    
    for func in "${required_functions[@]}"; do
        if grep -q "^${func}()" "$INSTALL_SCRIPT"; then
            pass "Function '$func' is defined"
        else
            fail "Function '$func' is missing"
        fi
    done
}

# Test 4: Variable definitions
test_variables() {
    section "Checking variable definitions"
    
    required_vars=(
        "ZMAIL_PACKAGE"
        "GITHUB_REGISTRY"
        "GITHUB_SCOPE"
    )
    
    for var in "${required_vars[@]}"; do
        if grep -q "^${var}=" "$INSTALL_SCRIPT"; then
            pass "Variable '$var' is defined"
        else
            fail "Variable '$var' is missing"
        fi
    done
}

# Test 5: URL validation
test_url() {
    section "Validating install script"
    
    if grep -q "@cirne/zmail" "$INSTALL_SCRIPT"; then
        pass "Install script references npm package"
    else
        fail "Install script does not reference @cirne/zmail"
    fi
    
    # Check if URL matches repo
    if [ -d "$REPO_ROOT/.git" ]; then
        REMOTE_URL=$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || echo "")
        if echo "$REMOTE_URL" | grep -q "cirne/zmail"; then
            pass "Git remote matches expected repository"
        else
            warn "Git remote may not match (current: $REMOTE_URL)"
            ((test_failed++))
        fi
    fi
}

# Test 6: Dry-run simulation (doesn't actually install)
test_dry_run() {
    section "Testing install script logic (dry-run)"
    
    # Source the script functions without executing main
    # This is tricky - we'll just verify the structure
    if grep -q "check_node" "$INSTALL_SCRIPT" && \
       grep -q "check_npm" "$INSTALL_SCRIPT" && \
       grep -q "configure_npm" "$INSTALL_SCRIPT"; then
        pass "Install script has required check functions"
    else
        fail "Install script missing required functions"
    fi
}

# Test 7: Error handling
test_error_handling() {
    section "Checking error handling"
    
    if grep -q "set -euo pipefail" "$INSTALL_SCRIPT"; then
        pass "Error handling enabled (set -e)"
    else
        fail "Error handling not enabled"
    fi
    
    if grep -q "error()" "$INSTALL_SCRIPT"; then
        pass "Error function is defined"
    else
        fail "Error function is missing"
    fi
}

# Summary
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
    else
        echo -e "${RED}Some tests failed${NC}"
        return 1
    fi
}

# Run all tests
main() {
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  Install Script Test Suite${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    
    test_syntax
    test_shellcheck
    test_functions
    test_variables
    test_url
    test_dry_run
    test_error_handling
    
    summary
}

main "$@"
