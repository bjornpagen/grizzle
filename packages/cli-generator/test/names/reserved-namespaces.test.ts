/**
 * Flags and commands are two namespaces (design 4.4), and a positional is in the flags' namespace. One operation holds
 * one drawn name at one drawn site: its command name, its group (tag), a query parameter's flag, a JSON body field's
 * flag, or a path parameter (a positional) beside a JSON body field of its name, of a name sharing its leading word, or
 * of none, renamed through the author config's `path:<name>` override or not. The name is ordinary, a reserved flag name
 * (Effect's built-in flags, the runtime's flags and their `no-` negations) or a reserved command name. Oracle: the
 * site's namespace alone decides. A command or group name is refused (`OPR-06/reserved-name`, `TAG-02/reserved-name`)
 * exactly when it is a reserved command name, a parameter or body flag (`PRM-02/flag-collision`,
 * `RQB-03/flag-collision`) exactly when it is a reserved flag name, and a positional (`PRM-02/flag-collision`) exactly
 * when a body field of its own name stands beside it unrenamed, each once at its own pointer with no command for the
 * operation; otherwise the operation is a command, at the path its site gives. An operation that folds to a runtime
 * flag's name, such as `follow`, is a command, and so is a group named like one; a positional and a field sharing only
 * a leading word do not collide.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect } from "effect"
import { Digest } from "effect/crypto"
import {
	expectedOf,
	featuresOf,
	type NamespaceFeature,
	nameSpace,
	outcomeOf
} from "#test/names/reserved-namespaces.fixtures.ts"
import { digestService } from "#test/support/digest.ts"

/**
 * A name is refused at a site exactly when that site's namespace holds it. Its budget is the count its suite stated
 * before the conversion, with positional-collision's 3 example cases folded in: 43 independent cases, and up to 100
 * steered while a situation is unreached.
 */
export const reservedNamespaces = property.explore(nameSpace, {
	needs: { dir: Scratch.dir, digest: digestService },
	situations: [
		"command admitted",
		"command refused",
		"group admitted",
		"group refused",
		"parameter admitted",
		"parameter refused",
		"body admitted",
		"body refused",
		"positional admitted",
		"positional refused",
		"a runtime flag's name as a command",
		"a runtime flag's name as a group",
		"a positional renamed past a body field",
		"a positional and a field sharing a leading word"
	],
	check:
		({ dir, digest }, k: Case<NamespaceFeature>) =>
		(c) =>
			Effect.gen(function* () {
				k.noteAll(featuresOf(c))
				const scratch = yield* dir
				const service = yield* digest
				const outcome = yield* Effect.provideService(outcomeOf(c, scratch), Digest.Digest, service)
				assert.deepEqual(
					outcome,
					expectedOf(c),
					"the site's namespace alone decides whether the name is refused"
				)
			}),
	oracle: {
		kind: "specification",
		name: "the site's namespace alone decides a refusal (design 4.4)"
	},
	kept: [],
	budget: { runs: 43, steered: 100 },
	kills: [
		{
			file: "packages/cli-generator/src/generate.ts",
			original: "\t\tif (diagnosis.refusals.length > 0) {",
			replacement: "\t\tif (diagnosis.refusals.length <= 0) {",
			why: "generate reads a diagnosis with refusals as clean and a clean one as refused, so the report holds the wrong refusals and commands; the property fails (CATCH's evidence, mutant cadc46d05f)."
		}
	]
})
