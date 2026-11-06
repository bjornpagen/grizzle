import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, constant, element, type Gen, map, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, pipe, Result, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import { arraysEncoder, positionalColumns } from "#compiler/codec/recordset.ts"
import { identity } from "#compiler/core/identity.ts"
import { hasProperties, isList } from "#compiler/core/record.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
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
import type { PutStatement } from "#compiler/write/put/statement.ts"
import { textRows } from "#test/pg/codec/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, lacksText, nonEmpty, succeeded } from "#test/support/assert.ts"
import {
	compileTemplate,
	installedCodes,
	paramTexts,
	realityWrite,
	scalarsOnly,
	testArtifacts,
	testCompile
} from "#test/support/compile.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { type Installed, installMigrated as install } from "#test/support/install-migrate.ts"
import { type NamedRelation, namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
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
const pairCodec = codecOf(pairType, emptyCodebook)
const vec = (x: number, y: number): Vector => Vector.make(Float32Array.of(x, y), 2)

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
		const rows = yield* session.values(spec.sql, paramTexts(spec, params, scalarsOnly))
		return Arr.map(textRows(rows), headingRecord(spec.heading, emptyCodebook))
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

/**
 * The conservative write statements of a ChangeSet over Pairs as its full world writes them, over reality; every
 * placeholder is the member slot of the one member the ChangeSet enumerates over its relation, whose facts `facts`
 * holds by relation.
 */
const writeSteps = (
	installed: Installed,
	changeSet: unknown
): ReadonlyArray<WriteStatement | PutStatement> => {
	const desc = changeSetDesc(changeSet)
	if (desc === undefined) {
		throw new Error("not a ChangeSet")
	}
	const reality = realityWrite(
		succeeded(
			testArtifacts(Pairs, {
				installation: installed.installation.settings.installation,
				vectorSchema: undefined,
				codes: installedCodes(installed.names.codes)
			})
		)
	)
	const frontend = compileChangeSet(checking(Pairs), desc, {
		claims: reality.claims,
		laws: reality.laws,
		derived: reality.derived,
		world: reality.world,
		codes: installed.names.codes
	})
	if (!frontend.ok) {
		throw new Error(frontend.error.message)
	}
	const realized = realizeConservative(frontend.value, {
		names: reality.names,
		reads: reality.reads,
		share: new StatementShare()
	})
	if (!realized.ok) {
		throw new Error(realized.error.message)
	}
	return Arr.flatMap(realized.value.steps, (s) => (s.kind === "readBack" ? [] : [s.statement]))
}

/** One statement's result kind and the raw text rows it returned. */
interface StatementOut {
	readonly result: (WriteStatement | PutStatement)["result"]
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
					codes: installed.names.codes,
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

/** A vector of two components, as a case draws it: -0 apart from 0. */
type Pair = readonly [number, number]

/** A vector's components: both zeros, so a value meets its twin spelling, and a few values, never both zero. */
const freshPair: Gen<Pair> = (source) => {
	const x = source.draw(element([-0, 0, 1, 0.6, -0.5]))
	const y = source.draw(element(x === 0 ? [1, 0.8, 0.5] : [-0, 0, 1, 0.8, 0.5]))
	return [x, y] as const
}

/** A zero with its sign flipped; any other component as it is. */
const flipped = (x: number): number => (x !== 0 ? x : Object.is(x, -0) ? 0 : -0)

/** The vector's other spelling: each zero with its sign flipped. A vector with no zero is its own. */
const twinOf = (p: Pair): Pair => [flipped(p[0]), flipped(p[1])] as const

/** Whether two vectors are one value: equal binary32 components, -0 equal to 0. */
const same = (p: Pair, q: Pair): boolean => p[0] === q[0] && p[1] === q[1]

/** A vector's text in its drawn spelling, -0 with its sign, as a typed literal of the column's type. */
const spelledLit = (p: Pair): string =>
	`'[${Arr.join(
		Arr.map(p, (x) => (Object.is(x, -0) ? "-0" : String(x))),
		","
	)}]'::"vector_ext"."vector"(2)`

/** Whether two vectors are one value spelled apart. */
const twinned = (p: Pair, q: Pair): boolean => same(p, q) && spelledLit(p) !== spelledLit(q)

/** A case: A's and B's values, Edge's (from, to) pairs and the probe a binding reads. */
interface PairsCase {
	readonly a: Arr.NonEmptyReadonlyArray<Pair>
	readonly b: ReadonlyArray<Pair>
	readonly edges: Arr.NonEmptyReadonlyArray<readonly [Pair, Pair]>
	readonly probe: Pair
}

/**
 * A case whose B values, edges and probe are as often an A value or its twin as a fresh vector, so equal values meet
 * in every spelling.
 */
const pairsCaseGen: Gen<PairsCase> = (source) => {
	const a = nonEmpty(source.draw(array(freshPair, { min: 1, max: 5 })), "A's values")
	const near: Gen<Pair> = weighted([
		[2, freshPair],
		[1, element(a)],
		[1, map(element(a), twinOf)]
	])
	const edge: Gen<readonly [Pair, Pair]> = (inner) => {
		const from = inner.draw(near)
		const to = inner.draw(
			weighted([
				[2, freshPair],
				[1, constant(from)],
				[1, constant(twinOf(from))]
			])
		)
		return [from, to] as const
	}
	return {
		a,
		b: source.draw(array(near, { min: 0, max: 4 })),
		edges: nonEmpty(source.draw(array(edge, { min: 1, max: 3 })), "Edge's pairs"),
		probe: source.draw(near)
	}
}

/** The ids of A's, B's and Edge's i-th facts. */
const aId = (i: number): Uuid => id(i + 1)
const bId = (i: number): Uuid => id(i + 101)
const edgeId = (i: number): Uuid => id(i + 201)

/** What each query delivers, by the host's vector equality: ids sorted, a join's pairs as `a|b`. */
interface Expected {
	readonly byValue: ReadonlyArray<string>
	readonly join: ReadonlyArray<string>
	readonly loops: ReadonlyArray<string>
	readonly unmatched: ReadonlyArray<string>
	/** Each A fact's twins in B, by id. */
	readonly twins: ReadonlyArray<ReadonlyArray<string>>
}

const expectedOf = (c: PairsCase): Expected => {
	const sorted = (ids: ReadonlyArray<string>) => Arr.sort(ids, Order.String)
	const twins = Arr.map(c.a, (x) =>
		sorted(Arr.flatMap(c.b, (y, j) => (same(x, y) ? [bId(j)] : [])))
	)
	return {
		byValue: sorted(Arr.flatMap(c.a, (x, i) => (same(x, c.probe) ? [aId(i)] : []))),
		join: sorted(
			Arr.flatMap(c.a, (x, i) =>
				Arr.flatMap(c.b, (y, j) => (same(x, y) ? [`${aId(i)}|${bId(j)}`] : []))
			)
		),
		loops: sorted(Arr.flatMap(c.edges, ([from, to], i) => (same(from, to) ? [edgeId(i)] : []))),
		unmatched: sorted(Arr.flatMap(twins, (ids, i) => (ids.length === 0 ? [aId(i)] : []))),
		twins
	}
}

/** A delivered row's text field `name`. */
const textField = (row: unknown, name: string): string => {
	const value = hasProperties(row) ? row[name] : undefined
	return typeof value === "string" ? value : assert.fail(`a row with the text field ${name}`)
}

/** The ids of delivered rows, sorted. */
const idsOf = (rows: ReadonlyArray<unknown>): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(rows, (r) => textField(r, "id")),
		Order.String
	)

/** The (a, b) pairs of a join's rows as `a|b`, sorted. */
const pairsOf = (rows: ReadonlyArray<unknown>): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(rows, (r) => `${textField(r, "a")}|${textField(r, "b")}`),
		Order.String
	)

/** What a case met of vector equality. */
type EqualityFeature =
	| "a probe matching a fact"
	| "a probe matching none"
	| "a twin spelling joined"
	| "a loop over twin spellings"
	| "an A fact no B holds"
	| "an attachment of two twins"

const equalityFeatures: Arr.NonEmptyReadonlyArray<EqualityFeature> = [
	"a probe matching a fact",
	"a probe matching none",
	"a twin spelling joined",
	"a loop over twin spellings",
	"an A fact no B holds",
	"an attachment of two twins"
]

const featuresOf = (c: PairsCase, e: Expected): ReadonlyArray<EqualityFeature> => [
	e.byValue.length > 0 ? "a probe matching a fact" : "a probe matching none",
	...(Arr.some(c.a, (x) => Arr.some(c.b, (y) => twinned(x, y)))
		? ["a twin spelling joined" as const]
		: []),
	...(Arr.some(c.edges, ([from, to]) => twinned(from, to))
		? ["a loop over twin spellings" as const]
		: []),
	...(e.unmatched.length > 0 ? ["an A fact no B holds" as const] : []),
	...(Arr.some(e.twins, (ids) => ids.length > 1) ? ["an attachment of two twins" as const] : [])
]

/** Every row of a statement that did not raise is a fact it changed. */
const markers = (o: Applied) => {
	assert.equal(o.kind, "committed", "a statement raised")
	return Arr.flatMap(o.out, (x) =>
		Arr.map(x.rows, (r) => (isList(r) ? Arr.map(r, String) : assert.fail("a row of columns")))
	)
}

layer(Substrate.layer)("vector equality as a world role", (it) => {
	it.effect(
		"a vector binding, a shared vector variable, an r.not and attachments correlated on a vector agree with vector equality in both artifacts",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const installed = yield* install(Pairs, {
						ambient: ordinarySession,
						label: "vpairs",
						logins: [pairsWorld.server],
						extensions: []
					})
					const names = namesOf(installed)
					const writer = yield* s.session({
						...worldSession(installed.world(pairsWorld.app)),
						label: "writer"
					})
					const [searchPath] = yield* writer.values(
						"SELECT pg_catalog.current_setting('search_path')",
						[]
					)
					lacksText(String(searchPath?.[0]), "vector_ext")
					/** A parameter binding of a vector column. */
					const byValue = compiled(
						query(Pairs).rule((r) => {
							const { id: key } = v(A, "a")
							return r
								.match(A, { id: key, value: r.param("probe", A.fields.value) })
								.find({ id: key })
						}),
						installed
					)
					/** A vector variable shared by two relations: a join on native equality. */
					const join = compiled(
						query(Pairs).rule((r) => {
							const { id: a, value } = v(A, "a")
							const { id: b } = v(B, "b")
							return r.match(A, { id: a, value }).match(B, { id: b, value }).find({ a, b })
						}),
						installed
					)
					/** One variable bound to two columns of one relation: the loops. */
					const loops = compiled(
						query(Pairs).rule((r) => {
							const { id: key, from } = v(Edge, "edge")
							return r.match(Edge, { id: key, from, to: from }).find({ id: key })
						}),
						installed
					)
					/** An anti-join correlated on a vector: the A facts whose value no B fact has. */
					const unmatched = compiled(
						query(Pairs).rule((r) => {
							const { id: key, value } = v(A, "a")
							return r.match(A, { id: key, value }).where(r.not(B, { value })).find({ id: key })
						}),
						installed
					)
					/**
					 * An attachment correlated on a parent's vector, its child a correlated take, read through the real
					 * reader: as a read, and as the read-back of a ChangeSet that writes nothing, which runs inside the
					 * write transaction and so reads the conservative artifact. The queries are built over the installed
					 * schema.
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
					/** Writes the case's facts in place of the last case's, each vector in its drawn spelling. */
					const load = (c: PairsCase) =>
						Effect.gen(function* () {
							const values = (rows: ReadonlyArray<string>) => Arr.join(rows, ", ")
							yield* s.admin.query(`DELETE FROM ${names.table(Edge)}`, [])
							yield* s.admin.query(`DELETE FROM ${names.table(B)}`, [])
							yield* s.admin.query(`DELETE FROM ${names.table(A)}`, [])
							yield* s.admin.query(
								`INSERT INTO ${names.table(A)} (${names.column(A, "id")}, ${names.column(A, "value")}) VALUES ${values(
									Arr.map(c.a, (x, i) => `('${aId(i)}'::uuid, ${spelledLit(x)})`)
								)}`,
								[]
							)
							if (Arr.isReadonlyArrayNonEmpty(c.b)) {
								yield* s.admin.query(
									`INSERT INTO ${names.table(B)} (${names.column(B, "id")}, ${names.column(B, "value")}) VALUES ${values(
										Arr.map(c.b, (x, i) => `('${bId(i)}'::uuid, ${spelledLit(x)})`)
									)}`,
									[]
								)
							}
							yield* s.admin.query(
								`INSERT INTO ${names.table(Edge)} (${names.column(Edge, "id")}, ${names.column(Edge, "from")}, ${names.column(Edge, "to")}) VALUES ${values(
									Arr.map(
										c.edges,
										([from, to], i) =>
											`('${edgeId(i)}'::uuid, ${spelledLit(from)}, ${spelledLit(to)})`
									)
								)}`,
								[]
							)
						})
					return yield* Effect.gen(function* () {
						const db = yield* Db.open(world.server.roles.app, {})
						return yield* explore(
							{
								suite: "pg/vector/equality",
								draw: drawn(pairsCaseGen),
								literal: Formatter.format,
								oracle: {
									kind: "second-implementation",
									name: "the host's evaluation of each query under vector equality, binary32 components with -0 equal to 0"
								},
								coverage: required<EqualityFeature>(equalityFeatures, {
									cases: 60,
									sense: notesOnly
								}),
								kept: [],
								runs: 30,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 8,
								caseHang
							},
							(c, k) =>
								Effect.gen(function* () {
									yield* load(c)
									const probe = vec(c.probe[0], c.probe[1])
									const expected = expectedOf(c)
									for (const spec of statements(byValue)) {
										const matched = yield* run(writer, spec, { probe })
										assert.deepEqual(idsOf(matched), expected.byValue, "the probe's facts")
									}
									for (const spec of statements(join)) {
										const joined = yield* run(writer, spec, {})
										assert.deepEqual(pairsOf(joined), expected.join, "the join")
									}
									for (const spec of statements(loops)) {
										const found = yield* run(writer, spec, {})
										assert.deepEqual(idsOf(found), expected.loops, "the loops")
									}
									for (const spec of statements(unmatched)) {
										const found = yield* run(writer, spec, {})
										assert.deepEqual(idsOf(found), expected.unmatched, "the unmatched")
									}
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
									for (const delivered of [read, readBack]) {
										const byId = new Map(Arr.map(delivered, (f) => [idOf(f), f]))
										for (const [i, twinsOf] of expected.twins.entries()) {
											const fact = byId.get(aId(i))
											assert.deepEqual(childIds(fact, "twins"), twinsOf, `${aId(i)}'s twins`)
											assert.deepEqual(firstId(fact), Arr.head(twinsOf), `${aId(i)}'s first twin`)
										}
									}
									k.noteAll(featuresOf(c, expected))
								})
						)
					}).pipe(Effect.scoped, withLayer(loginLayer(installed, world.server)))
				})
			)
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
							caseHang
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
