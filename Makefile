.PHONY: all build build-core build-cli clean test typecheck check infra gcloud-auth

all: codocs

build-core:
	npm run build -w @codocs/core

build-cli: build-core
	npm run build -w @codocs/cli

build: build-cli

codocs: build-cli
	@echo '#!/bin/sh' > codocs
	@echo 'exec node "$(CURDIR)/packages/cli/dist/index.js" "$$@"' >> codocs
	chmod +x codocs

test:
	npm run test -w @codocs/core
	npm run test -w @codocs/cli

typecheck:
	npm run typecheck -w @codocs/core
	npm run typecheck -w @codocs/cli

check: test typecheck

gcloud-auth:
	@if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then \
		echo "No application-default credentials found. Logging in..."; \
		gcloud auth application-default login; \
	fi

infra: gcloud-auth
	cd terraform && terraform init -upgrade && terraform apply

clean:
	rm -rf packages/core/dist packages/cli/dist codocs
