# Changelog

## [0.5.1](https://github.com/marcusburghardt/opencode-metrics/compare/v0.5.0...v0.5.1) (2026-11-06)


### Bug Fixes

* **ci:** publish with npm OIDC trusted publishing ([ed922ae](https://github.com/marcusburghardt/opencode-metrics/commit/ed922ae44dbe6deb2d6662001d728cdc66435692))

## [0.5.0](https://github.com/marcusburghardt/opencode-metrics/compare/v0.4.1...v0.5.0) (2026-11-06)


### ⚠ BREAKING CHANGES

* requires OpenCode 2.2+. OpenCode V1 hosts cannot load this release and must pin @mburghardt/opencode-metrics@0.4.1. Sessions captured through V2 record lines_added/lines_deleted as 0, and historical rows are not re-attributed to a different project.

### Features

* add session flow metrics ([24b4758](https://github.com/marcusburghardt/opencode-metrics/commit/24b4758efb7afd244d5a73bcd033834571c94579))
* add sub-agent cost, time, and speed analytics ([5f3baf0](https://github.com/marcusburghardt/opencode-metrics/commit/5f3baf072cb258f6ca2d4bbdee8f93e1ef621381))
* **backfill:** support OpenCode V2 source layout ([a02969d](https://github.com/marcusburghardt/opencode-metrics/commit/a02969da2b2fe008b841bcf15ca1e2232ec87fdc))
* port plugin to OpenCode V2 plugin API ([7ebdbc4](https://github.com/marcusburghardt/opencode-metrics/commit/7ebdbc4f2bfbac73dd3632c4f4ca4a8bad5c73a7))


### Bug Fixes

* capture on every terminal session event and use a flat-file loader ([b57af6b](https://github.com/marcusburghardt/opencode-metrics/commit/b57af6b831c870ee12cf4941dd83a7f67e54a059))
* publish to npm from release workflow to bypass GITHUB_TOKEN event limits ([7f31588](https://github.com/marcusburghardt/opencode-metrics/commit/7f31588e195f42b72a0954d9f4f24e971590ffb0))
* report console-capture reality in check.sh and record live evidence ([9de25db](https://github.com/marcusburghardt/opencode-metrics/commit/9de25db63022ad2ed4dd7213fbe1e80f13af231b))
* use PluginInput directory as fallback for project detection ([2faa726](https://github.com/marcusburghardt/opencode-metrics/commit/2faa7262a6834b9313015c17c6f189b4a46a9047))


### Documentation

* **changelog:** fold stale unreleased entries into 0.3.0 ([69c580f](https://github.com/marcusburghardt/opencode-metrics/commit/69c580f82f6b925a9e7da325b12a7733a34c2ae3))
* document the OpenCode V2 install, upgrade, and migration path ([ec5f4df](https://github.com/marcusburghardt/opencode-metrics/commit/ec5f4df0bc2daf7180f74afd573f3d884b4eb354))
* **openspec:** add OpenCode V2 plugin migration change ([1965e60](https://github.com/marcusburghardt/opencode-metrics/commit/1965e601a0c7915d610976e6179aca8dde511395))
* **openspec:** add session flow metrics change ([04b54ae](https://github.com/marcusburghardt/opencode-metrics/commit/04b54ae41c562806bd378095c8bc0ffed0f1ade1))
* **openspec:** add V2 backfill source change ([3d6e502](https://github.com/marcusburghardt/opencode-metrics/commit/3d6e502eb89ee5400af132416fbb3890b1c028d4))
* **openspec:** archive backfill-v2-source ([a1b4867](https://github.com/marcusburghardt/opencode-metrics/commit/a1b4867325ed36d6edc39114ac137bf3a52505be))
* **openspec:** check off completed migration tasks ([f78c369](https://github.com/marcusburghardt/opencode-metrics/commit/f78c3696120ecf29a28bee3398e6988c973d7d14))
* **openspec:** complete V2 backfill planning artifacts ([9b85f9f](https://github.com/marcusburghardt/opencode-metrics/commit/9b85f9f122d1596b382f098d5263be9d4837771e))

## [0.4.1](https://github.com/marcusburghardt/opencode-metrics/compare/v0.4.0...v0.4.1) (2026-09-22)


### Bug Fixes

* derive project name from worktree path when SDK name is missing ([b9bf228](https://github.com/marcusburghardt/opencode-metrics/commit/b9bf228c7a34b1424c43a548946b6ab01a63f425))
* resolve release-please automation failures ([7de79ec](https://github.com/marcusburghardt/opencode-metrics/commit/7de79ec62e4618013446cff55fe2b12916cb4344))

## [0.4.0](https://github.com/marcusburghardt/opencode-metrics/compare/v0.3.0...v0.4.0) (2026-09-22)


### Features

* add --with-deltas and --since flags to backfill script ([dea15b2](https://github.com/marcusburghardt/opencode-metrics/commit/dea15b2ea45e5d3e3f018ab18e226c6f62d3eed1))
* add make check diagnostic command ([45f712b](https://github.com/marcusburghardt/opencode-metrics/commit/45f712bc7e2028ca81a9e1b7e00b74a0e941df40))


### Bug Fixes

* add include-component-in-tag to release-please config ([b874e45](https://github.com/marcusburghardt/opencode-metrics/commit/b874e45967ff9fb249a6f2069f53d5bdf76c1173))
* guard monotonic metrics against compaction-induced negative deltas ([1d44c1c](https://github.com/marcusburghardt/opencode-metrics/commit/1d44c1cf2974fabc2342caf7d7d133baecb7170c))
* increase npm publish verification to 5 minutes ([be4f7a4](https://github.com/marcusburghardt/opencode-metrics/commit/be4f7a45c5474a00bd4fd7aa6ca1b2ae1f8295eb))
* validate loader file exports in check.sh ([b452c13](https://github.com/marcusburghardt/opencode-metrics/commit/b452c13ddcfed094876f50b7ef0153e731b52a29))


### Miscellaneous

* default make target to help with available commands ([51f851f](https://github.com/marcusburghardt/opencode-metrics/commit/51f851fc37991a0f024cf1bd95affa53804feaff))


### Documentation

* add quick reference section to README ([cf981dd](https://github.com/marcusburghardt/opencode-metrics/commit/cf981ddec23a86dfc8a66e6a61c1cdd577b3d216))

## [0.3.0](https://github.com/marcusburghardt/opencode-metrics/compare/opencode-metrics-v0.2.0...opencode-metrics-v0.3.0) (2026-09-18)


### Features

* add budget classification engine, schema, and data pipeline ([8f94f94](https://github.com/marcusburghardt/opencode-metrics/commit/8f94f94bf8a2ee9ca6375b4820b0ea8da742f2fd))
* add budget rule config and defaults (tasks 1.1, 1.2) ([3517e05](https://github.com/marcusburghardt/opencode-metrics/commit/3517e052fba6b6d1f93cb9dc327c2a8cce45c0cc))
* add CI/CD pipeline and publish as @mburghardt/opencode-metrics ([5b20619](https://github.com/marcusburghardt/opencode-metrics/commit/5b2061987308dc7f6996816ccaa9e5f82952c3fe))
* add CI/CD pipeline and publish as @mburghardt/opencode-metrics ([141bc7b](https://github.com/marcusburghardt/opencode-metrics/commit/141bc7bd033c8b0ff628c61b14616cf03125dd9d))
* add cost adjustment layer for user-defined pricing ([1fe6377](https://github.com/marcusburghardt/opencode-metrics/commit/1fe6377831a32e07a47574c9ead8ce1f6d834272))
* add `cost_pricing` configuration section for per-model token pricing rules
* add `cost_pricing` table via V4 schema migration
* add `v_adjusted_costs` view for cumulative adjusted cost per session
* add `v_adjusted_cost_deltas` view for time-sliced adjusted cost deltas
* sync cost pricing rules from config.yaml to database on startup (full-replace strategy)
* support optional `cache_read_price`, `cache_write_price`, and `reasoning_price` fields in pricing rules
* validate cost pricing rules during config loading (skip malformed with warning)
* add historical session backfill script ([02952d5](https://github.com/marcusburghardt/opencode-metrics/commit/02952d5c55d9a233427cfd27b8ed774af7646b17))
* add PR and issue tracking with session artifacts ([0a424ff](https://github.com/marcusburghardt/opencode-metrics/commit/0a424ffdd62d470c644e051fb8afd8017cc33ab1))
* add QUICK_START guide with install, grafana, and classification examples ([7ed92ae](https://github.com/marcusburghardt/opencode-metrics/commit/7ed92ae1601b7d3d8236262bb0872c988ba5cdde))
* implement opencode-metrics plugin v0.1.0 ([facc458](https://github.com/marcusburghardt/opencode-metrics/commit/facc4588eafd00a7e4bce73d05b4e930747bfd6c))
* integrate budget classification into plugin and backfill ([5419eae](https://github.com/marcusburghardt/opencode-metrics/commit/5419eae8b6f84f77d34d31b3ea0f1a0fbebd932f))


### Bug Fixes

* add retry loop to post-publish verification step ([7ff3534](https://github.com/marcusburghardt/opencode-metrics/commit/7ff3534a8264bbf3340f1c126d7bcbf31af4300d))
* add retry loop to post-publish verification step ([89165af](https://github.com/marcusburghardt/opencode-metrics/commit/89165af44c9a5cd6226087a32cde07506e31a99e))
* add v_sessions and v_measurements views for Grafana compatibility ([f5ef56a](https://github.com/marcusburghardt/opencode-metrics/commit/f5ef56a223cedb4cfd7e6b404104b10a318c3958))
* fall back to message data for agent/model in backfill ([4f142f3](https://github.com/marcusburghardt/opencode-metrics/commit/4f142f3c35d98b1252c6941e43db48f4d2baf3b6))
* label sessions with zero messages as empty-session not unknown ([50300ac](https://github.com/marcusburghardt/opencode-metrics/commit/50300ac75a14a1b12825c241a18d9628debc8647))
* map project.name in SDK adapter, fix review findings ([07f465a](https://github.com/marcusburghardt/opencode-metrics/commit/07f465a6ca93ab73eb9d02f883ce48887f4f47ff))
* skip delta writes during backfill to prevent misleading daily cost ([dab36f4](https://github.com/marcusburghardt/opencode-metrics/commit/dab36f48e80406a95c2b942a31ce599797204641))


### Miscellaneous

* **main:** release opencode-metrics 0.2.0 ([000d701](https://github.com/marcusburghardt/opencode-metrics/commit/000d701e79f2445bfdecfc0d5430a140c9507027))
* **main:** release opencode-metrics 0.2.0 ([92bd3c6](https://github.com/marcusburghardt/opencode-metrics/commit/92bd3c6a407fe2c2f9a0470b3940c81f16584d86))
* mark code review passed ([863b4ea](https://github.com/marcusburghardt/opencode-metrics/commit/863b4ead6d3082d4b1fa3f9e1b8ee2dd22d4a99f))
* scaffold unbound-force files ([e8daf3e](https://github.com/marcusburghardt/opencode-metrics/commit/e8daf3e302abf3a7d13d9531b3d43bf8ea422912))


### Documentation

* add design, specs, and tasks for budget-classification ([966822a](https://github.com/marcusburghardt/opencode-metrics/commit/966822a13bf98c3ce9a893fbe6175f700138e04c))
* add openspec proposal for backfill-script change ([f3da542](https://github.com/marcusburghardt/opencode-metrics/commit/f3da542b7a4691569a468494494c3626d6209a22))
* add openspec proposal for budget-classification change ([dda4d84](https://github.com/marcusburghardt/opencode-metrics/commit/dda4d843f1b15f87d754af6e1598d8e796e0b1d1))
* add openspec proposal for initial-plugin change ([eede3bd](https://github.com/marcusburghardt/opencode-metrics/commit/eede3bd10cea0789d53ee0389d3b5c8bb80354fe))
* add openspec proposal for measurement-deltas change ([05d0e9a](https://github.com/marcusburghardt/opencode-metrics/commit/05d0e9a4bfe5b9eb7314baee6028f0701a26db0a))
* add openspec proposal for npm-release change ([4ff1f6a](https://github.com/marcusburghardt/opencode-metrics/commit/4ff1f6a5401bf4e0b13123ec2ed61cb6f3e74f16))
* add openspec proposal for pr-issue-tracking change ([0126e0f](https://github.com/marcusburghardt/opencode-metrics/commit/0126e0f3f62a1515f6ec335095d0eb1b17a57865))
* apply spec review fixes for budget-classification ([ca15ad6](https://github.com/marcusburghardt/opencode-metrics/commit/ca15ad6ebe01c29991e21a62d3cdabe941f0f7f2))
* archive cost-adjustment-layer change ([fc76c39](https://github.com/marcusburghardt/opencode-metrics/commit/fc76c395aae65ee399fce60225162ef878359493))
* sync budget-classification specs to main and archive change ([f1e4cf1](https://github.com/marcusburghardt/opencode-metrics/commit/f1e4cf1ca5331cc9a808c9f0ede9e9b73e3cf5b5))
* sync ci-release specs to main and archive npm-release change ([90a007b](https://github.com/marcusburghardt/opencode-metrics/commit/90a007b3f89d907f13f2fbbc09f827e393be193a))
* sync delta specs to main and archive completed changes ([ced6dfd](https://github.com/marcusburghardt/opencode-metrics/commit/ced6dfd974b0520462f9beb989e0fdacbcc7cc87))
* sync subagent-cost-attribution specs to main and archive change ([cc521e4](https://github.com/marcusburghardt/opencode-metrics/commit/cc521e426ea7e1714d63bab9aac76ce5c29332b4))

## [0.2.0](https://github.com/marcusburghardt/opencode-metrics/compare/opencode-metrics-v0.1.0...opencode-metrics-v0.2.0) (2026-09-17)


### Features

* add budget classification engine, schema, and data pipeline ([8f94f94](https://github.com/marcusburghardt/opencode-metrics/commit/8f94f94bf8a2ee9ca6375b4820b0ea8da742f2fd))
* add budget rule config and defaults (tasks 1.1, 1.2) ([3517e05](https://github.com/marcusburghardt/opencode-metrics/commit/3517e052fba6b6d1f93cb9dc327c2a8cce45c0cc))
* add CI/CD pipeline and publish as @mburghardt/opencode-metrics ([5b20619](https://github.com/marcusburghardt/opencode-metrics/commit/5b2061987308dc7f6996816ccaa9e5f82952c3fe))
* add CI/CD pipeline and publish as @mburghardt/opencode-metrics ([141bc7b](https://github.com/marcusburghardt/opencode-metrics/commit/141bc7bd033c8b0ff628c61b14616cf03125dd9d))
* add historical session backfill script ([02952d5](https://github.com/marcusburghardt/opencode-metrics/commit/02952d5c55d9a233427cfd27b8ed774af7646b17))
* add PR and issue tracking with session artifacts ([0a424ff](https://github.com/marcusburghardt/opencode-metrics/commit/0a424ffdd62d470c644e051fb8afd8017cc33ab1))
* add QUICK_START guide with install, grafana, and classification examples ([7ed92ae](https://github.com/marcusburghardt/opencode-metrics/commit/7ed92ae1601b7d3d8236262bb0872c988ba5cdde))
* implement opencode-metrics plugin v0.1.0 ([facc458](https://github.com/marcusburghardt/opencode-metrics/commit/facc4588eafd00a7e4bce73d05b4e930747bfd6c))
* integrate budget classification into plugin and backfill ([5419eae](https://github.com/marcusburghardt/opencode-metrics/commit/5419eae8b6f84f77d34d31b3ea0f1a0fbebd932f))


### Bug Fixes

* add v_sessions and v_measurements views for Grafana compatibility ([f5ef56a](https://github.com/marcusburghardt/opencode-metrics/commit/f5ef56a223cedb4cfd7e6b404104b10a318c3958))
* fall back to message data for agent/model in backfill ([4f142f3](https://github.com/marcusburghardt/opencode-metrics/commit/4f142f3c35d98b1252c6941e43db48f4d2baf3b6))
* label sessions with zero messages as empty-session not unknown ([50300ac](https://github.com/marcusburghardt/opencode-metrics/commit/50300ac75a14a1b12825c241a18d9628debc8647))
* map project.name in SDK adapter, fix review findings ([07f465a](https://github.com/marcusburghardt/opencode-metrics/commit/07f465a6ca93ab73eb9d02f883ce48887f4f47ff))
* skip delta writes during backfill to prevent misleading daily cost ([dab36f4](https://github.com/marcusburghardt/opencode-metrics/commit/dab36f48e80406a95c2b942a31ce599797204641))


### Miscellaneous

* mark code review passed ([863b4ea](https://github.com/marcusburghardt/opencode-metrics/commit/863b4ead6d3082d4b1fa3f9e1b8ee2dd22d4a99f))
* scaffold unbound-force files ([e8daf3e](https://github.com/marcusburghardt/opencode-metrics/commit/e8daf3e302abf3a7d13d9531b3d43bf8ea422912))


### Documentation

* add design, specs, and tasks for budget-classification ([966822a](https://github.com/marcusburghardt/opencode-metrics/commit/966822a13bf98c3ce9a893fbe6175f700138e04c))
* add openspec proposal for backfill-script change ([f3da542](https://github.com/marcusburghardt/opencode-metrics/commit/f3da542b7a4691569a468494494c3626d6209a22))
* add openspec proposal for budget-classification change ([dda4d84](https://github.com/marcusburghardt/opencode-metrics/commit/dda4d843f1b15f87d754af6e1598d8e796e0b1d1))
* add openspec proposal for initial-plugin change ([eede3bd](https://github.com/marcusburghardt/opencode-metrics/commit/eede3bd10cea0789d53ee0389d3b5c8bb80354fe))
* add openspec proposal for measurement-deltas change ([05d0e9a](https://github.com/marcusburghardt/opencode-metrics/commit/05d0e9a4bfe5b9eb7314baee6028f0701a26db0a))
* add openspec proposal for npm-release change ([4ff1f6a](https://github.com/marcusburghardt/opencode-metrics/commit/4ff1f6a5401bf4e0b13123ec2ed61cb6f3e74f16))
* add openspec proposal for pr-issue-tracking change ([0126e0f](https://github.com/marcusburghardt/opencode-metrics/commit/0126e0f3f62a1515f6ec335095d0eb1b17a57865))
* apply spec review fixes for budget-classification ([ca15ad6](https://github.com/marcusburghardt/opencode-metrics/commit/ca15ad6ebe01c29991e21a62d3cdabe941f0f7f2))
* sync budget-classification specs to main and archive change ([f1e4cf1](https://github.com/marcusburghardt/opencode-metrics/commit/f1e4cf1ca5331cc9a808c9f0ede9e9b73e3cf5b5))
* sync ci-release specs to main and archive npm-release change ([90a007b](https://github.com/marcusburghardt/opencode-metrics/commit/90a007b3f89d907f13f2fbbc09f827e393be193a))
* sync delta specs to main and archive completed changes ([ced6dfd](https://github.com/marcusburghardt/opencode-metrics/commit/ced6dfd974b0520462f9beb989e0fdacbcc7cc87))
