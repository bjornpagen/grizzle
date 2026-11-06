import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, oneOf } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { mutable, relation, schema } from "#compiler/public/schema.ts"
import { printTableName, quoteIdent } from "#compiler/sql/print.ts"
import type { Carrier } from "#compiler/write/carriers/carriers.ts"
import { changeSetDesc } from "#compiler/write/changeset/value.ts"
import type { WriteArtifact } from "#compiler/write/program/artifact.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { assert, defined, nonEmpty, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking, owning } from "#test/support/policy.ts"
import { expectSqlstate } from "#test/support/substrate/expect.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A delta carrier is keyed by its relation's primary key (write/carriers relationCarrier, sql/ast.ts CreateCarrier):
 * created as a write program creates it, it holds a set of the relation's facts by that key at the end of every
 * statement, whatever order PostgreSQL runs one statement's sibling data-modifying CTEs in.
 *
 * The oracle is PostgreSQL as the judge of the key, against the specification turned into a checker: facts written to
 * the carrier are accepted exactly when no two share the relation's key, an identical fact written twice included, and
 * the carrier then holds them; otherwise the statement that writes the second is refused with 23505 on the carrier. One
 * statement whose sibling CTEs delete a fact and insert another at its key, a put's displacement netted against a
 * pending addition, is accepted with its CTEs written in either order, the carrier then holding the new fact alone;
 * the same insertion without the deletion is refused.
 *
 * Bound: every carrier of a relation's facts in both artifacts of a put with a read-back of both sides (the netted
 * pair, and the conservative snapshot and differences); one to three facts over two keys and two payloads, written in
 * one statement or one each; and the replacement with its CTEs in both orders, with and without the deletion.
 * Exhausted.
 */
const R = relation("R", { id: pg.int4, v: pg.int4 }, ["id"])
const Keyed = schema("carrier_key", { R }, [mutable(R)])

const owned = owning(Keyed)
const names = succeeded(
	compileInstallation(owned, {
		...installOptions(owned, "owner"),
		installation: identity.schema(parsedSchemaName("carrier_key"))
	})
).names
const artifacts = succeeded(testArtifacts(Keyed, testCompile))

/** A put of R with a read-back of both sides of its delta, so R's delta carriers are netted. */
const changes = ChangeSet.empty(Keyed)
	.put(R, [{ id: 0, v: 0 }])
	.read("r", (d) =>
		query(Keyed)
			.rule((r) => {
				const { id, v: value } = v(R, "added")
				return r.match(d.added(R), { id, v: value }).find({ side: "added", id, v: value })
			})
			.rule((r) => {
				const { id, v: value } = v(R, "removed")
				return r.match(d.removed(R), { id, v: value }).find({ side: "removed", id, v: value })
			})
	)
const program = succeeded(
	compileWrite(checking(Keyed), defined(changeSetDesc(changes), "a ChangeSet"), {
		names,
		reads: names,
		claims: { kind: "every" },
		world: { kind: "reality" },
		laws: artifacts.laws,
		derived: artifacts.derived
	}),
	"the put compiles"
)

/** A keyed carrier of an artifact, with the statement that creates it and its columns by field. */
interface KeyedCarrier {
	readonly carrier: Carrier
	readonly create: string
	readonly id: string
	readonly v: string
}

const keyedCarriers = (artifact: WriteArtifact): Arr.NonEmptyReadonlyArray<KeyedCarrier> =>
	nonEmpty(
		Arr.flatMap(artifact.carriers, (carrier) => {
			if (carrier.primaryKey === undefined) {
				return []
			}
			const create = defined(
				Option.getOrUndefined(
					Arr.findFirst(
						artifact.statements,
						(s) =>
							s.step.kind === "carrier" && s.step.step === "create" && s.step.carrier === carrier.name
					)
				),
				`the creation of ${carrier.name}`
			)
			const column = (field: string) =>
				defined(
					Option.getOrUndefined(Arr.findFirst(carrier.heading, (c) => c.name === field)),
					`the field ${field} of ${carrier.name}`
				).column
			return [{ carrier, create: create.spec.sql, id: column("id"), v: column("v") }]
		}),
		"the artifact keys its carriers of R's facts"
	)

const carriers = {
	optimized: keyedCarriers(program.artifacts.optimized),
	conservative: keyedCarriers(program.artifacts.conservative)
} as const

/** The facts a case writes: two at key 0, one at key 1. */
const FACTS = [
	{ id: 0, v: 0 },
	{ id: 0, v: 1 },
	{ id: 1, v: 0 }
] as const

type KeyCase =
	| {
			readonly kind: "write"
			readonly artifact: keyof typeof carriers
			readonly facts: ReadonlyArray<0 | 1 | 2>
			readonly together: boolean
	  }
	| {
			readonly kind: "replace"
			readonly artifact: keyof typeof carriers
			readonly deletionFirst: boolean
			readonly deletes: boolean
	  }

const artifactGen = element(["optimized", "conservative"] as const)

const caseGen: Gen<KeyCase> = oneOf<KeyCase>([
	(source) => ({
		kind: "write",
		artifact: source.draw(artifactGen),
		facts: source.draw(array(element([0, 1, 2] as const), { min: 1, max: 3 })),
		together: source.draw(boolean)
	}),
	(source) => ({
		kind: "replace",
		artifact: source.draw(artifactGen),
		deletionFirst: source.draw(boolean),
		deletes: source.draw(boolean)
	})
])

type KeyFeature =
	| "accepted"
	| "two facts at one key refused"
	| "an identical fact twice refused"
	| "refused at a later statement"
	| "replaced, the deletion written first"
	| "replaced, the insertion written first"
	| "an insertion at a held key refused"

const factText = (f: { readonly id: number; readonly v: number }): string => `(${f.id}, ${f.v})`

const insertSql = (k: KeyedCarrier, facts: ReadonlyArray<{ readonly id: number; readonly v: number }>) =>
	`INSERT INTO ${printTableName(k.carrier.name)} (${quoteIdent(k.id)}, ${quoteIdent(k.v)}) VALUES ${Arr.join(Arr.map(facts, factText), ", ")}`

/** The carrier's rows, as texts, in any order. */
const rowsOf = (session: RawSession, k: KeyedCarrier) =>
	Effect.map(
		session.values(
			`SELECT ${quoteIdent(k.id)}::pg_catalog.text, ${quoteIdent(k.v)}::pg_catalog.text FROM ${printTableName(k.carrier.name)}`,
			[]
		),
		(rows): ReadonlyArray<ReadonlyArray<string>> => Arr.map(rows, (row) => Arr.map(row, String))
	)

/** The rows a carrier holding `facts` reads back. */
const expectedRows = (
	facts: ReadonlyArray<{ readonly id: number; readonly v: number }>
): ReadonlyArray<ReadonlyArray<string>> => Arr.map(facts, (f) => [String(f.id), String(f.v)])

/** Requires `attempt` refused with 23505 on the carrier's own key, then rolls the aborted transaction back. */
const refusedByKey = <A, E, R>(
	session: RawSession,
	k: KeyedCarrier,
	attempt: Effect.Effect<A, E, R>
) =>
	Effect.gen(function* () {
		const fields = yield* expectSqlstate(attempt, "23505")
		assert.deepEqual(fields.table, Option.some(k.carrier.name), "refused on the carrier")
		yield* session.rollback
	})

/** The case's writes on one carrier, in one transaction, judged by the key's specification. */
const runOn = (session: RawSession, k: KeyedCarrier, box: KeyCase, notes: Set<KeyFeature>) =>
	Effect.gen(function* () {
		yield* session.begin
		yield* session.query(k.create, [])
		switch (box.kind) {
			case "write": {
				const facts = Arr.map(box.facts, (i) => FACTS[i])
				/** The first fact sharing its key with an earlier one: where the specification refuses. */
				const repeat = Arr.findFirstIndex(facts, (f, at) =>
					Arr.some(Arr.take(facts, at), (earlier) => earlier.id === f.id)
				)
				if (Option.isNone(repeat)) {
					if (box.together) {
						yield* session.query(insertSql(k, facts), [])
					} else {
						for (const f of facts) {
							yield* session.query(insertSql(k, [f]), [])
						}
					}
					const held = yield* rowsOf(session, k)
					unorderedEqual(held, expectedRows(facts), "the carrier holds the facts")
					yield* session.rollback
					notes.add("accepted")
					return
				}
				const second = defined(facts[repeat.value], "the repeated fact")
				notes.add(
					Arr.some(Arr.take(facts, repeat.value), (f) => f.v === second.v)
						? "an identical fact twice refused"
						: "two facts at one key refused"
				)
				if (box.together) {
					return yield* refusedByKey(session, k, session.query(insertSql(k, facts), []))
				}
				for (const f of Arr.take(facts, repeat.value)) {
					yield* session.query(insertSql(k, [f]), [])
				}
				notes.add("refused at a later statement")
				return yield* refusedByKey(session, k, session.query(insertSql(k, [second]), []))
			}
			case "replace": {
				const [stored, replacement] = [FACTS[0], FACTS[1]]
				yield* session.query(insertSql(k, [stored]), [])
				const table = printTableName(k.carrier.name)
				const deletion = `"deleted" AS (DELETE FROM ${table} WHERE ${quoteIdent(k.id)} = ${stored.id} AND ${quoteIdent(k.v)} = ${stored.v} RETURNING ${quoteIdent(k.id)})`
				const insertion = `"inserted" AS (${insertSql(k, [replacement])} RETURNING ${quoteIdent(k.id)})`
				const ctes = box.deletes
					? box.deletionFirst
						? [deletion, insertion]
						: [insertion, deletion]
					: [insertion]
				const statement = `WITH ${Arr.join(ctes, ", ")} SELECT 1`
				if (!box.deletes) {
					notes.add("an insertion at a held key refused")
					return yield* refusedByKey(session, k, session.query(statement, []))
				}
				yield* session.query(statement, [])
				const after = yield* rowsOf(session, k)
				unorderedEqual(after, expectedRows([replacement]), "the carrier holds the replacement alone")
				yield* session.rollback
				notes.add(
					box.deletionFirst
						? "replaced, the deletion written first"
						: "replaced, the insertion written first"
				)
			}
		}
	})

layer(Substrate.layer, { excludeTestServices: true })("a delta carrier's key", (it) => {
	it.effect(
		"holds a set of its relation's facts by the relation's key at each statement's end, in either CTE order",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const session = yield* s.session(ownerSession())
					return yield* exhaust(
						{
							suite: "pg/write/carrier-key",
							generator: caseGen,
							literal: Formatter.format,
							limit: 400,
							coverage: requiredInSpace<KeyFeature>([
								"accepted",
								"two facts at one key refused",
								"an identical fact twice refused",
								"refused at a later statement",
								"replaced, the deletion written first",
								"replaced, the insertion written first",
								"an insertion at a held key refused"
							]),
							caseHang,
							box: "every keyed carrier of both artifacts of a put with a read-back of both sides; one to three facts over two keys and two payloads, in one statement or one each; a replacement's two CTE orders, with and without the deletion",
							oracle: {
								kind: "postgresql",
								name: "a carrier accepts exactly the facts distinct by its relation's key, at each statement's end"
							}
						},
						(box, c) =>
							Effect.gen(function* () {
								const notes = new Set<KeyFeature>()
								for (const k of carriers[box.artifact]) {
									yield* runOn(session, k, box, notes)
								}
								for (const note of notes) {
									c.note(note)
								}
							})
					)
				}).pipe(Effect.scoped)
			)
	)
})
