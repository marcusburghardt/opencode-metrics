// SPDX-License-Identifier: Apache-2.0

// Local development loader for the opencode-metrics plugin.
//
// OpenCode V2 loads plugins that default-export a `Plugin.define(...)` value.
// A flat .ts file is the proven form; this file imports the built bundle and
// default-exports it.
//
// Usage: run `make build` first, then start OpenCode in this project.
// The plugin will auto-load from this directory.

import plugin from "../../dist/index.js";

export default plugin;
