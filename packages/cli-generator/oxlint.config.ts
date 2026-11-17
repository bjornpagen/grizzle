import { standard } from "@bjornpagen/devtools/preset"
import {
	CASE_LISTS,
	CLOCK_RULES,
	EVERY_FILE_RULES,
	MODULE_RULES,
	TEST_RULES
} from "@bjornpagen/testing/oxlint"
import { defineConfig } from "oxlint"
import toolchain from "#toolchain.config.ts"

const { active, lintConfig } = standard(toolchain)

/** The fork's lists for the lint standard; everything else comes from the dev tools' preset. */
export default defineConfig(
	lintConfig({
		ignorePatterns: ["packages/generator/test/fixtures/**", "vendor/**"],
		restrictedImports: {
			paths: [
				{
					name: "@effect/platform-node",
					message:
						"Import each platform module from its own path (`import * as NodeServices from \"@effect/platform-node/NodeServices\"`): the package's index loads every platform module, its Redis client's 647 modules among them, about 0.39 s of CPU in every process that imports it."
				}
			],
			patterns: []
		},
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
			"no-spread-argument": { tuples: [] },
			"no-case-list": {
				searches: CASE_LISTS.searches,
				generators: [
					...CASE_LISTS.generators,
					{
						module: "#test/support/steering.ts",
						names: ["aimedAmong"],
						draws: "each"
					}
				],
				mints: CASE_LISTS.mints,
				cases: [],
				dictionaries: []
			},
			"single-permit-owners": {
				owners: [
					{
						file: "packages/generator/test/support/connection.ts",
						reason:
							"A listener's observations take turns (makeSessions' observe): its one port serves the current observation's state, so a connection it accepts is served under the observation that made it; two observations at once would serve one's connections under the other's state."
					}
				]
			}
		},
		ownPlugins: [],
		tests: {
			library: "installed",
			jsPlugin: "@bjornpagen/testing/oxlint",
			rules: TEST_RULES,
			modules: MODULE_RULES,
			everyFile: EVERY_FILE_RULES,
			clock: { files: [], rules: CLOCK_RULES }
		},
		overrides: [
			{
				files: ["packages/generator/test/support/capture-server.ts"],
				rules: active({
					/** The capture server plays its script: a scripted response's delay and each chunk's delay are what the property drew for the server to do (an idle stream, a late answer), the behaviour the generated CLI is checked against, never a wait for a fact. */
					"testing/no-sleep-wait": "off"
				})
			}
		]
	})
)
