/**
 * Design 4.4's credential names through the pipeline (resolve, normalize, the names plan): over security schemes of
 * every kind the runtime sends (bearer, basic, an API key, mutual TLS) under names drawn to fold alike, to fold to
 * nothing and to take the runtime's own settings, each used by one operation, some with an author-config environment
 * name and some overrides naming no scheme, a token scheme gets `<PREFIX>_<SLUG>` (or its configured env) and
 * `--<slug>-file`, and a mutual TLS scheme `<PREFIX>_<SLUG>_CERT`, `_KEY` and `_CA`; an operation using a scheme whose
 * names another credential, a runtime setting (`BASE_URL`, `TIMEOUT`, `IDLE_TIMEOUT`, `ERROR_FORMAT`) or a reserved flag
 * also takes is refused SSC-01/credential-collision, one using a scheme folding to nothing SSC-01/empty-name, and every
 * other operation is a command; an override naming no scheme is a CFG-1/unmatched-override notice.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	credentialSpace,
	expectedOf,
	type Feature,
	featuresOf
} from "#test/names/credential-collision-mtls.fixtures.ts"

/**
 * A drawn set of schemes is planned as design 4.4's credential names say. Its budget replaces 9 example cases
 * (credential-collision-mtls 4, plan's credentials 5): 9 independent cases, and up to 26 steered while one of its 13
 * situations is unreached, each reached by its own aimed arm.
 */
export const schemeCredentials = property.explore(credentialSpace, {
	needs: {},
	situations: [
		"a token kept",
		"a certificate kept",
		"two tokens folding to one env",
		"two certificates folding to one slug",
		"a certificate env a token also takes",
		"a token env taking BASE_URL",
		"a token env taking TIMEOUT",
		"a token env taking IDLE_TIMEOUT",
		"a token env taking ERROR_FORMAT",
		"a name folding to nothing",
		"a configured env",
		"an override naming no scheme",
		"the prefix from the bin name"
	],
	check: (_, k: Case<Feature>) => (c) =>
		Effect.gen(function* () {
			k.noteAll(featuresOf(c))
			const actual = yield* actualOf(c)
			assert.deepEqual(actual, expectedOf(c))
		}),
	oracle: {
		kind: "specification",
		name: "design 4.4's token and certificate names, their collisions, empty names and unmatched overrides"
	},
	kept: [],
	budget: { runs: 9, steered: 26 },
	kills: [
		{
			file: "packages/generator/src/normalize/security.ts",
			original: "\t\tif (declared === undefined) {",
			replacement: "\t\tif (declared !== undefined) {",
			why: "Normalize refuses every security requirement naming a declared scheme and reaches every undeclared one, so each secured operation is refused; the property fails (CATCH's evidence, mutant 5dff77b919)."
		},
		{
			file: "packages/generator/src/model/entities.ts",
			original: '["basic", "bearer"]',
			replacement: '["basic"]',
			why: "HTTP bearer is no scheme the model admits, so a bearer scheme's operations lose their credential; the property fails (CATCH's evidence, mutant 8996dfcb66)."
		},
		{
			file: "packages/generator/src/names/index.ts",
			original: "names.set(scheme.name, credential.value)",
			replacement: "{}",
			why: "No used scheme gets credential names, so no credential is planned and no collision is found; the property fails (CATCH's evidence, mutant 5eba3d89dc)."
		},
		{
			file: "packages/generator/src/names/index.ts",
			original: "!schemes.has(name)",
			replacement: "schemes.has(name)",
			why: "A security override naming a declared scheme is reported unmatched and one naming no scheme is not; the property fails (CATCH's evidence, mutant 0bf3e2aa91)."
		},
		{
			file: "packages/generator/src/names/reserved.ts",
			original: '[\n\t"BASE_URL",\n\t"ERROR_FORMAT",\n\t"IDLE_TIMEOUT",\n\t"TIMEOUT"\n]',
			replacement: '["BASE_URL", "ERROR_FORMAT", "TIMEOUT"]',
			why: "IDLE_TIMEOUT is no runtime setting to the plan, so a scheme named idleTimeout takes the runtime's idle-timeout variable; the property fails (CATCH's evidence, mutant e4c8b3d051)."
		}
	]
})
