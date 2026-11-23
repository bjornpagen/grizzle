/**
 * Every read a login serves carries exactly the footprint its program reads and the key its delivered rows prove:
 * what generate records so that no runtime, HTTP layer, client or OpenAPI document derives either again.
 *
 * Over generated public schemas (test/support/oracle/public), each extended by a drawn law level (laws.ts) holding a
 * derived relation, and live logins drawn over them (test/support/served-login.ts liveLoginGen), whose first role
 * reads that relation and, wherever a field may carry a claim, reads through its query entry at a key a parameter binds (a
 * world relation its plan inlines), each login compiled as generate compiles it (adapter/served/compile.ts
 * snapshotCompiled, then servedEntryOf) and its file read back from the JSON value its text parses to:
 *
 * - Footprint: each read member's served footprint is the one the program's base-level IR climbs to
 *   (test/support/served-routes.ts climbedFootprint), named as installed under its role's names. The program's IR is
 *   the one its plan reads (program/workload/compile.ts workloadQueryRead), and the oracle is a second implementation
 *   over the same logical analysis's fixed facts: from each Base up every path to a root, the column carrying each
 *   field climbs through the nodes that keep its value, and a field routes by a parameter that ties it on every path;
 *   logical/routes.ts footprintOf pushes what each node's consumers read down from the roots instead.
 * - Key: a set read's served key is a KeySetProof over the physical analysis of its optimized root
 *   (lower/conservative/keys.ts keySetOf, its root evaluated once), within its heading and no wider than the canonical
 *   minimal key the analysis proves among it, or, where it proves none, every head field its decoder reads; an ordered
 *   read's is the fields of the completed order its root delivers in, and a paged read's the fields of its page's.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { lawLevelGen } from "#test/support/oracle/public/laws.ts"
import { drawnSchema, liveLoginGen } from "#test/support/served-login.ts"
import { type Feature, routesAndKeys } from "#test/unit/served/routes.fixtures.ts"

/**
 * A login's served reads carry the footprint their program reads, routed by the fields its parameters fix, and the key
 * their rows prove.
 *
 * Budget: its suite's count before the conversion (unit/served/routes: 60 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const aLoginsServedReadsCarryTheFootprintTheirProgramReadsRoutedByTheFieldsItsParametersFixAndTheKeyTheirRowsProve =
	property.explore((source) => [source.draw(caseSketchGen), source.draw(lawLevelGen)] as const, {
		needs: {},
		situations: [
			"a table a read routes by a parameter",
			"a table a read reads table-wide",
			"a read through a query entry",
			"a set read keyed narrower than its heading",
			"an ordered read",
			"a paged read"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			(_, notes: Case<Feature>) =>
			([sketch, level]) =>
				Effect.suspend(() => {
					const schema = drawnSchema(notes.draw(resolveCase(sketch)), level)
					return routesAndKeys(schema, level, notes.draw(liveLoginGen(schema)), notes.note)
				}),
		oracle: {
			kind: "second-implementation",
			name: "the footprint climbed from each Base up the program's fixed facts (test/support/served-routes.ts), and the KeySetProof of the optimized root"
		},
		budget: { runs: 60, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/routes.ts",
				original:
					"\t\ttables.set(relation, new Map(routes.toSorted(([a], [b]) => compareStrings(a, b))))",
				replacement:
					"\t\ttables.set(relation, new Map(routes.toSorted(([a], [b]) => compareStrings(a, b)).slice(0, -1)))",
				why: "footprintOf drops each table's last routed field; the footprint property fails."
			},
			{
				file: "packages/engine/src/logical/routes.ts",
				original:
					"\t\ttables.set(relation, new Map(routes.toSorted(([a], [b]) => compareStrings(a, b))))",
				replacement:
					"\t\tconst [firstColumn] = (occurrences[0]?.heading ?? []).filter((c) => routable[c.type.carrier])\n\t\tconst [firstParam] = named.values()\n\t\tif (routes.length === 0 && firstColumn !== undefined && firstParam !== undefined) {\n\t\t\troutes.push([firstColumn.name, firstParam])\n\t\t}\n\t\ttables.set(relation, new Map(routes.toSorted(([a], [b]) => compareStrings(a, b))))",
				why: "footprintOf routes a table its program reads table-wide by its first column, under the program's first parameter; the footprint property fails (and routes-sound.test.ts's)."
			},
			{
				file: "packages/engine/src/program/served.ts",
				original:
					'\treturn { kind: "set", fields: proof.kind === "proved" ? proof.key.columns : headFields }',
				replacement: '\treturn { kind: "set", fields: headFields }',
				why: "A set read is keyed by every head field where a narrower key is proved (program/served.ts templateKey); the key property fails."
			}
		]
	})
