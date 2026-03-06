# Validating Installation

This document describes how to validate the install script, release workflow, and distribution pipeline to ensure everything works correctly before and after releases.

## Overview

The validation strategy covers:
1. **Install script validation** - Syntax, logic, and functionality
2. **Release workflow validation** - GitHub Actions workflow checks
3. **End-to-end installation testing** - Full installation and package verification
4. **Manual validation** - Real-world testing scenarios

---

## 1. Install Script Validation

### Quick Validation

Run the test script:
```bash
./scripts/test-install.sh
```

This validates:
- Bash syntax correctness
- ShellCheck compliance (if installed)
- Function definitions
- Variable definitions
- URL correctness
- Error handling

### Manual Testing

**Test syntax:**
```bash
bash -n install.sh
```

**Test with ShellCheck (recommended):**
```bash
# Install ShellCheck first: brew install shellcheck
shellcheck install.sh
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

## 2. Release Workflow Validation

### Local Workflow Validation

**Validate workflow syntax:**
```bash
# Using act (GitHub Actions local runner)
# Install: brew install act
act push --workflows .github/workflows/release.yml --dryrun
```

**Check workflow file:**
```bash
# Validate YAML syntax
yamllint .github/workflows/release.yml  # if installed
# Or use online validator: https://github.com/rhd-gitops-example/actions-workflow-validator
```

### GitHub Actions Testing

**Test main branch push:**
1. Make a small change (e.g., update README)
2. Commit and push to `main`
3. Check GitHub Actions tab
4. Verify:
   - Tests run and pass
   - Build succeeds
   - Package publishes to GitHub Packages with `latest` tag
   - No GitHub Release created

**Test manual dispatch:**
1. Go to GitHub Actions → "Release npm Package"
2. Click "Run workflow" → "Run workflow"
3. Verify:
   - Tests run
   - Build succeeds
   - Package publishes
   - GitHub Release created with tarball

**Test tag-based release:**
```bash
git tag v0.1.0-test.1
git push origin v0.1.0-test.1
```
Verify:
- Tests run
- Build succeeds
- Package publishes with version `0.1.0-test.1`
- GitHub Release created

### Workflow Output Validation

After a workflow run, verify:

1. **Package published:**
   - Go to: https://github.com/cirne/zmail/packages
   - Check that `@cirne/zmail` package exists
   - Verify version matches expected format

2. **Version format:**
   - Main push: `0.1.0-alpha.YYYYMMDD.HHMMSS`
   - Tag push: matches tag (e.g., `v0.1.0-test.1` → `0.1.0-test.1`)
   - Manual: `0.1.0-alpha.YYYYMMDD.HHMMSS`

3. **Dist-tag:**
   - Main push: should have `latest` tag
   - Tag/manual: no dist-tag (default)

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

- [ ] Install script syntax validated (`bash -n install.sh`)
- [ ] ShellCheck passes (`shellcheck install.sh`)
- [ ] Test script passes (`./scripts/test-install.sh`)
- [ ] Workflow syntax validated (GitHub Actions UI or act)
- [ ] Local tests pass (`npm test`)
- [ ] Build succeeds (`npm run build`)
- [ ] Package.json name is `@cirne/zmail`

### Post-Push Checklist

- [ ] Workflow runs successfully on push to main
- [ ] Tests pass in CI
- [ ] Package builds successfully
- [ ] Package publishes to GitHub Packages
- [ ] Version format is correct
- [ ] Dist-tag is set correctly (`latest` for main)
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

### Workflow Issues

**Workflow doesn't trigger:**
- Check branch name matches (`main`)
- Verify workflow file is in `.github/workflows/`
- Check GitHub Actions tab for errors

**Tests fail in CI:**
- Run locally: `npm test`
- Check test output in Actions logs
- Verify Node.js version (should be 20+)

**Package publish fails:**
- Check `GITHUB_TOKEN` permissions
- Verify package name matches (`@cirne/zmail`)
- Check for existing package conflicts

---

## 6. Continuous Validation

### Automated Checks

Consider adding:

1. **Pre-commit hook** to validate install script:
   ```bash
   # .git/hooks/pre-commit
   bash -n install.sh && shellcheck install.sh
   ```

2. **CI workflow** to test install script:
   ```yaml
   # .github/workflows/test-install.yml
   - name: Test install script
     run: ./scripts/test-install.sh
   ```

3. **Package validation** after publish:
   ```bash
   # In release workflow, after publish
   npm view @cirne/zmail --registry=https://npm.pkg.github.com
   ```

---

## Quick Test Commands

```bash
# Validate install script
bash -n install.sh && shellcheck install.sh && ./scripts/test-install.sh

# Test workflow locally (requires act)
act push --workflows .github/workflows/release.yml --dryrun

# Test full install (requires GitHub PAT)
curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | bash

# Verify installation
zmail --version && zmail --help
```
