#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# update-deps.sh — bulk npm dependency updater for the Vantek monorepo
# ──────────────────────────────────────────────────────────────────────────────
#
# WHAT IT DOES
#   Updates npm dependencies across the root and every workspace in a single
#   pass, so you don't have to merge Dependabot PRs one by one. Two modes:
#     · default  → safe: latest version WITHIN the current major (respects ^).
#     · --majors → bumps to the absolute latest, including major versions.
#   tesseract.js is ALWAYS held back (its v5 API is coupled to
#   app/frontend/scripts/setup-ocr-assets.mjs — see CLAUDE.md).
#   After updating it regenerates package-lock.json from scratch (a full
#   `npm install`, required so the nested @types/express override is applied)
#   and prints the remaining `npm outdated` report.
#
# USAGE (run via the Makefile, which wraps it in a node:24 container)
#   make deps-outdated        # report only, no changes
#   make deps-update          # safe within-major bumps
#   make deps-update-majors   # include breaking major bumps
#
# NOTES
#   · Run `make build-sqlite && make test` afterwards: a fresh install leaves
#     better-sqlite3 uncompiled (no prebuilt binary for this Node).
#   · Always review the diff and run the gate (tsc + tests) before pushing.
#   · This runs on Linux, so the regenerated lock only records the LINUX
#     platform-optional native bindings (e.g. Vite 8's rolldown binding). Due to
#     npm bug npm/cli#4828 the win32/darwin bindings are NOT written to the lock
#     (and can't be added via --os/--cpu), so the Windows release job DELETES the
#     lock and runs `npm install` to resolve its own native bindings. See
#     .github/workflows/release.yml.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Packages that must never be auto-bumped to a new MAJOR (coupling / deliberate pin):
#   · tesseract.js — its v5 API is coupled to setup-ocr-assets.mjs.
#   · typescript    — TS7 drops `moduleResolution: node`, breaking the backend/launcher.
#   · vitest        — v4 breaks the @testing-library/jest-dom matcher type augmentation.
PINNED="tesseract.js,typescript,vitest"

MODE="safe"
if [[ "${1:-}" == "--majors" ]]; then
  MODE="majors"
fi

echo "==> Dependency update mode: ${MODE} (holding back: ${PINNED})"

if [[ "${MODE}" == "majors" ]]; then
  # npm-check-updates rewrites the package.json ranges to the latest published
  # versions. -ws walks every workspace manifest; the root is handled by the
  # plain run. --reject keeps the pinned packages untouched.
  echo "==> Bumping ALL manifests to latest (incl. majors)…"
  npx --yes npm-check-updates@latest -u --reject "${PINNED}" --packageFile package.json
  npx --yes npm-check-updates@latest -u --reject "${PINNED}" --packageFile app/backend/package.json
  npx --yes npm-check-updates@latest -u --reject "${PINNED}" --packageFile app/frontend/package.json
else
  # `npm update --save` only advances within the existing semver range (^x.y.z
  # → latest x.*), which is the project's default safe policy.
  echo "==> Bumping within current major (safe)…"
  npm update --save --workspaces --include-workspace-root
fi

echo "==> Regenerating package-lock.json (full install, applies overrides)…"
rm -f package-lock.json
npm install

echo "==> Remaining outdated packages:"
npm outdated --workspaces --include-workspace-root || true

echo "==> Done. Next: 'make build-sqlite && make test' before committing."
