import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, element, type Gen, int, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer } from "effect"
import { compiledOpen } from "#adapter/db/open.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { contained, mutable, on, relation, schema } from "#compiler/public/schema.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, deepEquals, unorderedEqual } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { loginLayer } from "#test/support/worlds.ts"

/**
 * Plain foreign keys on a cycle, through db.apply, against a host model of containment: A's `b` is contained in B's
 * key and B's `a` in A's, each target holding a field outside its key, so both foreign keys are deferred and judged at
 * COMMIT. A ChangeSet that inserts facts of both relations naming each other, in one stratum, commits; one whose final
 * state leaves a reference without its target, an insertion naming a fact nobody holds or a deletion of a fact still
 * named, is refused at COMMIT by the law of a reference it breaks, and nothing of it commits.
 *
 * Each case draws a lawful stored state over ids 1 to 3 and a ChangeSet of insertions of facts at ids nobody stores,
 * referencing ids 1 to 4, and deletions of stored facts. The model: the final state is the stored one less the
 * deletions plus the insertions; it is accepted when every reference meets its target there, with every fact counted,
 * no-change when the ChangeSet changes nothing, and otherwise refused by a law of the references it breaks.
 */
const A = relation("A", { id: pg.integer, b: pg.integer }, ["id"])
const B = relation("B", { id: pg.integer, a: pg.integer }, ["id"])
const intoB = contained(on(A, "b"), on(B, "id"))
const intoA = contained(on(B, "a"), on(A, "id"))
const Cycle = schema("Cycle", { A, B }, [intoB, intoA, mutable(A), mutable(B)])

/** A fact of either relation: its key and the key it references in the other. */
interface Fact {
	readonly id: number
	readonly ref: number
}

/** A lawful stored state: A's ids, B's ids, each fact referencing one of the other's, or nothing stored at all. */
interface Stored {
	readonly a: ReadonlyArray<Fact>
	readonly b: ReadonlyArray<Fact>
}

const storedGen: Gen<Stored> = (source) => {
	const aIds = source.draw(subarray([1, 2, 3]))
	const bIds = source.draw(subarray([1, 2, 3]))
	if (!Arr.isReadonlyArrayNonEmpty(aIds) || !Arr.isReadonlyArrayNonEmpty(bIds)) {
		return { a: [], b: [] }
	}
	return {
		a: Arr.map(aIds, (id) => ({ id, ref: source.draw(element(bIds)) })),
		b: Arr.map(bIds, (id) => ({ id, ref: source.draw(element(aIds)) }))
	}
}

/** A ChangeSet over the stored state: insertions at ids nobody stores, and deletions of stored facts. */
interface Requested {
	readonly insertA: ReadonlyArray<Fact>
	readonly insertB: ReadonlyArray<Fact>
	readonly deleteA: ReadonlyArray<Fact>
	readonly deleteB: ReadonlyArray<Fact>
}

const minus = (xs: ReadonlyArray<Fact>, ys: ReadonlyArray<Fact>): ReadonlyArray<Fact> =>
	Arr.filter(xs, (x) => !Arr.some(ys, (y) => y.id === x.id))

/** The ids 1 to 4 no fact of `stored` holds: where an insertion may go. */
const freeIds = (stored: ReadonlyArray<Fact>): ReadonlyArray<number> =>
	Arr.filter([1, 2, 3, 4], (id) => !Arr.some(stored, (f) => f.id === id))

/**
 * A stored state and a ChangeSet over it: insertions at ids nobody stores, and deletions of stored facts. In the case's
 * lawful arm each insertion references a key the other relation holds after the ChangeSet, its kept facts' or its
 * insertions', so facts inserted together name each other; otherwise any id 1 to 4, keys nobody holds among them.
 */
const caseGen: Gen<readonly [Stored, Requested]> = (source) => {
	const stored = source.draw(storedGen)
	const deleteA = source.draw(subarray(stored.a))
	const deleteB = source.draw(subarray(stored.b))
	const idsA = source.draw(subarray(freeIds(stored.a)))
	const idsB = source.draw(subarray(freeIds(stored.b)))
	const lawful = source.draw(boolean)
	const into = (kept: ReadonlyArray<Fact>, inserted: ReadonlyArray<number>): Gen<number> => {
		const keys = [...Arr.map(kept, (f) => f.id), ...inserted]
		return lawful && Arr.isReadonlyArrayNonEmpty(keys) ? element(keys) : int(1, 4)
	}
	const keyOfB = into(minus(stored.b, deleteB), idsB)
	const keyOfA = into(minus(stored.a, deleteA), idsA)
	return [
		stored,
		{
			insertA: Arr.map(idsA, (id) => ({ id, ref: source.draw(keyOfB) })),
			insertB: Arr.map(idsB, (id) => ({ id, ref: source.draw(keyOfA) })),
			deleteA,
			deleteB
		}
	] as const
}

/** The references of `from` without their target among `to`'s keys. */
const dangling = (from: ReadonlyArray<Fact>, to: ReadonlyArray<Fact>): boolean =>
	Arr.some(from, (f) => !Arr.some(to, (t) => t.id === f.ref))

type CycleFeature =
	| "accepted"
	| "no-change"
	| "a cycle inserted in one ChangeSet"
	| "refused by A's reference"
	| "refused by B's reference"
	| "a deletion of a fact still named, refused"

layer(Substrate.layer, { excludeTestServices: true })("plain foreign keys on a cycle", (it) => {
	it.effect(
		"commit a ChangeSet whose final state meets every reference, and refuse one that breaks one at COMMIT",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const o = yield* installed(Cycle, {}, { label: "cycle", extensions: [], programs: {} })
					const s = yield* Substrate
					const names = namesOf(o.installed)
					const laws = {
						a: names.described(names.lawOf(intoB)),
						b: names.described(names.lawOf(intoA))
					}
					return yield* Effect.gen(function* () {
						const db = yield* compiledOpen(o.server.roles.app, {})
						return yield* explore(
							{
								suite: "pg/write/cycle",
								draw: drawn(caseGen),
								literal: Formatter.format,
								coverage: required<CycleFeature>(
									[
										"accepted",
										"no-change",
										"a cycle inserted in one ChangeSet",
										"refused by A's reference",
										"refused by B's reference",
										"a deletion of a fact still named, refused"
									],
									{ cases: 80, sense: notesOnly }
								),
								kept: [],
								runs: 80,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang,
								oracle: { kind: "specification", name: "a host model of containment at COMMIT" }
							},
							([stored, requested], c) =>
								Effect.gen(function* () {
									const insert = (table: string, columns: string, f: Fact) => ({
										sql: `INSERT INTO ${table} (${columns}) VALUES ($1::int4, $2::int4)`,
										params: [String(f.id), String(f.ref)]
									})
									yield* replaceRows(s.admin, installationGroup(names), [
										...Arr.map(stored.a, (f) =>
											insert(names.table(A), `${names.column(A, "id")}, ${names.column(A, "b")}`, f)
										),
										...Arr.map(stored.b, (f) =>
											insert(names.table(B), `${names.column(B, "id")}, ${names.column(B, "a")}`, f)
										)
									])
									const outcome = yield* db.apply(
										ChangeSet.empty(o.schema)
											.insert(
												A,
												Arr.map(requested.insertA, (f) => ({ id: f.id, b: f.ref }))
											)
											.insert(
												B,
												Arr.map(requested.insertB, (f) => ({ id: f.id, a: f.ref }))
											)
											.delete(
												A,
												Arr.map(requested.deleteA, (f) => ({ id: f.id, b: f.ref }))
											)
											.delete(
												B,
												Arr.map(requested.deleteB, (f) => ({ id: f.id, a: f.ref }))
											),
										{}
									)
									const finalA = [...minus(stored.a, requested.deleteA), ...requested.insertA]
									const finalB = [...minus(stored.b, requested.deleteB), ...requested.insertB]
									const brokenA = dangling(finalA, finalB)
									const brokenB = dangling(finalB, finalA)
									const stateA = yield* tableState(o.installed, A)
									const stateB = yield* tableState(o.installed, B)
									if (brokenA || brokenB) {
										if (outcome.kind !== "invariant-rejected") {
											return assert.fail(`a refusal by a reference, not ${outcome.kind}`)
										}
										assert.ok(
											outcome.refused.laws.length > 0 &&
												Arr.every(
													outcome.refused.laws,
													(law) =>
														(brokenA && deepEquals(law, laws.a)) ||
														(brokenB && deepEquals(law, laws.b))
												),
											"the refusal names a law of a reference the final state breaks"
										)
										c.noteAll([
											...(brokenA ? (["refused by A's reference"] as const) : []),
											...(brokenB ? (["refused by B's reference"] as const) : [])
										])
										if (
											Arr.some(requested.deleteA, (d) => Arr.some(finalB, (f) => f.ref === d.id)) ||
											Arr.some(requested.deleteB, (d) => Arr.some(finalA, (f) => f.ref === d.id))
										) {
											c.note("a deletion of a fact still named, refused")
										}
										unorderedEqual(
											stateA,
											Arr.map(stored.a, (f) => ({ id: f.id, b: f.ref }))
										)
										unorderedEqual(
											stateB,
											Arr.map(stored.b, (f) => ({ id: f.id, a: f.ref }))
										)
										return
									}
									unorderedEqual(
										stateA,
										Arr.map(finalA, (f) => ({ id: f.id, b: f.ref }))
									)
									unorderedEqual(
										stateB,
										Arr.map(finalB, (f) => ({ id: f.id, a: f.ref }))
									)
									const changed =
										requested.insertA.length +
										requested.insertB.length +
										requested.deleteA.length +
										requested.deleteB.length
									if (changed === 0) {
										assert.equal(outcome.kind, "no-change")
										c.note("no-change")
										return
									}
									if (outcome.kind !== "accepted") {
										return assert.fail(`accepted, not ${outcome.kind}`)
									}
									c.note("accepted")
									if (
										Arr.some(requested.insertA, (f) =>
											Arr.some(requested.insertB, (g) => g.id === f.ref && g.ref === f.id)
										)
									) {
										c.note("a cycle inserted in one ChangeSet")
									}
								})
						)
					}).pipe(
						(body) =>
							Effect.flatMap(Layer.build(loginLayer(o.installed, o.server)), (context) =>
								Effect.provideContext(body, context)
							),
						Effect.scoped
					)
				}).pipe(Effect.scoped)
			)
	)
})
