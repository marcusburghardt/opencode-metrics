# SPDX-License-Identifier: Apache-2.0
#
# opencode-metrics — build, test, lint, clean targets

.PHONY: build test lint clean

build:
	bun build src/index.ts --outdir dist --target bun

# Coverage target: 80%. Bun's built-in coverage reports percentages but
# does not enforce thresholds via CLI. Review output manually or add a
# CI script to parse and gate on the 80% minimum.
test:
	bun test --coverage

lint:
	bunx biome check .

clean:
	rm -rf dist
