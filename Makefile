# Ensure tools installed outside of /opt/homebrew/bin (e.g. bun's install
# script drops a binary at ~/.bun/bin) are visible to recipes.
export PATH := $(HOME)/.bun/bin:$(PATH)

# Source .env (gitignored) into recipes via the shell so we don't have
# to constrain its format to make's stricter `include` syntax. Use this
# prefix in any recipe that needs API keys etc.; bash will parse quotes,
# exports, comments, the works.
LOAD_ENV := set -a; [ -f .env ] && . ./.env; set +a;

.PHONY: all build build-core build-db build-cli dist clean test typecheck check infra gcloud-auth e2e e2e/rendering e2e/roundtrip e2e/agents e2e/comments eval eval/judge deps

all: codocs

# Install or verify all tools the project depends on. Silent when everything
# is already on PATH; prints only when it has to install something.
deps:
	@if ! command -v node >/dev/null 2>&1; then \
		command -v brew >/dev/null 2>&1 || { \
			echo "brew not found. Install Homebrew from https://brew.sh first." >&2; \
			exit 1; \
		}; \
		echo "Installing node..."; \
		brew install node; \
	fi
	@if ! command -v bun >/dev/null 2>&1; then \
		echo "Installing bun..."; \
		curl -fsSL https://bun.sh/install | bash; \
	fi
	@if [ ! -d node_modules ]; then \
		echo "Installing npm packages..."; \
		npm install; \
	fi

build-db: deps
	npm run build -w @codocs/db

build-core: build-db
	npm run build -w @codocs/core

build-cli: build-core
	npm run build -w @codocs/cli

build: build-cli

codocs: build-cli
	@echo '#!/bin/sh' > codocs
	@echo 'exec node "$(CURDIR)/packages/cli/dist/index.js" "$$@"' >> codocs
	chmod +x codocs

dist: deps
	bun build packages/cli/src/index.ts --compile --target=bun-darwin-arm64 --outfile dist/codocs-darwin-arm64
	bun build packages/cli/src/index.ts --compile --target=bun-darwin-x64 --outfile dist/codocs-darwin-x64
	bun build packages/cli/src/index.ts --compile --target=bun-linux-x64 --outfile dist/codocs-linux-x64
	bun build packages/cli/src/index.ts --compile --target=bun-linux-arm64 --outfile dist/codocs-linux-arm64
	bun build packages/cli/src/index.ts --compile --target=bun-windows-x64 --outfile dist/codocs-windows-x64.exe

test: deps
	npm run test -w @codocs/core
	npm run test -w @codocs/db
	npm run test -w @codocs/cli

typecheck: deps
	npm run typecheck -w @codocs/core
	npm run typecheck -w @codocs/db
	npm run typecheck -w @codocs/cli

check: build test typecheck

gcloud-auth:
	@if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then \
		echo "No application-default credentials found. Logging in..."; \
		gcloud auth application-default login; \
	fi

infra: gcloud-auth
	cd terraform && terraform init -upgrade && terraform apply

e2e: e2e/rendering e2e/roundtrip e2e/agents e2e/comments

e2e/rendering: build
	npx tsx scripts/e2e-visual-test.ts

e2e/roundtrip: build
	npx tsx scripts/e2e-roundtrip.ts
	npx tsx scripts/e2e-edit-roundtrip.ts

e2e/agents: build
	npx tsx scripts/e2e-agents.ts $(if $(filter 0,$(QUOTA)),,--quota)

e2e/comments: build
	npx tsx scripts/e2e-comments.ts

# Run the end-to-end eval suite. Pass FILTER=<substring> to run a subset,
# CONCURRENCY=<n> to cap parallel cases (default 2 because each case spawns
# a real Claude agent), MODEL=<haiku|sonnet|opus> to pick the agent model
# (default: sonnet — Haiku is too weak to surface prompt regressions, Opus
# is expensive for routine runs). The judge model is pinned separately in
# evals/harness/judge.ts and is NOT affected by MODEL. Results print a
# per-category breakdown; detailed per-case artifacts land in evals/runs/<timestamp>/.
eval: build
	@$(LOAD_ENV) npx tsx evals/harness/run.ts $(if $(FILTER),--filter=$(FILTER),) $(if $(CONCURRENCY),--concurrency=$(CONCURRENCY),) $(if $(MODEL),--model=$(MODEL),)

# Calibrate the judge prompt against a fixed set of (rubric, response,
# expected-verdict) fixtures. Does NOT spawn Claude agents — only the
# judge model. Fast feedback loop when iterating on the judge prompt.
eval/judge: deps
	@$(LOAD_ENV) npx tsx evals/judge-calibration/run.ts $(if $(FILTER),--filter=$(FILTER),) $(if $(SAMPLES),--samples=$(SAMPLES),)

clean:
	rm -rf packages/core/dist packages/db/dist packages/cli/dist dist codocs
