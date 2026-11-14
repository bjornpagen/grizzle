import { standard } from "@bjornpagen/devtools/preset"
import { CLOCK_RULES, EVERY_FILE_RULES, TEST_RULES } from "@bjornpagen/testing/oxlint"
import { defineConfig } from "oxlint"
import toolchain from "#toolchain.config.ts"

const { lintConfig } = standard(toolchain)

/** The fork's lists for the lint standard; everything else comes from the dev tools' preset. */
export default defineConfig(
	lintConfig({
		ignorePatterns: ["packages/generator/test/fixtures/**", "vendor/**"],
		restrictedImports: { paths: [], patterns: [] },
		restrictedGlobals: [],
		restrictedProperties: [],
		unassignedImports: [],
		environment: { library: [], readers: [] },
		ceremony: ["**/*.test.ts", "**/scripts/**"],
		plugin: {
			"bearer-owners": {
				owners: ["packages/generator/src/runtime-src/runtime/auth.ts"]
			},
			"brands-sole-mint": { mints: [] },
			"import-doors": { doors: [] },
			"no-dynamic-imports": { allowed: [] },
			"no-raw-sql": { sources: [], writers: [] },
			"no-spread-argument": { tuples: [] }
		},
		ownPlugins: [],
		tests: {
			library: "installed",
			jsPlugin: "@bjornpagen/testing/oxlint",
			rules: TEST_RULES,
			everyFile: EVERY_FILE_RULES,
			clock: { files: [], rules: CLOCK_RULES }
		},
		overrides: []
	})
)
