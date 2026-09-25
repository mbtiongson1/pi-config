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
2. Copy managed `agents/`, `extensions/`, `prompts/`, and `bin/` *contents*
   from the checkout into their peers under `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}`.
   Use `mkdir -p "$dest/$dir"; cp -R "$repo/$dir/." "$dest/$dir/"`.
   Do not delete other installed resources.
3. **Mandatory, non-optional:** `bash "$repo/bin/install-pi-cost.sh"`. It
   verifies pi-config `VERSION=1.10.0` against `skills/pi-cost/SKILL.md` and
   installs/verifies the full versioned bundle in `<agent-dir>/skills/pi-cost`.
   If this command fails, report Update **incomplete**. Do not silently skip
   pricing data or register `pi-cost` under optional packages.
4. Follow the optional package check below for *other* packages. Reload Pi to
   discover updated resources.

## Reinstall

1. Pull safely as in Update; stop on conflicting local edits.
2. Back up any user-owned customization. Wipe only the repo-managed
   `agents/`, `extensions/`, `prompts/`, and `bin/` folders, then copy their
   contents from the checkout. Do **not** wipe all user skills or sessions.
3. Reset `settings.json` and `models.json` from their templates only with the
   user's requested reinstall approval; preserve credentials (`auth.json`,
   `trust.json`) and sessions.
4. **Always** run `bash "$repo/bin/install-pi-cost.sh"` and verify success.
   It safely overlays only the managed `pi-cost` skill. Without it Reinstall
   is **incomplete**. Then do the optional package check and reload Pi.

## Sync / Diff

- **Sync**: compare installed managed resources with the repo before copying;
  exclude `auth.json`, `models.json`, `trust.json`, and sessions. Commit/push
  only reviewed changes. The managed `skills/pi-cost/` source is mandatory:
  do not replace its catalog with an older/unknown installed copy; check
  `_meta.fetched_at` and provenance first.
- **Diff**: compare `agents`, `extensions`, `prompts`, `bin`, and the mandatory
  `skills/pi-cost/` bundle against the installed agent directory. Never diff
  credentials or session logs into public output.

## Post-action optional package check

After Update/Reinstall, read `optional-packages.json` and compare it to the
installed `settings.json` packages. Ask whether to install *missing optional*
packages. Apply their `postInstallInstructions` if approved. Preserve the
foreground-default customization of `npm:@quintinshaw/pi-dynamic-workflows`.
`pi-cost` is never part of this optional prompt: it is installed and verified
by the required step above.
