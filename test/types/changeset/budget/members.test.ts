/**
 * The ChangeSet members' type cost against the schema they write (changeset/budget/members.ts): for each op, a delete,
 * a put, an insert or an insertAll's key, and each member kind, a query or an array of facts, the program of `members`
 * members and the program of twice as many, each checked alone over a schema of `small` relations and over one of
 * `large`, as edullm's pantry writes one member per relation of a schema of hundreds (its replaceWrite).
 *
 * Property: instantiations per ChangeSet member are invariant in schema size. The members the second program adds, its
 * last `members` members, cost exactly as many instantiations over the large schema as over the small one:
 * I(large, 2k) − I(large, k) = I(small, 2k) − I(small, k). What the first member reads of the schema once, its index of
 * families, its relations' union, is in both programs of a schema and cancels; a member that reads the schema again
 * costs more over the larger one, by every relation it walks, for each member. Every program typechecks with no
 * diagnostic. Oracle: the compiler's own counts (test/types/batch/measured.ts), compared across the two schemas.
 *
 * @plant test/plants/types/changeset/budget/contexts-bundle-bound.patch ContextsOf binds a program's phantom whole
 * (`Q extends Phantom<infer B>`) before it reads its contexts: B holds the schema, and each read of it instantiates the
 * schema again, so each query member's contexts walk every relation; the query members' cost grows with the schema.
 * @plant test/plants/types/changeset/budget/params-member-matched.patch ParamsOf tells a member by testing it whole
 * (`X extends ReadonlyArray<unknown> | Stream.Stream<…>`): the test instantiates the query member, its schema with it,
 * so each query member walks every relation; the query members' cost grows with the schema.
 * @plant test/plants/types/changeset/budget/array-member-boxed.patch ArrayAdded tells an array member by testing the
 * member boxed (`[M] extends [ReadonlyArray<unknown>]`): the box holds the query member, and the test instantiates it
 * whole, its schema with it; the query members' cost grows with the schema.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { assert, defined } from "#test/support/assert.ts"
import type { PreludeAt } from "#test/support/prelude.ts"
import { assertClean, measuredEach } from "#test/types/batch/measured.ts"
import { memberKinds, memberOps, memberSource } from "#test/types/changeset/budget/members.ts"

/**
 * The members of the first program, and the schemas' sizes. The second program writes twice as many members, each over
 * a relation of its own, so the small schema holds that many relations; the large one holds four times as many, so a
 * member that walks the schema walks every relation the large schema adds, three for each relation of the small one,
 * for each member the second program adds.
 */
const members = 5
const small = 2 * members
const large = 4 * small

/** The four programs of one op and kind, in order: `members` and twice as many members, over each schema. */
const shapes = [
	{ relations: small, members },
	{ relations: small, members: 2 * members },
	{ relations: large, members },
	{ relations: large, members: 2 * members }
] as const

layer(NodeServices.layer, { excludeTestServices: true })("the ChangeSet-member programs", (it) => {
	for (const op of memberOps) {
		for (const kind of memberKinds) {
			it.effect(
				`each ${kind} member of ${op} costs as many instantiations over ${large} relations as over ${small}`,
				() =>
					Effect.gen(function* () {
						const measured = yield* measuredEach(
							"test/types/changeset",
							Arr.map(shapes, (at) => ({
								size: at.relations,
								source: (entries: PreludeAt) => memberSource({ ...at, op, kind }, entries)
							}))
						)
						for (const m of measured) {
							assertClean(m, `${op} of ${kind} members`)
						}
						const count = (i: number): number =>
							defined(measured[i], `the program of ${op} at ${i}`).instantiations
						const added = { small: count(1) - count(0), large: count(3) - count(2) }
						assert.equal(
							added.large,
							added.small,
							`the last ${members} ${kind} members of ${op} cost ${added.large} instantiations over ${large} relations and ${added.small} over ${small}`
						)
					})
			)
		}
	}
})
