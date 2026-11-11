/**
 * Vector equality on PostgreSQL 19 and the pinned pgvector: a vector's value is its binary32 components, -0 equal to 0,
 * everywhere grizzle compares one.
 *
 * - Queries: a vector binding, a vector variable two matches share, an r.not and attachments correlated on a vector,
 *   over drawn facts of vectors that collide by value and differ by spelling, deliver in both artifacts exactly what
 *   the host's evaluation of the query under vector equality delivers; every statement names the extension's operator
 *   by its schema, since the writer's search_path never holds it.
 * - Writes: ChangeSet inserts, repeats, conflicts, deletes and puts over vector fields run through the protocol, and
 *   each outcome and the stored facts are a host model's of each relation under vector equality.
 *
 * Oracle: a second implementation, the host's evaluation of each query and a host model of each relation's facts, both
 * under vector equality.
 *
 * Plants: vector-negative-zero-apart (a vector's identity text writes -0, so the host keeps apart what pgvector
 * equates).
 *
 * Features: each query form and each write outcome the searches name.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	subset,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	pipe,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { positionalColumns } from "#compiler/codec/recordset.ts"
import { identity } from "#compiler/core/identity.ts"
import { hasProperties, isList } from "#compiler/core/record.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { StatementSpec } from "#compiler/ir/products.ts"
import { ChangeSet as PublicChangeSet } from "#compiler/public/changeset.ts"
import { pg, uuid, Vector, type Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { isVector } from "#compiler/scalar/values/vector.ts"
import { arraysEncoder } from "#test/support/arrays.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"

import { Db } from "#adapter/public/db.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import {
	changeSetOver as ChangeSet,
	type ChangeSetValue,
	changeSetDesc
} from "#compiler/write/changeset/value.ts"
import { compileChangeSet } from "#compiler/write/frontend/compile.ts"
import { StatementShare, type WriteStatement } from "#compiler/write/insert/statement.ts"
import type { PutStatement } from "#compiler/write/put/statement.ts"
import { textRows } from "#test/pg/codec/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, lacksText, nonEmpty, succeeded } from "#test/support/assert.ts"
import { answered, rowsOf } from "#test/support/calls.ts"
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
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { realizeConservative } from "#test/support/oracle/write/realize.ts"
import { checking } from "#test/support/policy.ts"
import { servedFixture } from "#test/support/served-db.ts"
import { headingRecord } from "#test/support/statement-rows.ts"
import { type PgErrorFields, pgErrorFields } from "#test/support/substrate/errors.ts"
import { clearRows, installationGroup } from "#test/support/substrate/replace.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { fullWorld } from "#test/support/worlds.ts"
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

const compiled = (q: unknown, installed: Installed): OracleTemplate => {
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
const statements = (template: OracleTemplate): ReadonlyArray<StatementSpec> => {
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
				installation: installed.installation.names.installation,
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
		share: new StatementShare(),
		level: "serializable"
	})
	if (!realized.ok) {
		throw new Error(realized.error.message)
	}
	return Arr.flatMap(realized.value.steps, (s) => {
		if (s.kind === "family") {
			throw new Error(
				"a vector schema owns no family, so its realization holds no family statement"
			)
		}
		return s.kind === "readBack" ? [] : [s.statement]
	})
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
const pairsWorld = Object.freeze(fullWorld(Pairs, {}))

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

/** The relations the write programs write: one with a single vector payload, one with a vector and a bigint. */
const writeRelations = { A, Note } as const

type WrittenRelation = keyof typeof writeRelations

const writtenRelations = nonEmpty(Rec.keys(writeRelations), "the written relations")

/** Each written relation's table and the columns its stored rows are read by. */
const tableOf: { readonly [R in WrittenRelation]: string } = { A: "a", Note: "note" }
const columnsOf: { readonly [R in WrittenRelation]: string } = {
	A: `"id"::text, "value"::text`,
	Note: `"id"::text, "value"::text, "rank"::text`
}

/** A written fact: its key, its vector as drawn, and its rank where its relation has one. */
interface WriteFact {
	readonly id: Uuid
	readonly value: Pair
	readonly rank: Option.Option<bigint>
}

/** A ChangeSet member: an operation over drawn facts of one relation, their keys distinct. */
interface WriteStep {
	readonly relation: WrittenRelation
	readonly op: WriteOp
	readonly facts: Arr.NonEmptyReadonlyArray<WriteFact>
}

/** The ChangeSet operations, each as its builder adds a member. */
const writeOps = {
	insert: (c: ChangeSetValue, relation: unknown, facts: ReadonlyArray<unknown>) =>
		c.insert(relation, facts),
	delete: (c: ChangeSetValue, relation: unknown, facts: ReadonlyArray<unknown>) =>
		c.delete(relation, facts),
	put: (c: ChangeSetValue, relation: unknown, facts: ReadonlyArray<unknown>) =>
		c.put(relation, facts)
} as const

type WriteOp = keyof typeof writeOps

const writeOpNames = nonEmpty(Rec.keys(writeOps), "the ChangeSet operations")

/**
 * A program of steps: each a relation, an operation, and facts over a pool of three keys, a key written before as often
 * repeated, its fact as it was or in its twin spelling, as drawn afresh; a fresh vector is a few values or their twins,
 * a rank one of two values.
 */
const writeProgramGen: Gen<ReadonlyArray<WriteStep>> = (source) => {
	const steps: Array<WriteStep> = []
	const count = source.draw(int(1, 5))
	for (let n = 0; n < count; n++) {
		const relation = source.draw(element(writtenRelations))
		const earlier = Arr.flatMap(steps, (step) => (step.relation === relation ? step.facts : []))
		const keys = source.draw(subset(Arr.range(1, 3), { min: 1, max: 3 }))
		const facts = Arr.map(keys, (key): WriteFact => {
			const fresh: WriteFact = {
				id: id(relation === "A" ? key : key + 10),
				value: source.draw(oneOf([freshPair, map(freshPair, twinOf)])),
				rank: relation === "Note" ? Option.some(BigInt(source.draw(int(1, 2)))) : Option.none()
			}
			const before = Arr.findLast(earlier, (f) => f.id === fresh.id)
			return Option.isSome(before) && source.draw(boolean)
				? source.draw(
						oneOf([
							constant(before.value),
							constant({ ...before.value, value: twinOf(before.value.value) })
						])
					)
				: fresh
		})
		steps.push({
			relation,
			op: source.draw(element(writeOpNames)),
			facts: nonEmpty(facts, "a step's facts")
		})
	}
	return steps
}

/** Two facts are one: the same key, one vector under vector equality, the same rank. */
const sameFact = (a: WriteFact, b: WriteFact): boolean =>
	a.id === b.id &&
	same(a.value, b.value) &&
	Option.getOrUndefined(a.rank) === Option.getOrUndefined(b.rank)

/** A drawn fact as its relation's host fact. */
const hostFact = (f: WriteFact): Readonly<Record<string, unknown>> =>
	Option.match(f.rank, {
		onNone: () => ({ id: f.id, value: vec(f.value[0], f.value[1]) }),
		onSome: (rank) => ({ id: f.id, value: vec(f.value[0], f.value[1]), rank })
	})

/** The row a fact is stored as, read back. */
const rowOf = (f: WriteFact): Array<string> => [
	f.id,
	components(vec(f.value[0], f.value[1])),
	...Option.match(f.rank, { onNone: () => [], onSome: (rank) => [String(rank)] })
]

/** What a write program met. */
type WriteFeature =
	| "a fact inserted"
	| "an exact repeat"
	| "a twin spelling repeated"
	| "a conflicting repeat refused"
	| "a delete of the stored fact"
	| "a delete of a differing fact"
	| "a put displacing its occupant"
	| "a put of the stored fact"

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
					 * write transaction and so reads the conservative artifact, each a member of the full world's served
					 * workload. The queries are built over the installed schema.
					 */
					const value = schema(installed.declared, Pairs.relations, Pairs.statements)
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
							yield* clearRows(s.admin, installationGroup(names))
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
					const world = fullWorld(value, {
						twins,
						readBack: PublicChangeSet.empty(value).read("readBack", () => twins)
					})
					const served = yield* servedFixture(installed, world.server)
					return yield* Effect.gen(function* () {
						const db = yield* Db.open(served.login.roles.app, {})
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
									const read: ReadonlyArray<unknown> = yield* rowsOf(
										db.workload.twins.once({ params: {}, facts: {} })
									)
									const outcome = yield* answered(
										db.workload.readBack.once({ params: {}, facts: {} })
									)
									if (outcome.kind !== "accepted" && outcome.kind !== "unchanged") {
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
					}).pipe(Effect.scoped, withLayer(served.layer))
				})
			)
	)

	it.effect(
		"ChangeSet inserts, repeats, conflicts, deletes and puts over vector fields run through the protocol",
		(ctx) =>
			searched(
				ctx,
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
					return yield* explore(
						{
							suite: "pg/vector/equality/writes",
							draw: drawn(writeProgramGen),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "a host model of each relation's facts under vector equality, binary32 components with -0 equal to 0"
							},
							coverage: required<WriteFeature>(
								[
									"a fact inserted",
									"an exact repeat",
									"a twin spelling repeated",
									"a conflicting repeat refused",
									"a delete of the stored fact",
									"a delete of a differing fact",
									"a put displacing its occupant",
									"a put of the stored fact"
								],
								{ cases: 60, sense: notesOnly }
							),
							kept: [],
							runs: 24,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 8,
							caseHang
						},
						(steps, k) =>
							Effect.gen(function* () {
								yield* clearRows(s.admin, installationGroup(names))
								const model = new Map<WrittenRelation, Map<string, WriteFact>>(
									Arr.map(writtenRelations, (relation) => [relation, new Map()])
								)
								for (const step of steps) {
									const R = writeRelations[step.relation]
									const facts = Arr.map(step.facts, hostFact)
									const held = defined(model.get(step.relation), step.relation)
									const occupants = Arr.map(step.facts, (f) => ({ f, stored: held.get(f.id) }))
									const out = yield* apply(
										writer,
										installed,
										writeOps[step.op](changeSet(), R, facts),
										{ [step.relation]: facts }
									)
									switch (step.op) {
										case "insert": {
											const clashing = Arr.filter(
												occupants,
												({ f, stored }) => stored !== undefined && !sameFact(stored, f)
											)
											if (Arr.isReadonlyArrayNonEmpty(clashing)) {
												k.note("a conflicting repeat refused")
												if (out.kind !== "refused") {
													return assert.fail("the conflicting write raised nothing")
												}
												assert.equal(out.refused.code, "23000")
												assert.equal(out.refused.constraint, names.primaryKeyLaw(R))
												break
											}
											assert.ok(Arr.every(out.out, (x) => x.result.kind === "insert"))
											const fresh = Arr.filter(occupants, ({ stored }) => stored === undefined)
											assert.deepEqual(
												Arr.sort(
													Arr.map(markers(out), (r) => defined(r[0], "an inserted marker's key")),
													Order.String
												),
												Arr.sort(
													Arr.map(fresh, ({ f }) => f.id),
													Order.String
												)
											)
											for (const { f, stored } of occupants) {
												if (stored === undefined) {
													k.note("a fact inserted")
													held.set(f.id, f)
												} else {
													k.note(
														spelledLit(stored.value) === spelledLit(f.value)
															? "an exact repeat"
															: "a twin spelling repeated"
													)
												}
											}
											break
										}
										case "delete": {
											const removed = Arr.filter(
												occupants,
												({ f, stored }) => stored !== undefined && sameFact(stored, f)
											)
											assert.equal(markers(out).length, removed.length, "the facts deleted")
											for (const { f, stored } of occupants) {
												if (stored !== undefined && sameFact(stored, f)) {
													k.note("a delete of the stored fact")
													held.delete(f.id)
												} else if (stored !== undefined) {
													k.note("a delete of a differing fact")
												}
											}
											break
										}
										case "put": {
											const displaced = Arr.filter(
												occupants,
												({ f, stored }) => stored !== undefined && !sameFact(stored, f)
											)
											assert.equal(out.kind, "committed", "a put raised")
											const [first] = out.out
											assert.equal(first?.result.kind, "delete")
											assert.equal(first?.rows.length, displaced.length, "the occupants displaced")
											for (const { f, stored } of occupants) {
												if (stored !== undefined) {
													k.note(
														sameFact(stored, f)
															? "a put of the stored fact"
															: "a put displacing its occupant"
													)
												}
												held.set(f.id, f)
											}
											break
										}
									}
									for (const relation of writtenRelations) {
										const facts = Arr.sort(
											[...defined(model.get(relation), relation).values()],
											Order.mapInput(Order.String, (f: WriteFact) => f.id)
										)
										const rows = yield* stored(installed, tableOf[relation], columnsOf[relation])
										assert.deepEqual(rows, Arr.map(facts, rowOf), `${relation} after ${step.op}`)
									}
								}
							})
					)
				})
			)
	)
})
