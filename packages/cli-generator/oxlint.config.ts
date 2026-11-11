import { active, lintConfig } from "@superstarter/devtools/preset"
import { CLOCK_RULES, TEST_RULES } from "@superstarter/testing/oxlint"
import { defineConfig } from "oxlint"
import manifest from "#package.json" with { type: "json" }

/** The fork's lists for the lint standard; everything else comes from the dev tools' preset. */
export default defineConfig(
	lintConfig({
		ignorePatterns: ["packages/devtools/src/*/fixtures/**", "packages/generator/test/fixtures/**"],
		restrictedImports: { paths: [], patterns: [] },
		restrictedGlobals: [],
		restrictedProperties: [],
		unassignedImports: [],
		effectFree: manifest.superlint.effectFree,
		ceremony: ["packages/devtools/**", "**/*.test.ts", "**/scripts/**"],
		plugin: {
			"bearer-owners": { owners: [] },
			"brands-sole-mint": { mints: [] },
			"import-doors": { doors: [] },
			"no-dynamic-imports": { allowed: [] }
		},
		tests: {
			jsPlugin: "@superstarter/testing/oxlint",
			rules: TEST_RULES,
			clock: { files: ["packages/testing/src/**"], rules: CLOCK_RULES }
		},
		overrides: [
			{
				files: ["packages/testing/src/live.ts"],
				rules: active({
					/** The live clock a case's hang guard and a fuzz run's time budget read: its job is the clock. */
					"testing/no-wall-clock-verdict": "off"
				})
			},
			{
				files: ["packages/testing/src/witness.fixtures.ts"],
				rules: active({
					/** A type test's refusal is a `@ts-expect-error` that names what it refuses. */
					"typescript/ban-ts-comment": [
						"error",
						{
							"ts-check": true,
							"ts-expect-error": "allow-with-description",
							"ts-ignore": true,
							"ts-nocheck": true
						}
					]
				})
			}
		]
	})
)
