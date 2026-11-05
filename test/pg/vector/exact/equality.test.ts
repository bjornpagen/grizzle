import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	Order,
	pipe,
	Result,
	String as Str
} from "effect"
import { Db } from "#adapter/public/db.ts"
import { arraysEncoder, positionalColumns } from "#compiler/codec/recordset.ts"
import { BudgetMeter } from "#compiler/core/budget.ts"
import { identity } from "#compiler/core/identity.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import { hasProperties, isList } from "#compiler/core/record.ts"
import type { StatementSpec } from "#compiler/ir/products.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"
import { ChangeSet as PublicChangeSet } from "#compiler/public/changeset.ts"
import { pg, uuid, Vector, type Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { isVector } from "#compiler/scalar/values/vector.ts"

import { jsonText } from "#compiler/core/trusted.ts"
import {
	changeSetOver as ChangeSet,
	type ChangeSetValue,
	changeSetDesc
} from "#compiler/write/changeset/value.ts"
import { realizeConservative } from "#compiler/write/conservative/realize.ts"
import { compileChangeSet } from "#compiler/write/frontend/compile.ts"
import { StatementShare, type WriteStatement } from "#compiler/write/insert/statement.ts"
import { textRows } from "#test/pg/codec/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, lacksText, bareRecord, succeeded } from "#test/support/assert.ts"
import {
	compileTemplate,
	paramTexts,
	realityWrite,
	testArtifacts,
	testCompile
} from "#test/support/compile.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { type Installed, installMigrated as install } from "#test/support/install-migrate.ts"
import { type NamedRelation, namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { checking } from "#test/support/policy.ts"
import { headingRecord } from "#test/support/statement-rows.ts"
import { type PgErrorFields, pgErrorFields } from "#test/support/substrate/errors.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { fullWorld, loginLayer } from "#test/support/worlds.ts"
import { codecOf } from "#test/unit/codec/support.ts"

const Pair = pg.vector(2)
const A = relation("A", { id: uuid, value: Pair }, ["id"])
const B = relation("B", { id: uuid, value: Pair }, ["id"])
const Edge = relation("Edge", { id: uuid, from: Pair, to: Pair }, ["id"])
const Note = relation("Note", { id: uuid, value: Pair, rank: pg.bigint }, ["id"])
const Pairs = schema("VectorPairs", { A, B, Edge, Note }, [])

const pairType = scalarOf({ kind: "vector", dimensions: 2 }, {})
const pairCodec = codecOf(pairType)
const vec = (x: number, y: number): Vector => Vector.make(Float32Array.of(x, y), 2)
const text = (value: Vector): string => {
	const t = pairCodec.encode(value)
	if (!t.ok) {
		throw new Error(`codec refused a fixture vector: ${t.error}`)
	}
	return t.value
}

/** A vector's binary32 components as JSON, for comparing what pgvector prints (shortest float32) with a host value. */
const components = (value: Vector): string => jsonText(Array.from(value, (x) => (x === 0 ? 0 : x)))

/** pgvector's output text read strictly by the kernel, and the library's conversion of it agreeing. */
const decodedComponents = (stored: string): string => {
	const d = pairCodec.read(stored)
	if (Result.isFailure(d)) {
		throw new Error(`the strict reader refused a stored vector: ${d.failure}`)
	}
	const converted = pairCodec.convert(stored)
	if (!isVector(d.success) || !isVector(converted)) {
		throw new Error("a vector codec reads a Vector")
	}
	assert.equal(components(converted), components(d.success))
	return components(d.success)
}

const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

const compiled = (q: unknown, installed: Installed): QueryTemplate => {
	const r = compileTemplate(q, undefined, {
		...testCompile,
		installation: identity.schema(parsedSchemaName(installed.declared))
	})
	if (!r.ok) {
		throw new Error(r.error.message)
	}
	return r.value
}

/** The decoded rows of one statement of a template, its placeholders filled by the statement's own encoders. */
const run = (session: RawSession, spec: StatementSpec, params: Readonly<Record<string, unknown>>) =>
	Effect.gen(function* () {
		const rows = yield* session.values(spec.sql, paramTexts(spec, params))
		return Arr.map(textRows(rows), headingRecord(spec.heading))
	})

/**
 * Every statement of both artifacts. The writer's search_path never holds the extension schema, so a statement that
 * compared two vectors through an unqualified operator would raise 42883 when it runs.
 */
const statements = (template: QueryTemplate): ReadonlyArray<StatementSpec> => {
	const all = [...template.optimized, ...template.conservative]
	assert.ok(all.length >= 2)
	return all
}

const sortedIds = (rows: ReadonlyArray<unknown>): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(rows, (r) => Formatter.format(r)),
		Order.String
	)

/**
 * The conservative write statements of a ChangeSet over Pairs as its full world writes them, over reality; every
 * placeholder is the member slot of the one member the ChangeSet enumerates over its relation, whose facts `facts`
 * holds by relation.
 */
const writeSteps = (installed: Installed, changeSet: unknown): ReadonlyArray<WriteStatement> => {
	const desc = changeSetDesc(changeSet)
	if (desc === undefined) {
		throw new Error("not a ChangeSet")
	}
	const reality = realityWrite(
		succeeded(
			testArtifacts(Pairs, {
				installation: installed.installation.settings.installation,
				vectorSchema: undefined
			})
		)
	)
	const frontend = compileChangeSet(checking(Pairs), desc, {
		claims: reality.claims,
		meter: new BudgetMeter(compileBudgets),
		laws: reality.laws,
		derived: reality.derived,
		world: reality.world
	})
	if (!frontend.ok) {
		throw new Error(frontend.error.message)
	}
	const realized = realizeConservative(frontend.value, {
		names: reality.names,
		reads: reality.reads,
		meter: new BudgetMeter(compileBudgets),
		share: new StatementShare()
	})
	if (!realized.ok) {
		throw new Error(realized.error.message)
	}
	return Arr.flatMap(realized.value.steps, (s) => (s.kind === "readBack" ? [] : [s.statement]))
}

/** One statement's result kind and the raw text rows it returned. */
interface StatementOut {
	readonly result: WriteStatement["result"]
	readonly rows: ReadonlyArray<unknown>
}

/**
 * What a ChangeSet's statements did: committed, with each statement's rows; or refused by the statement that raised,
 * with the rows of the statements before it.
 */
type Applied =
	| { readonly kind: "committed"; readonly out: ReadonlyArray<StatementOut> }
	| {
			readonly kind: "refused"
			readonly out: ReadonlyArray<StatementOut>
			readonly refused: PgErrorFields
	  }

/**
 * Runs every statement of a ChangeSet's conservative realization in one transaction as `session`, the
 * members' facts encoded as each statement's own arrays; the raw text rows of each statement.
 */
const apply = (
	session: RawSession,
	installed: Installed,
	changeSet: unknown,
	facts: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>
) =>
	Effect.gen(function* () {
		const out: Array<StatementOut> = []
		yield* session.begin
		for (const statement of writeSteps(installed, changeSet)) {
			const params = Arr.map(statement.params, (p) => {
				if (p.kind !== "member") {
					throw new Error(`an unexpected ${p.kind} parameter`)
				}
				const encoder = arraysEncoder({
					relation: p.relation,
					slot: { kind: "slot", name: String(p.slot) },
					columns: positionalColumns(p.columns)
				})
				const encoded = encoder(facts[p.relation] ?? [])
				if (!encoded.ok) {
					throw new Error(`encode: ${encoded.error._tag}`)
				}
				return defined(
					encoded.value.arrays[p.part.kind === "column" ? p.part.index : 0],
					`the array of placeholder ${p.number}`
				)
			})
			const rows = yield* Effect.result(session.values(statement.sql.text, params))
			if (Result.isFailure(rows)) {
				/** A statement that refuses raises (packages/engine/src/write/refusal.ts); the transaction is aborted. */
				const refused = pgErrorFields(rows.failure)
				if (refused === undefined) {
					return yield* rows.failure
				}
				yield* session.rollback
				return { kind: "refused", out, refused } satisfies Applied
			}
			out.push({ result: statement.result, rows: rows.success })
		}
		yield* session.commit
		return { kind: "committed", out } satisfies Applied
	})

/** The vector text a column stores, read back by the owner. */
const stored = (installed: Installed, table: string, columns: string) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const rows = yield* admin.queryValues(
			`SELECT ${columns} FROM "${installed.schema}"."${table}" ORDER BY 1`,
			[]
		)
		return Arr.map(rows, (r) =>
			Arr.map(r, (cell) =>
				pipe(String(cell), Str.startsWith("[")) ? decodedComponents(String(cell)) : String(cell)
			)
		)
	})

const changeSet = (): ChangeSetValue => ChangeSet.empty(Pairs)

/** The full world a direct SQL writer takes on. */
const pairsWorld = fullWorld(Pairs)

const idOf = (c: unknown): string =>
	hasProperties(c) && typeof c["id"] === "string"
		? c["id"]
		: assert.fail("a delivered child has an id")

/** The ids of a delivered fact's attachment `name`, sorted. */
const childIds = (f: unknown, name: string): ReadonlyArray<string> => {
	const children = hasProperties(f) ? f[name] : undefined
	if (!isList(children)) {
		return assert.fail(`a delivered fact with the attachment ${name}`)
	}
	return Arr.sort(Arr.map(children, idOf), Order.String)
}

/** The id of a delivered fact's optional attachment `first`. */
const firstId = (f: unknown): Option.Option<string> => {
	const first = hasProperties(f) ? f["first"] : undefined
	if (!Option.isOption(first)) {
		return assert.fail("a delivered fact with the attachment first")
	}
	return Option.map(first, idOf)
}

const lit = (x: Vector) => `'${text(x)}'::"vector_ext"."vector"(2)`

/** Every row of a statement that did not raise is a fact it changed. */
const markers = (o: Applied) => {
	assert.equal(o.kind, "committed", "a statement raised")
	return Arr.flatMap(o.out, (x) =>
		Arr.map(x.rows, (r) => (isList(r) ? Arr.map(r, String) : assert.fail("a row of columns")))
	)
}

layer(Substrate.layer)("vector equality as a world role", (it) => {
	it.effect(
		"a vector binding, a shared vector variable and an r.not on a vector run in both artifacts",
		() =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const installed = yield* install(Pairs, {
					ambient: ordinarySession,
					label: "vpairs",
					logins: [pairsWorld.server],
					extensions: []
				})
				const writer = yield* s.session({
					...worldSession(installed.world(pairsWorld.app)),
					label: "writer"
				})
				const [searchPath] = yield* writer.values(
					"SELECT pg_catalog.current_setting('search_path')",
					[]
				)
				lacksText(String(searchPath?.[0]), "vector_ext")
				const t = (name: string) => `"${installed.schema}"."${name}"`
				const as = [vec(1, 0), vec(0, 1), vec(0.6, 0.8), vec(1, 0), vec(-0.5, 0.5)]
				const bs = [vec(0, 1), vec(0.6, 0.8), vec(3, 4), vec(1, 0)]
				yield* s.admin.query(
					`INSERT INTO ${t("a")} ("id", "value") VALUES ${Arr.join(
						Arr.map(as, (x, i) => `('${id(i + 1)}'::uuid, ${lit(x)})`),
						", "
					)}`,
					[]
				)
				yield* s.admin.query(
					`INSERT INTO ${t("b")} ("id", "value") VALUES ${Arr.join(
						Arr.map(bs, (x, i) => `('${id(i + 101)}'::uuid, ${lit(x)})`),
						", "
					)}`,
					[]
				)
				yield* s.admin.query(
					`INSERT INTO ${t("edge")} ("id", "from", "to") VALUES ('${id(201)}'::uuid, '[-0,1]'::"vector_ext"."vector"(2), '[0,1]'::"vector_ext"."vector"(2)), ('${id(202)}'::uuid, ${lit(vec(1, 0))}, ${lit(vec(0, 1))})`,
					[]
				)

				/** A parameter binding of a vector column (the finding's reproduction). */
				const byValue = compiled(
					query(Pairs).rule((r) => {
						const { id: key } = v(A, "a")
						return r
							.match(A, { id: key, value: r.param("probe", A.fields.value) })
							.find({ id: key })
					}),
					installed
				)
				for (const spec of statements(byValue)) {
					const matched = yield* run(writer, spec, { probe: vec(1, 0) })
					assert.deepEqual(sortedIds(matched), sortedIds([{ id: id(1) }, { id: id(4) }]))
					const unmatched = yield* run(writer, spec, { probe: vec(2, 0) })
					assert.deepEqual(unmatched, [])
				}

				/** A vector variable shared by two relations: a join on native equality. */
				const join = compiled(
					query(Pairs).rule((r) => {
						const { id: a, value } = v(A, "a")
						const { id: b } = v(B, "b")
						return r.match(A, { id: a, value }).match(B, { id: b, value }).find({ a, b })
					}),
					installed
				)
				const expectedJoin = sortedIds([
					{ a: id(1), b: id(104) },
					{ a: id(4), b: id(104) },
					{ a: id(2), b: id(101) },
					{ a: id(3), b: id(102) }
				])
				for (const spec of statements(join)) {
					const joined = yield* run(writer, spec, {})
					assert.deepEqual(sortedIds(joined), expectedJoin)
				}

				/** One variable bound to two columns of one relation: the loops, -0 = +0 included. */
				const loops = compiled(
					query(Pairs).rule((r) => {
						const { id: key, from } = v(Edge, "edge")
						return r.match(Edge, { id: key, from, to: from }).find({ id: key })
					}),
					installed
				)
				for (const spec of statements(loops)) {
					const found = yield* run(writer, spec, {})
					assert.deepEqual(found, [bareRecord({ id: id(201) })])
				}

				/** An anti-join correlated on a vector: the A facts whose value no B fact has. */
				const unmatched = compiled(
					query(Pairs).rule((r) => {
						const { id: key, value } = v(A, "a")
						return r.match(A, { id: key, value }).where(r.not(B, { value })).find({ id: key })
					}),
					installed
				)
				for (const spec of statements(unmatched)) {
					const found = yield* run(writer, spec, {})
					assert.deepEqual(found, [bareRecord({ id: id(5) })])
				}

				/**
				 * An attachment correlated on a parent's vector, its child a correlated take, read through the real reader:
				 * as a read, and as the read-back of a ChangeSet that writes nothing, which runs inside the write
				 * transaction and so reads the conservative artifact. The queries are built over the installed schema.
				 */
				const value = schema(installed.declared, Pairs.relations, Pairs.statements)
				const world = fullWorld(value)
				const twins = query(value)
					.rule((r) => {
						const { id: key, value: pair } = v(A, "a")
						return r.match(A, { id: key, value: pair }).find({ id: key, value: pair })
					})
					.attach(
						"twins",
						(a) =>
							query(value).rule((r) => {
								const { id: key } = v(B, "b")
								return r.match(B, { id: key, value: a.value }).find({ id: key })
							}),
						"array"
					)
					.attach(
						"first",
						(a) =>
							query(value)
								.rule((r) => {
									const { id: key } = v(B, "b")
									return r.match(B, { id: key, value: a.value }).find({ id: key })
								})
								.orderBy(["id", "asc"])
								.take(1),
						"option"
					)
				const deliveries = yield* Effect.gen(function* () {
					const db = yield* Db.open(world.server.roles.app, {})
					const read: ReadonlyArray<unknown> = yield* (yield* db.execute(twins, {})).collect
					const outcome = yield* db.apply(
						PublicChangeSet.empty(value).read("readBack", () => twins),
						{}
					)
					if (outcome.kind !== "accepted" && outcome.kind !== "no-change") {
						return assert.fail(`the read-back's apply was ${outcome.kind}`)
					}
					const readBack = hasProperties(outcome.reads) ? outcome.reads.readBack : undefined
					if (!isList(readBack)) {
						return assert.fail("an outcome without its read-back")
					}
					return [read, readBack]
				}).pipe(Effect.scoped, withLayer(loginLayer(installed, world.server)))
				for (const delivered of deliveries) {
					const byId = new Map(Arr.map(delivered, (f) => [idOf(f), f]))
					assert.deepEqual(childIds(byId.get(id(1)), "twins"), [id(104)])
					assert.deepEqual(childIds(byId.get(id(4)), "twins"), [id(104)])
					assert.deepEqual(childIds(byId.get(id(2)), "twins"), [id(101)])
					assert.deepEqual(childIds(byId.get(id(5)), "twins"), [])
					assert.deepEqual(firstId(byId.get(id(3))), Option.some(id(102)))
					assert.deepEqual(firstId(byId.get(id(5))), Option.none())
				}
			})
	)

	it.effect(
		"ChangeSet inserts, repeats, conflicts, deletes and puts over vector fields run through the protocol",
		(ctx) =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const installed = yield* install(Pairs, {
					ambient: ordinarySession,
					label: "vwrite",
					logins: [pairsWorld.server],
					extensions: []
				})
				const writer = yield* s.session({
					...worldSession(installed.world(pairsWorld.app)),
					label: "writer"
				})
				const names = namesOf(installed)
				/** The facts the inserts inserted: every row of an insert, none raised. */
				const insertedKeys = (o: Applied) => {
					assert.ok(Arr.every(o.out, (x) => x.result.kind === "insert"))
					return Arr.map(markers(o), (r) => defined(r[0], "an inserted marker's key"))
				}
				/**
				 * A conflict witness raises the key law of the relation's primary key: 23000, the law's identity as the
				 * constraint name (write/refusal.ts).
				 */
				const conflictOf = (o: Applied, relation: NamedRelation) => {
					if (o.kind !== "refused") {
						return assert.fail("the conflicting write raised nothing")
					}
					assert.equal(o.refused.code, "23000")
					assert.equal(o.refused.constraint, names.primaryKeyLaw(relation))
				}

				/** A single vector payload: the DO SELECT predicate and the inserted marker are scalar comparisons. */
				const a1 = { id: id(1), value: vec(0.6, 0.8) }
				const a2 = { id: id(2), value: vec(0, 1) }
				const inserted = yield* apply(writer, installed, changeSet().insert(A, [a1, a2]), {
					A: [a1, a2]
				})
				assert.deepEqual(
					Arr.map(inserted.out, (o) => o.result.kind),
					["insert"]
				)
				assert.deepEqual(Arr.sort(insertedKeys(inserted), Order.String), [id(1), id(2)])
				/** An exact repeat returns nothing; a conflicting repeat raises the key law. */
				const repeat = yield* apply(writer, installed, changeSet().insert(A, [a1]), { A: [a1] })
				assert.deepEqual(markers(repeat), [])
				const clash = { id: id(1), value: vec(0.8, 0.6) }
				const conflict = yield* apply(writer, installed, changeSet().insert(A, [clash]), {
					A: [clash]
				})
				conflictOf(conflict, A)
				const storedA = yield* stored(installed, "a", `"id"::text, "value"::text`)
				assert.deepEqual(storedA, [
					[id(1), components(a1.value)],
					[id(2), components(a2.value)]
				])

				/** A vector and a bigint payload: both comparisons are row comparisons, spelled column by column. */
				const n1 = { id: id(11), value: vec(1, 0), rank: 1n }
				const noted = yield* apply(writer, installed, changeSet().insert(Note, [n1]), {
					Note: [n1]
				})
				assert.deepEqual(insertedKeys(noted), [id(11)])
				const appliedNote = yield* apply(writer, installed, changeSet().insert(Note, [n1]), {
					Note: [n1]
				})
				assert.deepEqual(markers(appliedNote), [])
				/** A repeat of the noted fact's key differing in its rank, or in its vector, conflicts. */
				const clashings: Arr.NonEmptyReadonlyArray<
					readonly [differs: "rank" | "vector", fact: typeof n1]
				> = [
					["rank", { ...n1, rank: 2n }],
					["vector", { ...n1, value: vec(0, 1) }]
				]
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "pg/vector/equality/clash",
							generator: element(clashings),
							literal: ([differs]: readonly [string, typeof n1]) => `differs in its ${differs}`,
							limit: clashings.length,
							coverage: requiredInSpace<`clash in its ${"rank" | "vector"}`>([
								"clash in its rank",
								"clash in its vector"
							]),
							caseHang: Duration.minutes(2)
						},
						([differs, clashing], k) =>
							Effect.gen(function* () {
								const out = yield* apply(writer, installed, changeSet().insert(Note, [clashing]), {
									Note: [clashing]
								})
								conflictOf(out, Note)
								k.note(`clash in its ${differs}`)
							})
					)
				)

				/** An exact delete compares every column; a fact differing only in its vector deletes nothing. */
				const miss = { id: id(2), value: vec(1, 0) }
				const kept = yield* apply(writer, installed, changeSet().delete(A, [miss]), { A: [miss] })
				assert.deepEqual(markers(kept), [])
				const removed = yield* apply(writer, installed, changeSet().delete(A, [a2]), { A: [a2] })
				assert.equal(markers(removed).length, 1)

				/** A put displaces the occupant whose vector differs, and an identical put displaces nothing. */
				const moved = { id: id(11), value: vec(0, 1), rank: 1n }
				const put = yield* apply(writer, installed, changeSet().put(Note, [moved]), {
					Note: [moved]
				})
				assert.deepEqual(
					Arr.map(put.out, (o) => o.result.kind),
					["delete", "insert"]
				)
				assert.equal(put.out[0]?.rows.length, 1)
				const again = yield* apply(writer, installed, changeSet().put(Note, [moved]), {
					Note: [moved]
				})
				assert.deepEqual(again.out[0]?.rows, [])
				const storedNotes = yield* stored(
					installed,
					"note",
					`"id"::text, "value"::text, "rank"::text`
				)
				assert.deepEqual(storedNotes, [[id(11), components(moved.value), "1"]])
				const storedIds = yield* stored(installed, "a", `"id"::text`)
				assert.deepEqual(storedIds, [[id(1)]])
			})
	)
})
