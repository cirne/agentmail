#!/usr/bin/env bash
# Test script to verify npm publishing access for @cirne/zmail

set -e

echo "=== Testing npm Access for @cirne/zmail ==="
echo ""

# Check if logged in
echo "1. Checking npm login status..."
if npm whoami &> /dev/null; then
    USERNAME=$(npm whoami)
    echo "   ✓ Logged in as: $USERNAME"
else
    echo "   ✗ Not logged in. Run: npm login"
    exit 1
fi

# Verify username
if [ "$USERNAME" != "cirne" ]; then
    echo "   ⚠ Warning: Expected username 'cirne', but logged in as '$USERNAME'"
fi

echo ""
echo "2. Checking @cirne scope access..."
if npm access ls-packages @cirne &> /dev/null; then
    echo "   ✓ You have access to @cirne scope"
    echo "   Packages you can publish:"
    npm access ls-packages @cirne | head -5
else
    echo "   ✗ Cannot access @cirne scope"
    echo "   You may need to:"
    echo "   - Create the @cirne organization on npmjs.com, or"
    echo "   - Be added as a member to the @cirne organization"
    exit 1
fi

echo ""
echo "3. Testing package creation (dry-run)..."
cd "$(dirname "$0")/.."
if npm pack --dry-run &> /dev/null; then
    echo "   ✓ Package can be created"
else
    echo "   ✗ Package creation failed"
    exit 1
fi

echo ""
echo "4. Checking if @cirne/zmail already exists..."
if npm view @cirne/zmail &> /dev/null; then
    echo "   ⚠ Package @cirne/zmail already exists on npm"
    echo "   Latest version: $(npm view @cirne/zmail version)"
else
    echo "   ✓ Package @cirne/zmail does not exist yet (ready to publish)"
fi

echo ""
echo "=== All checks passed! ==="
echo ""
echo "To publish (when ready):"
echo "  npm publish --access public"
echo ""
echo "Note: Scoped packages are private by default. Use --access public to publish publicly."
