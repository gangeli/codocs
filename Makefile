.PHONY: all build build-core build-db build-cli dist clean test typecheck check infra gcloud-auth e2e

all: codocs

build-core:
	npm run build -w @codocs/core

build-db: build-core
	npm run build -w @codocs/db

build-cli: build-db
	npm run build -w @codocs/cli

build: build-cli

codocs: build-cli
	@echo '#!/bin/sh' > codocs
	@echo 'exec node "$(CURDIR)/packages/cli/dist/index.js" "$$@"' >> codocs
	chmod +x codocs

dist:
	bun build packages/cli/src/index.ts --compile --target=bun-darwin-arm64 --outfile dist/codocs-darwin-arm64
	bun build packages/cli/src/index.ts --compile --target=bun-darwin-x64 --outfile dist/codocs-darwin-x64
	bun build packages/cli/src/index.ts --compile --target=bun-linux-x64 --outfile dist/codocs-linux-x64
	bun build packages/cli/src/index.ts --compile --target=bun-linux-arm64 --outfile dist/codocs-linux-arm64
	bun build packages/cli/src/index.ts --compile --target=bun-windows-x64 --outfile dist/codocs-windows-x64.exe

test:
	npm run test -w @codocs/core
	npm run test -w @codocs/db
	npm run test -w @codocs/cli

typecheck:
	npm run typecheck -w @codocs/core
	npm run typecheck -w @codocs/db
	npm run typecheck -w @codocs/cli

check: test typecheck

gcloud-auth:
	@if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then \
		echo "No application-default credentials found. Logging in..."; \
		gcloud auth application-default login; \
	fi

infra: gcloud-auth
	cd terraform && terraform init -upgrade && terraform apply

e2e: build
	npx tsx scripts/e2e-visual-test.ts

clean:
	rm -rf packages/core/dist packages/db/dist packages/cli/dist dist codocs
