---
name: browser-social-login
description: Skill for the computer-use agent to authenticate into social media platforms using Bitwarden browser extension autofill.
---

# Browser Social Login Skill

This skill dictates how a computer-use agent (operating via browser automation or native UI interactions) should log into social platforms for the Gaia marketing pipeline.

## Credential Method: Bitwarden Browser Extension

Credentials are stored in Bitwarden vault `gaia-marketing-computer-use`. The agent accesses them through the **Bitwarden Chrome extension autofill** — never via CLI, environment variables, or plaintext files.

## Prerequisites
- Bitwarden browser extension is installed in Chrome
- The extension is unlocked for the current session (if locked, pause and ask boss)
- The target platform is specified in the queue task or issue
- `docs/social-accounts-mapping.md` from `marketing-tasks` repo is loaded for reference

## Execution Steps

### 1. Check Existing Session
Before attempting login, check if already authenticated:
- Navigate to the platform's main page or dashboard URL
- Look for signs of an active session: profile avatar, username display, dashboard content
- If already logged in → verify the identity matches the expected username → proceed to posting
- If NOT logged in → continue to step 2

### 2. Navigate to Login Page
- Open the Login URL from `docs/social-accounts-mapping.md`
- Wait for the page to fully load

### 3. Bitwarden Autofill
- Look for the Bitwarden extension icon (blue shield) in the browser toolbar or within form fields
- **If Bitwarden shows a matching credential popup/overlay on the login fields:**
  - Click the matching entry to autofill both username and password
- **If Bitwarden shows the icon but no popup:**
  - Click the Bitwarden extension icon in the Chrome toolbar
  - Search or scroll to find the matching vault entry for this platform
  - Click the entry to autofill
- **If Bitwarden extension is locked (shows lock icon or asks for master password):**
  - STOP. Do not attempt to unlock.
  - Alert the human operator: "Bitwarden is locked. Please unlock the extension so I can log in to [platform]."
  - Wait for confirmation before retrying
- **If no matching entry exists in Bitwarden:**
  - STOP. Alert the human operator: "No Bitwarden entry found for [platform]. Please add credentials to the vault."
  - Do not attempt manual credential entry

### 4. Submit Login
- After autofill, click the "Log In" / "Sign In" / "Submit" button
- Wait for the page to load

### 5. Handle 2FA / MFA
- If a 2FA/MFA code is requested (SMS, TOTP, email code):
  - STOP. Alert the human operator: "2FA code required for [platform]. Please enter the code."
  - Wait for the human to enter the code and confirm
  - Do not attempt to read, extract, or auto-fill 2FA codes
- If a "Trust this device?" or "Remember this browser?" prompt appears:
  - Click "Yes" / "Trust" / "Remember" to reduce future 2FA friction

### 6. Handle CAPTCHA
- If a CAPTCHA appears:
  - Attempt to solve it using vision capabilities (click images, checkboxes)
  - If the CAPTCHA fails or is too complex: STOP and alert the human operator
  - Maximum 1 retry on CAPTCHA

### 7. Verify Login
- Confirm successful authentication by checking for:
  - Profile icon or avatar in the header/nav
  - Username display matching the expected handle
  - Dashboard or authenticated content visible
- If login failed (wrong password, account locked, etc.):
  - STOP. Do not retry. Report the error to the human operator.

### 8. Identity Verification
- Cross-check the logged-in username against `docs/social-accounts-mapping.md`
- If the wrong account is logged in:
  - STOP IMMEDIATELY. Do not post.
  - Alert: "Wrong account detected. Expected [expected], got [actual]. Aborting."

## Alternative Login Flows

Some platforms support OAuth login as alternatives:
- **Dev.to**: "Sign in with GitHub" button → authenticates via nova-gaia GitHub
- **Product Hunt**: "Sign in with GitHub" button → authenticates via nova-gaia GitHub
- **YouTube**: Owner-only (boss must pre-authenticate). Agent should NOT attempt YouTube login.

For OAuth flows:
1. Click the "Sign in with GitHub" button
2. If GitHub is already authenticated in the browser, it will auto-redirect
3. If not, Bitwarden autofill will handle the GitHub login page
4. Verify the correct GitHub account (nova-gaia) is used

## Hard Rules
1. Never type credentials manually — always use Bitwarden autofill or OAuth
2. Never screenshot login pages, password fields, or Bitwarden popups
3. Never read, extract, copy, or log any credential values
4. Never attempt to unlock Bitwarden — that is a human-only action
5. Never retry a failed login more than once — report and wait
6. Never create new accounts — only use existing accounts from the mapping
