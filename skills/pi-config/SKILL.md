---
name: pi-config
description: Manage the user's Pi configuration from https://github.com/mbtiongson1/pi-config. Use for /pi-config, update, reinstall, sync, or diff; v1.10 requires installing the bundled pi-cost skill on every update/reinstall.
version: 1.10.0
---

# pi-config v1.10 — mandatory pi-cost on Update and Reinstall

Locate the local `mbtiongson1/pi-config` clone (usually `~/pi-config` on
Termux/Linux or `~/Documents/pi-config` on macOS). Confirm its remote before
pulling. Use the repository's actual default branch (`master` here), not a
hard-coded `main`. Do not reset or overwrite unrelated local edits.

If the user has not specified an action, ask: **Update, Reinstall, Sync, or
Diff?** If an action was specified, proceed without repeating the question.

## Update (additive)

1. `git -C "$repo" pull --ff-only origin master`. If local changes block it,
   stop rather than discarding them; a clean worktree can be used to stage a
   reviewed update.
2. Before bulk copying, run `bash "$repo/bin/ensure-durable-recovery.sh"` from the reviewed checkout. Stop on failure before changing other resources. **Exclude `extensions/durable-subagent-recovery.ts` from every direct copy/delete:** only its journaled installer may replace it, or the first-install preimage is lost. An experimental/unaccepted checkout does not authorize deployment; keep its documented acceptance gates. Copy the other managed `agents/`, `extensions/`, `prompts/`, `themes/`, and `bin/` *contents*
   from the checkout into their peers under `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}`.
   Stage an explicit copy list that excludes the protected recovery extension; do not use a bulk `cp` that would overwrite it. Other directories may use `mkdir -p "$dest/$dir"; cp -R "$repo/$dir/." "$dest/$dir/"`.
   Do not delete other installed resources.
3. **Mandatory, non-optional:** `bash "$repo/bin/install-pi-cost.sh"`. It
   verifies pi-config `VERSION=1.10.0` against `skills/pi-cost/SKILL.md` and
   installs/verifies the full versioned bundle in `<agent-dir>/skills/pi-cost`.
   If this command fails, report Update **incomplete**. Do not silently skip
   pricing data or register `pi-cost` under optional packages.
4. **Mandatory quota line default:** `bash "$repo/bin/ensure-quota-line.sh"`.
   Ensures Pi Quota box is never on by default and default is always the
   compact one-line surface (`quota line`), persisting `"quota": { "surface": "line" }`
   and patching all `quota-panel.ts` instances.
5. **Mandatory Subagent & Codemode reliability:** `bash "$repo/bin/ensure-subagent-config.sh"`.
   Ensures `~/.pi/subagent.json` (30m execution budget, 5m stall probe, stall kill disabled),
   statusline allowed keys, `subagent-monitor.ts`, and Durable Subagent Recovery
   (`bin/ensure-durable-recovery.sh`, `extensions/durable-subagent-recovery.ts`,
   and `~/.pi/durable/subagents.sqlite` WAL ledger) are persistently configured across upgrades.
6. **Mandatory engineering contract:** `bash "$repo/bin/install-append-system.sh"`.
   Idempotently writes the repo `APPEND_SYSTEM.md` into a marked block of
   `<agent-dir>/APPEND_SYSTEM.md`, preserving any user text outside it. Never
   edit `SYSTEM.md` or project `.pi/APPEND_SYSTEM.md` overrides.
7. Follow the optional package check below for *other* packages. Reload Pi to
   discover updated resources.
8. **Antigravity Argon portability:** the repo templates include the provider package, enabled model, and model metadata. When the user is setting up Argon in a new environment, consult `docs/gemini-4-argon.md` and verify the local settings/model override/authentication without exposing credentials. Offer `bash "$repo/bin/ensure-antigravity-argon.sh"` only when compatibility repair is needed and the user approves its shell-profile and installed-package source edits. It is tuned for Linux/Termux; do not silently run it on other platforms.
9. **Device model catalog:** Update copies repository-managed files only. It must never enroll a device, never create or overwrite `<agent-dir>/device-profile.json`, and never modify `models.json` outside an enrolled device profile. If `<agent-dir>/device-profile.json` exists, the device is already enrolled: leave it untouched and report `bash bin/device-models.sh status` output. Enrollment is always an explicit user action (`bash "$repo/bin/device-models.sh" enroll <device-id>`).

## Reinstall

1. Pull safely as in Update; stop on conflicting local edits.
2. First run the reviewed journaled recovery installer as in Update, stopping on failure. Preserve its installed extension, deployment intent/manifest, and private `~/.pi/durable/` tree; never wipe or directly copy that extension. Back up any other user-owned customization. Wipe only the other repo-managed
   `agents/`, `extensions/`, `prompts/`, `themes/`, and `bin/` folders, then copy their
   contents from the checkout. Do **not** wipe all user skills or sessions.
3. Reset `settings.json` and `models.json` from their templates only with the
   user's requested reinstall approval; preserve credentials (`auth.json`,
   `trust.json`), custom `"skills"` exclusion patterns, `"quota"` settings, and sessions.
4. **Always** run `bash "$repo/bin/install-pi-cost.sh"` and verify success.
   It safely overlays only the managed `pi-cost` skill. Without it Reinstall
   is **incomplete**.
5. **Always** run `bash "$repo/bin/ensure-quota-line.sh"` to guarantee the
   quota box is never on by default and default is always the compact quota line.
6. **Always** run `bash "$repo/bin/ensure-subagent-config.sh"` to guarantee
   persistent subagent timeouts, stall policy, visibility extensions, and Durable Subagent Recovery
   (`~/.pi/durable/` WAL ledger, session preservation, and `/subagent-recover`).
7. **Always** run `bash "$repo/bin/install-append-system.sh"`; Reinstall must
   not wipe `<agent-dir>/APPEND_SYSTEM.md` (the installer refreshes only its
   managed block). Then do the optional package check and reload Pi.
8. **Antigravity Argon portability:** when Argon is requested in a new environment,
   follow `docs/gemini-4-argon.md`; credentials are environment-specific and must
   not be copied. Offer the Linux/Termux compatibility repair script only after
   reviewing its shell-profile and installed-package source changes with the user.
9. **Device model catalog:** Reinstall restores repository-managed files. It must
   never enroll a device automatically, and it must not activate the MacBook
   profile on another machine. Restore device model preferences only with
   explicit opt-in (`bash "$repo/bin/device-models.sh" restore <device-id> --yes`).
   Preserve `auth.json`, `trust.json`, sessions, and any `models.json` entry
   that is not part of the device profile. If `<agent-dir>/device-profile.json`
   exists, keep it; if it does not, do not create it.

## Sync / Diff

- **Sync**: the recovery extension is managed only through `ensure-durable-recovery.sh` and its `durable-recovery-deploy.py` helper, never by direct copying. Compare installed managed resources with the repo before copying;
  exclude `auth.json`, `models.json`, `trust.json`, and sessions. Commit/push
  only reviewed changes. The managed `skills/pi-cost/` source is mandatory:
  do not replace its catalog with an older/unknown installed copy; check
  `_meta.fetched_at` and provenance first.
- **Diff**: compare `agents`, `extensions`, `prompts`, `themes`, `bin`, `APPEND_SYSTEM.md`, and the mandatory
  `skills/pi-cost/` bundle against the installed agent directory. Never diff
  credentials or session logs into public output.
- **Device profile sync**: an enrolled device may push a sanitized model
  snapshot with `bash bin/device-models.sh sync <device-id>`. It writes only
  non-sensitive metadata into `device-profiles/<device-id>/` and never copies
  local authentication material, account identifiers, balances, hostname,
  username, home path, or hardware identifiers. Review the generated diff
  (`git diff -- device-profiles/`) before committing.
- **Device profile diff**: use `bash bin/device-models.sh diff [device-id]` to
  compare the local catalog with the tracked profile. It separates safe model
  metadata from the local-only fields that are never committed.

## Post-action optional package check

After Update/Reinstall, read `optional-packages.json` and compare it to the
installed `settings.json` packages. Ask whether to install *missing optional*
packages. Apply their `postInstallInstructions` if approved. Preserve the
foreground-default customization of `npm:@quintinshaw/pi-dynamic-workflows`.
For `npm:pi-codex-computer-use`, only offer on macOS where Codex CLI and
Codex.app / ChatGPT.app are present, run `bash "$repo/bin/install-codex-computer-use.sh"`
upon installation, and remind the user to verify permissions via `--doctor`.
`pi-cost` is never part of this optional prompt: it is installed and verified
by the required step above.
