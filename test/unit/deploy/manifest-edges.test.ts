/**
 * A manifest's edges (physical/obligations/graph.ts namedEdges, the obligation graph's order, deploy/snapshot/build.ts
 * targetState): every object an object's statements name is one the edges create it after, so every reader of the
 * edges (the install order, the diff's orders over it, the drift check's replay and its proof digests) has it first.
 *
 * - **Property:** each schema drafted fresh, for every object of its manifest, every other object whose name the
 *   printed text of its replayed statements holds is reached from it by the edges, and every edge runs from an earlier
 *   object of the install order to a later one.
 * - **Oracle:** specification: the objects a statement names read off its printed text, each name quoted as grizzle
 *   prints it (test/support/migrate/proofs.ts printedNames), never off its tree; the closure over the edges as recorded.
 * - **Space:** generated schemas (install.fixtures.ts generatedGen), aimed at a set's schema (schemas.ts setsSchema, each
 *   version) whose table's CHECK and generated field cast a singleton's literal to the roster's bits domain, which no
 *   column of the table is typed by and only the casts name.
 * - **Features:** an object naming another, and a set's domain a table's cast names.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed, int, type Space } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { parseIdent } from "#compiler/physical/obligations/graph.ts"
import { firstCodes } from "#test/support/compile.ts"
import { atName } from "#test/support/kernel/naming.ts"
import {
	type DeploySubject,
	draftChain,
	fromEmpty,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import { printedNames } from "#test/support/migrate/proofs.ts"
import { setChanges, setsSchema } from "#test/support/unit/deploy/schemas.ts"
import { generatedGen } from "#test/support/unit/physical/install.fixtures.ts"

type EdgeFeature = "an object naming another" | "a set's domain a table's cast names"

/** Each version of the set's schema: its first, and each change of its table. */
const setsSpace: Space<DeploySubject> = (source) => {
	const versions = ["first", ...setChanges] as const
	return setsSchema(defined(versions[source.draw(int(0, versions.length - 1))], "a version"))
}

/** A generated schema, as a draft reads it. */
const generatedSpace: Space<DeploySubject> = (source) => generatedGen(source)

/** Every object a manifest's statements name is one its edges create it after, and the install order keeps every edge. */
export const everyObjectAStatementNamesIsOneItsEdgesCreateItAfter = property.explore(
	aimed(generatedSpace, [["a set's domain a table's cast names", setsSpace]]),
	{
		needs: {},
		budget: { runs: 40, steered: 40 },
		situations: [
			"an object naming another",
			"a set's domain a table's cast names"
		] satisfies ReadonlyArray<Reached<EdgeFeature>>,
		check: (_, c: Case<EdgeFeature>) => (desc) =>
			Effect.sync(() => {
				const [drafted] = draftChain(
					[
						{
							desc,
							options: { schema: atName("edges"), logins: [], extensions: [], codes: firstCodes },
							declared: noDeclarations
						}
					],
					fromEmpty
				)
				const snapshot = defined(drafted, "a draft").snapshot
				const place = new Map(Arr.map(snapshot.manifest.objects, (o, at) => [o.ident, at] as const))
				const after = new Map<string, Array<string>>()
				for (const e of snapshot.manifest.edges) {
					assert.ok(
						defined(place.get(e.from), e.from) < defined(place.get(e.to), e.to),
						`${e.from} before ${e.to} in the install order`
					)
					after.set(e.to, [...(after.get(e.to) ?? []), e.from])
				}
				/** Every object `ident` is created after, through the edges. */
				const closure = (ident: string): ReadonlySet<string> => {
					const reached = new Set<string>()
					const pending = [...(after.get(ident) ?? [])]
					for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
						if (!reached.has(at)) {
							reached.add(at)
							for (const from of after.get(at) ?? []) {
								pending.push(from)
							}
						}
					}
					return reached
				}
				for (const [ident, named] of printedNames(snapshot)) {
					const reached = closure(ident)
					for (const name of named) {
						c.note("an object naming another")
						assert.ok(reached.has(name), `${ident} names ${name}, which its edges create it after`)
						if (
							parseIdent(ident).kind === "table" &&
							parseIdent(name).kind === "domain" &&
							Str.includes("_bits_")(name)
						) {
							c.note("a set's domain a table's cast names")
						}
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the objects a statement names, read off its printed text by each object's quoted name, against the edges' closure"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/obligations/graph.ts",
				original: '\t\t\t\t\tnamed("type", t.schema, t.name)\n',
				replacement: "",
				why: "No edge runs from a type a cast or a literal names, so a table whose CHECK casts to a set's bits domain, which no column of it is typed by, is created after no edge of the domain, and every reader of the edges (the replay among them) may build the table without it."
			}
		]
	}
)
