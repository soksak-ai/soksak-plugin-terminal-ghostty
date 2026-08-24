SHELL := /bin/sh
.PHONY: preflight prepare build verify
preflight:
	@scripts/check-build-environment.sh
prepare: preflight
	@CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm --dir frontend install --frozen-lockfile
build: prepare
	@pnpm --dir frontend build
verify: prepare
	@node scripts/check-release-workflow.mjs
	@pnpm --dir frontend verify
