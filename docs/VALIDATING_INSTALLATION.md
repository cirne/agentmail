# Validating Installation

This document describes how to validate the install script, manual npm release, and distribution pipeline to ensure everything works correctly before and after releases.

## Overview

The validation strategy covers:
1. **Install script validation** - Syntax, logic, and functionality
2. **Release process** - Manual npm publish via `node/scripts/publish.sh` (no GitHub Actions release workflow)
3. **End-to-end installation testing** - Full installation and package verification
4. **Manual validation** - Real-world testing scenarios

---

## 1. Install Script Validation

### Quick Validation

Run the test script:
```bash
./node/scripts/test-install.sh
```

This validates:
- Bash syntax correctness
- ShellCheck compliance (if installed)
- Function definitions
- Variable definitions
- URL correctness
- Error handling

### Manual Testing

**Test syntax:** Root `install.sh` delegates to `node/install.sh`; validate both.
```bash
bash -n install.sh
bash -n node/install.sh
```

**Test with ShellCheck (recommended):**
```bash
# Install ShellCheck first: brew install shellcheck
shellcheck install.sh node/install.sh
```

**Dry-run test (simulate without installing):**
```bash
# Check that script can be sourced without errors
bash -c "source <(sed '/^main/d' install.sh); echo 'Script structure OK'"
```

### Test Scenarios

**1. Test Node.js version check:**
```bash
# Temporarily rename node to test error handling
mv $(which node) $(which node).bak
bash install.sh  # Should fail with helpful error
mv $(which node).bak $(which node)
```

**2. Test authentication flow:**
```bash
# Clear npm auth
npm logout --scope=@cirne --registry=https://npm.pkg.github.com
# Run installer - should prompt for auth
bash install.sh
```

**3. Test from curl (after pushing to GitHub):**
```bash
# Test the actual curl command
curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | bash
```

---

## 2. Release validation (manual npm publish)

Publishing is done locally with `node/scripts/publish.sh` (see `AGENTS.md`). Before publishing, from the repo root after `nvm use`:

```bash
cd node
npm test
npm run build
cd .. && ./node/scripts/validate-release.sh
```

After `publish.sh` completes, confirm the new version appears on the npm registry you use and that `npm install -g @cirne/zmail` works.

---

## 3. End-to-End Installation Testing

### Full Installation Test

**Prerequisites:**
- GitHub Personal Access Token with `read:packages` permission
- Node.js 20+ installed
- Clean npm environment (or use a test user)

**Steps:**

1. **Clear existing installation:**
   ```bash
   npm uninstall -g @cirne/zmail
   npm logout --scope=@cirne --registry=https://npm.pkg.github.com
   ```

2. **Test install script:**
   ```bash
   curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | bash
   ```

3. **Verify installation:**
   ```bash
   which zmail
   zmail --version  # or zmail --help
   ```

4. **Test basic functionality:**
   ```bash
   zmail setup  # Should prompt for configuration
   ```

### Package Verification

**Check installed package:**
```bash
npm list -g @cirne/zmail
```

**Verify package contents:**
```bash
# Check what was installed
npm list -g @cirne/zmail --depth=0
# Check bin location
npm config get prefix
ls -la $(npm config get prefix)/bin/zmail
```

**Test package functionality:**
```bash
# After installation
zmail --help
zmail status  # Should show "No config found" or similar
```

---

## 4. Manual Validation Checklist

### Pre-Release Checklist

- [ ] Install script syntax validated (`bash -n install.sh && bash -n node/install.sh`)
- [ ] ShellCheck passes (`shellcheck install.sh node/install.sh`)
- [ ] Test script passes (`./node/scripts/test-install.sh`)
- [ ] Local tests pass (`cd node && npm test`)
- [ ] Build succeeds (`cd node && npm run build`)
- [ ] Package.json name is `@cirne/zmail`

### Post-publish checklist

- [ ] Package published to npm with expected version
- [ ] Dist-tag is correct if you used a non-default tag
- [ ] Install script URL is accessible
- [ ] Can install via curl command
- [ ] Installed package works (`zmail --help`)

### Alpha Tester Validation

Provide alpha testers with:

1. **Installation command:**
   ```bash
   curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | bash
   ```

2. **Verification steps:**
   ```bash
   zmail --version
   zmail --help
   zmail setup
   ```

3. **Report back:**
   - Did installation work?
   - Any errors during install?
   - Can they run `zmail --help`?
   - Authentication flow clear?

---

## 5. Troubleshooting

### Install Script Issues

**Script fails with "command not found":**
- Check Node.js is installed: `node --version`
- Check npm is installed: `npm --version`
- Verify PATH includes npm bin: `echo $PATH`

**Authentication fails:**
- Verify GitHub PAT has `read:packages` permission
- Check npm config: `npm config list`
- Try manual login: `npm login --scope=@cirne --registry=https://npm.pkg.github.com`

**Package not found:**
- Verify package was published: https://github.com/cirne/zmail/packages
- Check npm registry config: `npm config get @cirne:registry`
- Try installing specific version: `npm install -g @cirne/zmail@0.1.0-alpha.20240306.120000`

### Publish issues

**Tests fail before publish:**
- Run locally: `cd node && npm test`
- Verify Node.js version matches `.nvmrc` (20+)

**Package publish fails:**
- Verify npm login and registry for `@cirne/zmail`
- Verify package name matches (`@cirne/zmail`)
- Check for version conflicts on the registry

---

## 6. Continuous Validation

### Automated Checks

Consider adding:

1. **Pre-commit hook** to validate install script:
   ```bash
   # .git/hooks/pre-commit
   bash -n install.sh && bash -n node/install.sh && shellcheck install.sh node/install.sh
   ```

2. **CI workflow** to test install script:
   ```yaml
   # .github/workflows/test-install.yml
   - name: Test install script
     run: ./node/scripts/test-install.sh
   ```

3. **Package validation** after publish:
   ```bash
   npm view @cirne/zmail
   ```

---

## Quick Test Commands

```bash
# Validate install script
bash -n install.sh && bash -n node/install.sh && shellcheck install.sh node/install.sh && ./node/scripts/test-install.sh

# Test full install
curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | bash

# Verify installation
zmail --version && zmail --help
```
