// SPDX-License-Identifier: Apache-2.0

import { parse } from "yaml";
import type { ClassificationCondition, MetricsConfig } from "./config";

/**
 * Default config.yaml content with all 8 built-in classification rules.
 * Written to disk by writeDefaultConfig() on first run.
 *
 * Rules are evaluated in order — first match wins:
 * 1. pr-review       — PR URL in first message, excludes gh pr create
 * 2. pr-creation     — gh pr create in bash commands
 * 3. openspec-workflow — spec artifact references with plan/build agent
 * 4. multi-agent     — swarm agent name prefixes
 * 5. exploration     — explore agent
 * 6. planning        — plan agent
 * 7. implementation  — build agent
 * 8. ad-hoc          — default fallback (no conditions)
 */
export const DEFAULT_CONFIG_YAML = `\
# opencode-metrics configuration
# Classification rules are evaluated in order — first match wins.
version: 1

classification_rules:
  # PR review sessions — triggered by PR URL in the initial message.
  # Excludes sessions that also create PRs (those are pr-creation).
  - name: pr-review
    description: Pull request review sessions
    conditions:
      - field: first_user_message
        pattern: 'github\\.com/.+/pull/\\d+'
    exclude:
      - field: bash_commands
        pattern: 'gh pr create'

  # PR creation sessions — uses gh CLI to create pull requests.
  - name: pr-creation
    description: Pull request creation sessions
    conditions:
      - field: bash_commands
        pattern: 'gh pr create'

  # OpenSpec workflow — working with specs, proposals, designs, or tasks.
  # Requires both spec-related content AND the plan or build agent.
  - name: openspec-workflow
    description: Specification-driven workflow sessions
    conditions:
      - field: part_content
        pattern: 'openspec[/-]|proposal\\.md|design\\.md|tasks\\.md'
      - field: agent
        values: ["plan", "build"]

  # Multi-agent sessions — coordinated swarm agents (divisor, cobalt, gaze).
  - name: multi-agent
    description: Multi-agent coordination sessions
    conditions:
      - field: agent
        pattern: '^(divisor-|cobalt-|gaze-)'

  # Exploration sessions — investigating problems and ideas.
  - name: exploration
    description: Exploratory investigation sessions
    conditions:
      - field: agent
        values: ["explore"]

  # Planning sessions — designing solutions and architectures.
  - name: planning
    description: Planning and design sessions
    conditions:
      - field: agent
        values: ["plan"]

  # Implementation sessions — building features and fixing bugs.
  - name: implementation
    description: Code implementation sessions
    conditions:
      - field: agent
        values: ["build"]

  # Ad-hoc sessions — default fallback for unclassified work.
  # Empty conditions array means this rule always matches.
  - name: ad-hoc
    description: Unclassified sessions (default fallback)
    conditions: []

# Budget rules assign cost-tracking tags to sessions.
# Each rule's conditions work like classification rules (AND logic).
# Rules are evaluated in order; first match wins.
# budget_rules:
#   # Tag sessions by message prefix pattern
#   - budget_tag: project-alpha
#     conditions:
#       - field: first_user_message
#         pattern: '^\\[alpha\\]'
#
#   # Tag sessions by project name
#   - budget_tag: team-backend
#     conditions:
#       - field: project_name
#         values: ["api-service", "data-pipeline"]
#
#   # Combined pattern and values with exclusion
#   - budget_tag: infra-ops
#     conditions:
#       - field: agent
#         values: ["build"]
#       - field: first_user_message
#         pattern: 'terraform|ansible'
#     exclude:
#       - field: first_user_message
#         pattern: 'test|dry-run'
budget_rules: []
`;

/**
 * Pre-compile regex patterns on a condition during default config initialization.
 * Mirrors the compilation done in validateCondition() for user-provided configs.
 */
function compileConditionPattern(condition: ClassificationCondition): void {
	if (condition.pattern !== undefined) {
		condition.compiledPattern = new RegExp(condition.pattern);
	}
}

/** Parsed default configuration, ready for use as a fallback. */
export const DEFAULT_CONFIG: MetricsConfig = (() => {
	const config = parse(DEFAULT_CONFIG_YAML) as MetricsConfig;

	// Pre-compile regex patterns on default rules so they match the
	// shape produced by loadConfig() for user-provided configs.
	for (const rule of config.classification_rules) {
		for (const cond of rule.conditions) {
			compileConditionPattern(cond);
		}
		if (rule.exclude) {
			for (const cond of rule.exclude) {
				compileConditionPattern(cond);
			}
		}
	}

	// Ensure budget_rules exists and pre-compile any regex patterns.
	if (!Array.isArray(config.budget_rules)) {
		config.budget_rules = [];
	}
	for (const rule of config.budget_rules) {
		for (const cond of rule.conditions) {
			compileConditionPattern(cond);
		}
		if (rule.exclude) {
			for (const cond of rule.exclude) {
				compileConditionPattern(cond);
			}
		}
	}

	return config;
})();
