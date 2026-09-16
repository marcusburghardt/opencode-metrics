// SPDX-License-Identifier: Apache-2.0

// Local development loader for the opencode-metrics plugin.
// Imports the built bundle and re-exports as a named export
// for OpenCode's local plugin system.
//
// Usage: run `make build` first, then start OpenCode in this project.
// The plugin will auto-load from this file.

import plugin from "../../dist/index.js";

export const OpenCodeMetrics = plugin;
