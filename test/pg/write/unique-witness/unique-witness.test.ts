import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, type Gen, int, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { boundedShrink } from "@grizzle/testing/shrink"
import { type Swarm, swarm, swarmChoice } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { drawn as drawnField, natural, pg } from "#compiler/public/fields.ts"
import { fin, key, mutable, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, deepEquals, defined, unorderedEqual } from "#test/support/assert.ts"
import { answered, writeOnce } from "#test/support/calls.ts"
import { installMigrated, type Installed } from "#test/support/install-migrate.ts"
import { lawNamesOf, namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { oneFlight } from "#test/support/one-flight.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { type StateRow, tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A multi-row insert that meets a unique object of a family's member is refused by that object's law and witnessed by
 * the key of a stated row that meets it, on PostgreSQL 19rc1 (README "Errors and outcomes", Witness: a key "that a row
 * you stated breaks, by two rows you submitted or by a stored row inside or outside your role's view, is grizzle's own
 * finding, witnessed by that row's values at the key's fields"; `unreported` only "for a foreign key, and where no row
 * you stated breaks the rule").
 *
 * A case is a drawn schema, Doc owning Line in order (`lines`, the family key (doc, at)) beside Line's primary key and
 * none to three declared keys of Line, Doc and Line each mutable or not, so a family insert is ON CONFLICT at Line's
 * primary key (an immutable owner, at SERIALIZABLE) or a plain INSERT (a mutable one); a stored instance inserted by one
 * call, valid by construction (each line's `a` its id, its `b` its index); and a second call of one to three docs, each
 * a stored doc stated again with some of its lines replaced, or a fresh doc of fresh lines, each line's id, `a` and `b`
 * drawn from a swarm over fresh values, a stored line's, and one stated earlier in the call.
 *
 * The oracle is the README's set rule as a pure model (`verdictOf`): the stored rows and the stated rows as written, a
 * line at its doc and its index, form one set; a stated row that agrees with another row of it at a unique object and
 * differs elsewhere breaks that object's law, and a stated doc whose lines differ from the stored doc's or another
 * statement's breaks Doc's key ("the insert states the owner's members"). A call with no break is `unchanged` where
 * every stated row is stored and `accepted` otherwise, and stores the set. A call with one is `refused`, deciding its
 * laws (`every`), each one a stated row breaks, storing what it stored, and its witness is a stated row's values at the
 * fields of an object of a law it names that the row breaks there, never `unreported`.
 *
 * Features: each object a stated row meets (the family key, Line's key, a declared key), by a stored row or another
 * stated one, under an immutable and a mutable Doc; a declared key met where the statement writes several lines of
 * different values there, which the host's single-value judgement left unreported; an accepted and an unchanged call.
 *
 * Plants (~/.cache/grizzle-release/WITNESS/plants): family-insert-unprobed.patch, a family INSERT with no probe gate,
 * so PostgreSQL's 23505 reaches the host's single-value rule; family-probe-family-key-only.patch, a gate probing only a
 * family's own key. Each must turn the property red.
 */

/** A line as a call states it under its doc: its id and its payload; its doc and its index are its place. */
interface StatedLine {
	readonly id: number
	readonly a: number
	readonly b: number
}

/** A doc as a call states it: its id and its lines in order. */
interface StatedDoc {
	readonly id: number
	readonly lines: ReadonlyArray<StatedLine>
}

/** A declared key of Line beside its primary key and its family's. */
const keyNames = ["a", "a, b", "doc, b"] as const

type KeyName = (typeof keyNames)[number]

/** The fields of each declared key. */
const keyFields: { readonly [K in KeyName]: Arr.NonEmptyReadonlyArray<"doc" | "a" | "b"> } = {
	a: ["a"],
	"a, b": ["a", "b"],
	"doc, b": ["doc", "b"]
}

/** A case's schema: Line's declared keys, and whether Doc and Line are mutable. */
interface Shape {
	readonly keys: ReadonlyArray<KeyName>
	readonly mutableDoc: boolean
	readonly mutableLine: boolean
}

/** A case: its schema, the instance its first call stores, and the docs its second call states. */
interface UniqueCase {
	readonly shape: Shape
	readonly stored: ReadonlyArray<StatedDoc>
	readonly again: Arr.NonEmptyReadonlyArray<StatedDoc>
}

const Doc = relation("Doc", { id: pg.integer, n: drawnField(natural) }, ["id"])
const Line = relation(
	"Line",
	{ id: pg.integer, doc: pg.integer, at: drawnField(natural), a: pg.integer, b: pg.integer },
	["id"]
)

/** The declared key `k` of Line, over its fields (`keyFields`). */
const keyStatement = (k: KeyName) => {
	switch (k) {
		case "a":
			return key(on(Line, "a"))
		case "a, b":
			return key(on(Line, "a", "b"))
		case "doc, b":
			return key(on(Line, "doc", "b"))
	}
}

/** A case's statements: the family, each declared key by its name, and every statement of its schema, built once per
 * case, so the schema under any name holds them and its laws are read back from them. */
const statementsOf = (shape: Shape) => {
	const lines = ordered(on(Line, "doc", "at"), fin(Doc, "n"))
	const keys = Arr.map(shape.keys, (k) => [k, keyStatement(k)] as const)
	return {
		lines,
		keys,
		all: [
			lines,
			...Arr.map(keys, ([, statement]) => statement),
			...(shape.mutableDoc ? [mutable(Doc)] : []),
			...(shape.mutableLine ? [mutable(Line)] : [])
		]
	}
}

/** A law a model names: Doc's key, Line's key, the family `lines`, or a declared key of Line. */
type LawName = "Doc key" | "Line key" | "lines" | `key ${KeyName}`

/** A value of a row as stored: an integer field's number, a drawn natural's bigint. */
type Cell = number | bigint

/** A row as written, by field. */
type Row = Readonly<Record<string, Cell>>

/** Line's rows as a call writes them: each line at its doc and its index there. */
const lineRows = (docs: ReadonlyArray<StatedDoc>): ReadonlyArray<Row> =>
	Arr.flatMap(docs, (d) =>
		Arr.map(d.lines, (l, at) => ({ id: l.id, doc: d.id, at: BigInt(at), a: l.a, b: l.b }))
	)

/** Doc's rows as a call writes them: each doc with its count of lines. */
const docRows = (docs: ReadonlyArray<StatedDoc>): ReadonlyArray<Row> =>
	Arr.map(docs, (d) => ({ id: d.id, n: BigInt(d.lines.length) }))

/** The rows of `rows`, each once. */
const distinct = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> =>
	Arr.dedupeWith(rows, (x, y) => deepEquals(x, y))

/** A row's values at `fields`. */
const at = (row: Row, fields: ReadonlyArray<string>): Row =>
	Rec.fromEntries(Arr.map(fields, (f) => [f, defined(row[f], `the field ${f} of a row`)] as const))

/** Whether two rows agree at `fields`. */
const agree = (x: Row, y: Row, fields: ReadonlyArray<string>): boolean =>
	Arr.every(fields, (f) => x[f] === y[f])

/** A unique object of the model: the law it states, its relation, and the fields a conflict there names. */
interface ObjectAt {
	readonly law: LawName
	readonly relation: "Doc" | "Line"
	readonly fields: Arr.NonEmptyReadonlyArray<string>
}

/** Every unique object of a case's schema. */
const objectsOf = (shape: Shape): ReadonlyArray<ObjectAt> => [
	{ law: "Doc key", relation: "Doc", fields: ["id"] },
	{ law: "Line key", relation: "Line", fields: ["id"] },
	{ law: "lines", relation: "Line", fields: ["doc", "at"] },
	...Arr.map(shape.keys, (k): ObjectAt => ({
		law: `key ${k}`,
		relation: "Line",
		fields: keyFields[k]
	}))
]

/** A stated row breaking a law: the law, the row's relation, its values at the object's fields, and what it meets. */
interface Break {
	readonly law: LawName
	readonly relation: "Doc" | "Line"
	readonly values: Row
	readonly meets: "stored" | "stated"
}

/** What the set rule makes of a second call: the rows it leaves, and whether it adds one; or the breaks refusing it. */
type Verdict =
	| {
			readonly kind: "written"
			readonly docs: ReadonlyArray<Row>
			readonly lines: ReadonlyArray<Row>
			readonly adds: boolean
	  }
	| { readonly kind: "refused"; readonly breaks: Arr.NonEmptyReadonlyArray<Break> }

/** The set rule over a stored instance and a second call (see the header). */
const verdictOf = (
	shape: Shape,
	stored: ReadonlyArray<StatedDoc>,
	again: ReadonlyArray<StatedDoc>
): Verdict => {
	const storedRows = { Doc: distinct(docRows(stored)), Line: distinct(lineRows(stored)) }
	const statedRows = { Doc: distinct(docRows(again)), Line: distinct(lineRows(again)) }
	const all = {
		Doc: distinct([...storedRows.Doc, ...statedRows.Doc]),
		Line: distinct([...storedRows.Line, ...statedRows.Line])
	}
	const isStored = (relation: "Doc" | "Line", row: Row): boolean =>
		Arr.some(storedRows[relation], (s) => deepEquals(s, row))
	const breaks: Array<Break> = []
	for (const o of objectsOf(shape)) {
		for (const n of statedRows[o.relation]) {
			for (const r of all[o.relation]) {
				if (!deepEquals(r, n) && agree(r, n, o.fields)) {
					breaks.push({
						law: o.law,
						relation: o.relation,
						values: at(n, o.fields),
						meets: isStored(o.relation, r) ? "stored" : "stated"
					})
				}
			}
		}
	}
	/** Each doc's lines as a statement of it writes them, which a stored doc's or another statement's must equal. */
	const linesOf = (d: StatedDoc): ReadonlyArray<Row> => lineRows([d])
	for (const d of again) {
		const others = [
			...Arr.filter(stored, (s) => s.id === d.id),
			...Arr.filter(again, (s) => s.id === d.id && s !== d)
		]
		for (const o of others) {
			if (!deepEquals(linesOf(o), linesOf(d))) {
				breaks.push({
					law: "Doc key",
					relation: "Doc",
					values: { id: d.id },
					meets: Arr.some(stored, (s) => s === o) ? "stored" : "stated"
				})
			}
		}
	}
	return Arr.isReadonlyArrayNonEmpty(breaks)
		? { kind: "refused", breaks }
		: {
				kind: "written",
				docs: all.Doc,
				lines: all.Line,
				adds:
					Arr.some(statedRows.Doc, (row) => !isStored("Doc", row)) ||
					Arr.some(statedRows.Line, (row) => !isStored("Line", row))
			}
}

/** A case's stored instance, valid by construction under every declared key: each line's `a` its id, its `b` its index. */
const storedGen: Gen<ReadonlyArray<StatedDoc>> = (source) => {
	const docs: Array<StatedDoc> = []
	let next = 1
	for (let d = 1, count = source.draw(int(0, 3)); d <= count; d += 1) {
		const lines: Array<StatedLine> = []
		for (let i = 0, n = source.draw(int(0, 3)); i < n; i += 1) {
			lines.push({ id: next, a: next, b: i })
			next += 1
		}
		docs.push({ id: d, lines })
	}
	return docs
}

/** What a second call's drawing switches per case: its docs' kinds, its replaced lines, and where each line's id and
 * `a` come from, a fresh value, a stored line's or one the call stated before. */
const callFeatures = [
	"fresh doc",
	"doc again",
	"kept line",
	"replaced line",
	"id fresh",
	"id stored",
	"id stated",
	"a fresh",
	"a stored",
	"a stated"
] as const

type CallFeature = (typeof callFeatures)[number]

/** One of `pool`'s values, or `otherwise` where it holds none. */
const pooled =
	(pool: ReadonlyArray<number>, otherwise: () => number): Gen<number> =>
	(source) =>
		Arr.isReadonlyArrayNonEmpty(pool)
			? defined(pool[source.draw(int(0, pool.length - 1))], "a pooled value")
			: otherwise()

/** A second call over `stored`: one to three docs, each a stored doc again or a fresh one (see the header). */
const againGen =
	(stored: ReadonlyArray<StatedDoc>): Gen<Arr.NonEmptyReadonlyArray<StatedDoc>> =>
	(source) => {
		const on: Swarm<CallFeature> = source.draw(swarm(callFeatures))
		const storedLines = Arr.flatMap(stored, (d) => d.lines)
		let next = Arr.reduce(storedLines, stored.length, (most, l) => Math.max(most, l.id, l.a))
		const fresh = (): number => {
			next += 1
			return next
		}
		const stated: Array<StatedLine> = []
		const lineGen: Gen<StatedLine> = (s) => {
			const idFrom = s.draw(swarmChoice(on, ["id fresh", "id stored", "id stated"] as const))
			const aFrom = s.draw(swarmChoice(on, ["a fresh", "a stored", "a stated"] as const))
			const id =
				idFrom === "id fresh"
					? fresh()
					: s.draw(
							pooled(
								Arr.map(idFrom === "id stored" ? storedLines : stated, (l) => l.id),
								fresh
							)
						)
			const a =
				aFrom === "a fresh"
					? fresh()
					: s.draw(
							pooled(
								Arr.map(aFrom === "a stored" ? storedLines : stated, (l) => l.a),
								fresh
							)
						)
			const line = { id, a, b: s.draw(int(0, 2)) }
			stated.push(line)
			return line
		}
		const docGen: Gen<StatedDoc> = (s) => {
			const kind = s.draw(swarmChoice(on, ["fresh doc", "doc again"] as const))
			if (kind === "doc again" && Arr.isReadonlyArrayNonEmpty(stored)) {
				const d = defined(stored[s.draw(int(0, stored.length - 1))], "a stored doc")
				return {
					id: d.id,
					lines: Arr.map(d.lines, (l) =>
						s.draw(swarmChoice(on, ["kept line", "replaced line"] as const)) === "kept line"
							? l
							: s.draw(lineGen)
					)
				}
			}
			const id = fresh()
			const lines: Array<StatedLine> = []
			for (let n = s.draw(int(1, 3)); n > 0; n -= 1) {
				lines.push(s.draw(lineGen))
			}
			return { id, lines }
		}
		const first = source.draw(docGen)
		const rest: Array<StatedDoc> = []
		for (let n = source.draw(int(0, 2)); n > 0; n -= 1) {
			rest.push(source.draw(docGen))
		}
		return [first, ...rest]
	}

const shapeGen: Gen<Shape> = (source) => ({
	keys: source.draw(subarray(keyNames)),
	mutableDoc: source.draw(boolean),
	mutableLine: source.draw(boolean)
})

const caseGen: Gen<UniqueCase> = (source) => {
	const shape = source.draw(shapeGen)
	const stored = source.draw(storedGen)
	return { shape, stored, again: source.draw(againGen(stored)) }
}

/** An owner's mutability as a situation names it: an immutable doc's lines are inserted ON CONFLICT at their key at
 * SERIALIZABLE, a mutable doc's by a plain INSERT (write/family/additions.ts memberArbitrated). */
type Owner = "an immutable doc" | "a mutable doc"

/** An object a refusal's witness meets, as a situation names it. */
type Met = "the family key" | "a declared key" | "the line key" | "the doc key"

type Situation =
	| `${Met} met by a stored row, under ${Owner}`
	| `${Met} met by another stated row, under ${Owner}`
	| "a declared key met where the statement writes several lines of different values there"
	| "accepted"
	| "unchanged"

const metOf = (law: LawName): Met =>
	law === "lines"
		? "the family key"
		: law === "Line key"
			? "the line key"
			: law === "Doc key"
				? "the doc key"
				: "a declared key"

/** What a case aims at while a situation is pending: the object a stated row meets and by what, under which owner; an
 * accepted or an unchanged call. */
type Aim =
	| {
			readonly kind: "meets"
			readonly met: Exclude<Met, "the doc key">
			readonly by: "stored" | "stated"
			readonly owner: Owner
	  }
	| { readonly kind: "written"; readonly adds: boolean }

const owners: ReadonlyArray<Owner> = ["an immutable doc", "a mutable doc"]

/** The required situations, each with the aim that reaches it. */
const aims: Arr.NonEmptyReadonlyArray<readonly [Situation, Aim]> = [
	["accepted", { kind: "written", adds: true }],
	["unchanged", { kind: "written", adds: false }],
	...Arr.flatMap(owners, (owner) => [
		[
			`the family key met by a stored row, under ${owner}`,
			{ kind: "meets", met: "the family key", by: "stored", owner }
		] as const,
		[
			`the line key met by a stored row, under ${owner}`,
			{ kind: "meets", met: "the line key", by: "stored", owner }
		] as const,
		[
			`a declared key met by a stored row, under ${owner}`,
			{ kind: "meets", met: "a declared key", by: "stored", owner }
		] as const,
		[
			`a declared key met by another stated row, under ${owner}`,
			{ kind: "meets", met: "a declared key", by: "stated", owner }
		] as const
	]),
	[
		"a declared key met where the statement writes several lines of different values there",
		{ kind: "meets", met: "a declared key", by: "stored", owner: "a mutable doc" }
	]
]

const situations: Arr.NonEmptyReadonlyArray<Situation> = Arr.map(aims, ([s]) => s)

/** A stored instance of one to three docs, the first holding one to three lines, valid as storedGen's. */
const someStoredGen: Gen<Arr.NonEmptyReadonlyArray<StatedDoc>> = (source) => {
	const drawnStored = source.draw(storedGen)
	const firstLines = Array.from({ length: source.draw(int(1, 3)) }, (_, i) => i)
	const offset = Arr.reduce(
		Arr.flatMap(drawnStored, (d) => d.lines),
		0,
		(most, l) => Math.max(most, l.id)
	)
	const first: StatedDoc = {
		id: drawnStored.length + 1,
		lines: Arr.map(firstLines, (i) => ({ id: offset + i + 1, a: offset + i + 1, b: i }))
	}
	return [first, ...drawnStored]
}

/**
 * A case aimed at `aim`: its owner's mutability forced, the key "a" among its declared keys where it meets one and none
 * where it meets the family key, a stored instance with lines, and a second call of one doc built to meet the aimed
 * object alone, every value a stored one it meets or fresh past every stored one.
 */
const aimedGen =
	(aim: Aim): Gen<UniqueCase> =>
	(source) => {
		const drawnShape = source.draw(shapeGen)
		const stored = source.draw(someStoredGen)
		const storedLines = Arr.flatMap(stored, (d) => d.lines)
		const target = defined(
			storedLines[source.draw(int(0, storedLines.length - 1))],
			"a stored line"
		)
		const past = Arr.reduce(storedLines, stored.length, (most, l) => Math.max(most, l.id, l.a)) + 1
		const shape: Shape =
			aim.kind === "meets"
				? {
						...drawnShape,
						mutableDoc: aim.owner === "a mutable doc",
						keys:
							aim.met === "a declared key"
								? Arr.union(["a"], drawnShape.keys)
								: aim.met === "the family key"
									? []
									: drawnShape.keys
					}
				: drawnShape
		const freshDoc = (lines: ReadonlyArray<StatedLine>): StatedDoc => ({ id: past, lines })
		const line = (id: number, a: number): StatedLine => ({ id, a, b: past + id })
		const again = ((): StatedDoc => {
			if (aim.kind === "written") {
				return aim.adds ? freshDoc([line(past + 1, past + 1)]) : defined(stored[0], "a stored doc")
			}
			switch (aim.met) {
				case "the family key": {
					const d = defined(stored[0], "a stored doc")
					const replaced = source.draw(int(0, d.lines.length - 1))
					return {
						id: d.id,
						lines: Arr.map(d.lines, (l, i) => (i === replaced ? line(past + 1, past + 1) : l))
					}
				}
				case "the line key":
					return freshDoc([line(past + 1, past + 1), line(target.id, past + 2)])
				case "a declared key":
					return aim.by === "stored"
						? freshDoc([line(past + 1, past + 1), line(past + 2, target.a)])
						: freshDoc([line(past + 1, past + 3), line(past + 2, past + 3)])
			}
		})()
		return { shape, stored, again: [again] }
	}

/** The case a witness runs: its drawn one, or, while a situation is pending, one aimed at a pending situation. */
const aimedCase = (drawnCase: UniqueCase, c: Case<Situation>): UniqueCase => {
	const pending = Option.getOrUndefined(c.steering)
	const open = Arr.filter(aims, ([situation]) => pending?.has(situation) === true)
	return Arr.isReadonlyArrayNonEmpty(open)
		? c.draw(aimedGen(defined(open[c.draw(int(0, open.length - 1))], "a pending aim")[1]))
		: drawnCase
}

/** A call's facts: each doc with its lines nested at its count, each line its id and payload. */
const factsOf = (docs: ReadonlyArray<StatedDoc>) => ({
	insert: {
		Doc: Arr.map(docs, (d) => ({
			id: d.id,
			n: Arr.map(d.lines, (l) => ({ id: l.id, a: l.a, b: l.b }))
		}))
	}
})

/** Each relation of an installed case stores exactly `docs` and `lines`. */
const storesExactly = (
	done: Installed,
	docs: ReadonlyArray<Row>,
	lines: ReadonlyArray<Row>,
	after: string
) =>
	Effect.gen(function* () {
		const asState = (rows: ReadonlyArray<Row>): ReadonlyArray<StateRow> =>
			Arr.map(rows, (r): StateRow => ({ ...r }))
		const storedDocs = yield* tableState(done, Doc)
		const storedLines = yield* tableState(done, Line)
		unorderedEqual(storedDocs, asState(docs), `Doc's rows after ${after}`)
		unorderedEqual(storedLines, asState(lines), `Line's rows after ${after}`)
	})

layer(Substrate.layer, { excludeTestServices: true })("a family insert meeting a unique", (it) => {
	it.effect(
		"is refused by a law a stated row breaks, witnessed by that row's values at the law's fields, and writes the set otherwise",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/write/unique-witness",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<Situation>(situations, { cases: 64, sense: notesOnly }),
						kept: [],
						runs: 16,
						shrink: boundedShrink(40),
						concurrency: 1,
						steerEvery: 8,
						caseHang,
						oracle: {
							kind: "specification",
							name: "the README's set rule over relations as sets of rows with their unique objects (verdictOf)"
						}
					},
					(drawnCase, c) =>
						Effect.gen(function* () {
							const { shape, stored, again } = aimedCase(drawnCase, c)
							const statements = statementsOf(shape)
							const schemaNamed = (name: string) => schema(name, [Doc, Line], statements.all)
							const declared = schemaNamed("Uniq")
							const done = yield* installMigrated(declared, {
								ambient: ordinarySession,
								label: "unique",
								logins: [fullWorld(declared, {}).server],
								extensions: []
							})
							const value = schemaNamed(done.schema)
							const world = fullWorld(value, {})
							const names = namesOf(done)
							const lawNames = lawNamesOf(value)
							const lawIds: ReadonlyArray<readonly [LawName, LawId]> = [
								["Doc key", lawNames.primaryKeyLaw({ name: "Doc" })],
								["Line key", lawNames.primaryKeyLaw({ name: "Line" })],
								["lines", lawNames.lawOf(statements.lines)],
								...Arr.map(statements.keys, ([k, statement]): readonly [LawName, LawId] => [
									`key ${k}`,
									lawNames.lawOf(statement)
								])
							]
							const lawId = (law: LawName): LawId =>
								defined(
									Option.getOrUndefined(Arr.findFirst(lawIds, ([name]) => name === law))?.[1],
									`the law ${law}`
								)
							const owner: Owner = shape.mutableDoc ? "a mutable doc" : "an immutable doc"
							const insert = ChangeSet.empty(value).insert(Doc, [])
							yield* Effect.gen(function* () {
								const db = yield* openServedDb(done, world.server.roles.app, {})
								const flight = yield* oneFlight(db.ctx, done.as(world.server))
								const loaded = yield* db.load({ insert })
								const applied = (docs: ReadonlyArray<StatedDoc>) =>
									answered(
										writeOnce(memberCalls(flight.context, member(loaded, "insert")))({
											params: {},
											facts: factsOf(docs)
										})
									)
								const first = yield* flight.judged("the first insert", applied(stored))
								assert.equal(
									first.kind,
									Arr.isReadonlyArrayNonEmpty(stored) ? "accepted" : "unchanged",
									`the first insert of ${Formatter.format(stored)}`
								)
								yield* storesExactly(done, docRows(stored), lineRows(stored), "the first insert")
								const label = `${Formatter.format(again)} over ${Formatter.format(stored)} under ${Formatter.format(shape)}`
								const outcome = yield* flight.judged("the second insert", applied(again))
								const verdict = verdictOf(shape, stored, again)
								if (verdict.kind === "written") {
									assert.equal(
										outcome.kind,
										verdict.adds ? "accepted" : "unchanged",
										`${label}: no stated row breaks a unique`
									)
									yield* storesExactly(done, verdict.docs, verdict.lines, label)
									c.note(verdict.adds ? "accepted" : "unchanged")
									return
								}
								if (outcome.kind !== "refused") {
									return assert.fail(
										`${label}: stated rows break ${Formatter.format(verdict.breaks)}, so the insert is refused, not ${outcome.kind}`
									)
								}
								yield* storesExactly(
									done,
									docRows(stored),
									lineRows(stored),
									`the refused ${label}`
								)
								assert.equal(
									outcome.refused.kind,
									"every",
									`${label}: a key's refusal decides its laws`
								)
								const named = Arr.map(outcome.refused.laws, (l) => names.reported(l))
								const broken = Arr.map(verdict.breaks, (b) => ({ ...b, id: lawId(b.law) }))
								for (const law of named) {
									assert.ok(
										Arr.some(broken, (b) => b.id === law),
										`${label}: the refusal names ${law}, which no stated row breaks: ${Formatter.format(verdict.breaks)}`
									)
								}
								const witness = outcome.witness
								if (witness.kind === "unreported") {
									return assert.fail(
										`${label}: the refusal of ${Formatter.format(named)} reports no witness, where stated rows break it: ${Formatter.format(verdict.breaks)}`
									)
								}
								const met = Option.getOrUndefined(
									Arr.findFirst(
										broken,
										(b) =>
											named.includes(b.id) &&
											b.relation === witness.relation &&
											deepEquals<unknown>(witness.values, b.values)
									)
								)
								if (met === undefined) {
									return assert.fail(
										`${label}: the witness ${Formatter.format(witness)} is no stated row's values at a law the refusal names, ${Formatter.format(named)}, that the row breaks: ${Formatter.format(verdict.breaks)}`
									)
								}
								c.note(
									met.meets === "stored"
										? `${metOf(met.law)} met by a stored row, under ${owner}`
										: `${metOf(met.law)} met by another stated row, under ${owner}`
								)
								const statedLines = distinct(lineRows(again))
								const fields = Option.getOrUndefined(
									Arr.findFirst(objectsOf(shape), (o) => o.law === met.law)
								)?.fields
								if (
									metOf(met.law) === "a declared key" &&
									fields !== undefined &&
									Arr.dedupeWith(
										Arr.map(statedLines, (l) => at(l, fields)),
										(x, y) => deepEquals(x, y)
									).length > 1
								) {
									c.note(
										"a declared key met where the statement writes several lines of different values there"
									)
								}
							}).pipe(Effect.scoped)
						}).pipe(Effect.scoped)
				)
			)
	)
})
