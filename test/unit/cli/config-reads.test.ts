/**
 * A configuration loads whatever its migrations directory holds, and one that reads it is refused the first time it
 * does. A consumer's configuration reaches its flows' modules through its logins and their workloads, and a flow decodes
 * a domain's values through the key holder's checked mint where it is declared; the mint's checker is derived from the
 * contract itself (contract/parser.ts domainParserOf), so nothing the configuration imports is a file `grizzle
 * generate` writes, and a generate that rewrites every file, whatever state a repin or a hand left them in, always runs.
 * A configuration whose modules import such a file is refused at its first stage, naming each file
 * (ConfigReadsGenerated), while the file still reads, never left to stop loading at the next format change.
 *
 * The box: the project den and metis build (a contract, the key holder's checked mint of it, a schema holding it, a
 * flow's module decoding through the mint where it is declared, the logins over it and the configuration over those),
 * drafted from nothing; then every file generate wrote garbled, made of another format, or removed, and generate run
 * again: it loads the configuration, any refusal at a later stage, and once the migrations directory is purged, the
 * remedy an artifact of another format has, it writes every file byte for byte as the first draft did. And the same
 * project with its flow's module importing the login's served file generate wrote: refused at the configuration's stage,
 * naming that file. Each generate runs over a copy of its own, so every module is imported anew.
 *
 * Oracle: specification, generate's report at each step and the first draft's files.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { workspace } from "#test/support/pg/cli/support.ts"
import {
	type Corruption,
	corrupt,
	generatedFrom,
	generatedTree,
	importing,
	purged,
	refusedAtConfig,
	servedFileOf,
	type Shape,
	shapes,
	writeProject
} from "#test/unit/cli/config-reads.fixtures.ts"

type Situation = `builds its checked mint, ${Corruption}` | "imports a generated file"

/**
 * Generate loads a consumer's configuration whatever its migrations directory holds and regenerates every file byte for
 * byte, and refuses at its first stage a configuration that reads a file it writes.
 */
export const aConfigurationLoadsWhateverItsMigrationsHoldAndOneThatReadsThemIsRefused =
	property.exhaust(finite(shapes), {
		box: "the project den and metis build, every file generate wrote then garbled, made of another format or removed; and the project importing its login's served file from its flow's module",
		needs: {},
		situations: [
			"builds its checked mint, garbled",
			"builds its checked mint, another format",
			"builds its checked mint, removed",
			"imports a generated file"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (shape: Shape) =>
			Effect.scoped(
				Effect.gen(function* () {
					const project = yield* workspace("config-reads-base")
					yield* writeProject(project, "")
					const first = yield* generatedFrom(project)
					assert.equal(first.report.outcome, "ran", "the project is drafted from nothing")
					const tree = yield* generatedTree(first.copy)
					if (shape.kind === "imports a generated file") {
						c.note("imports a generated file")
						const served = servedFileOf(tree)
						yield* writeProject(first.copy, importing(served))
						const reading = yield* generatedFrom(first.copy)
						assert.ok(
							reading.report.outcome === "refused" &&
								reading.report.refusal._tag === "CliError" &&
								reading.report.refusal.reason._tag === "ConfigReadsGenerated" &&
								Arr.some(
									reading.report.refusal.reason.read,
									Str.endsWith(Str.slice("migrations".length)(served))
								),
							"a configuration whose flow's module imports the served file generate wrote is refused at its first stage, naming it"
						)
						return
					}
					c.note(`builds its checked mint, ${shape.corruption}`)
					yield* corrupt(first.copy, tree, shape.corruption)
					const again = yield* generatedFrom(first.copy)
					assert.ok(
						!refusedAtConfig(again.report),
						`with every file generate wrote ${shape.corruption}, generate loads the configuration`
					)
					yield* purged(again.copy)
					const regenerated = yield* generatedFrom(again.copy)
					assert.equal(regenerated.report.outcome, "ran", "the purged project is drafted again")
					const rewritten = yield* generatedTree(regenerated.copy)
					assert.deepEqual(
						rewritten,
						tree,
						"generate writes every file byte for byte as the first draft did"
					)
				})
			),
		oracle: {
			kind: "specification",
			name: "generate's report at each step, and the first draft's files"
		},
		kept: [],
		kills: [
			{
				file: "test/unit/cli/config-reads.fixtures.ts",
				original: "export const centsParser = gDomain.domainParser(Cents, centsKey)\n",
				replacement:
					'import checker from "./migrations/contract-checks/Cents.json" with { type: "json" }\nexport const centsParser = [gDomain.domainParser(Cents, centsKey), checker][0]\n',
				why: "The key holder's mint reads a file generate writes again, as domainParser(file, contract, key) read the contract's checker file: the first draft's configuration does not load, the file not yet written, and no corruption of the migrations directory leaves it loading."
			},
			{
				file: "packages/grizzle/src/cli/config.ts",
				original: "\treturn Arr.isReadonlyArrayNonEmpty(read)\n",
				replacement: "\treturn Arr.isReadonlyArrayNonEmpty(read.slice(0, 0))\n",
				why: "A configuration that reads a file generate writes is let through: the project importing its served file generates, where it is refused at its first stage, and would stop loading at the next format change."
			}
		]
	})
