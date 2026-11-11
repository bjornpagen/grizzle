import { Array as Arr, Record } from "effect"
import { defineConfig } from "oxlint"
import { FIXTURE_RULES } from "#oxlint/fixture-rules.ts"

/**
 * The oxlint configuration the plugin's fixtures run under: no built-in rule, and each plugin rule on its own fixture
 * directory only, with options that point into that directory. src/oxlint/fixtures.ts runs oxlint with it.
 */
export default defineConfig({
	plugins: [],
	jsPlugins: [`${import.meta.dirname}/../oxlint-plugin.ts`],
	categories: {
		correctness: "off",
		nursery: "off",
		pedantic: "off",
		perf: "off",
		restriction: "off",
		style: "off",
		suspicious: "off"
	},
	options: { respectEslintDisableDirectives: false },
	overrides: Arr.map(Record.toEntries(FIXTURE_RULES), ([rule, options]) => ({
		files: [`fixtures/${rule}/**`],
		rules: { [`devtools/${rule}`]: options === null ? "error" : ["error", options] }
	}))
})
