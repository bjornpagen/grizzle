import { type Case, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { boolean, element, type Gen, int, subarray, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { boundedShrink } from "@bjornpagen/testing/shrink"
import { type Swarm, swarm, swarmChoice } from "@bjornpagen/testing/swarm"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, String as Str } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { accumulated, closedId, drawn as drawnField, natural, pg } from "#compiler/public/fields.ts"
import {
	closed,
	contained,
	fin,
	key,
	mutable,
	on,
	ordered,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import type { Predicate } from "#compiler/types/core/phantom.ts"
import type { RowScalars } from "#compiler/types/schema/statements.ts"
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
 * the key of a stated row that meets it, on PostgreSQL 19rc2 (README "Errors and outcomes", Witness: a key "that a row
 * you stated breaks, by two rows you submitted or by a stored row inside or outside your role's view, is grizzle's own
 * finding, witnessed by that row's values at the key's fields"; `unreported` only "for a foreign key, and where no row
 * you stated breaks the rule"). A key over a selected side holds apart only the rows its selection holds (README
 * "Rules", Rows a side leaves out: "a key over the side doesn't hold them apart").
 *
 * A case is a drawn schema, Doc owning Line in order (`lines`, the family key (doc, at)) beside Line's primary key,
 * none to three declared keys of Line, and none to three keys of Line over a selection, Doc and Line each mutable or
 * not, so a family insert is ON CONFLICT at Line's primary key (an immutable owner, at SERIALIZABLE) or a plain INSERT
 * (a mutable one). Each doc states a kind of the roster Kind, which each of its lines copies along the family's owner
 * axis (`kind`, accumulated, which grizzle draws and no call states), as pantry's attributes copy their element's kind,
 * version and governor. A selection is drawn over a line's copied kind, read through the closed relation Tagged (whose
 * rows a case draws: `Tagged.has(kind)`, or `Tagged.at("tag", kind)` against a handle, NULL where Tagged lacks the
 * kind) or compared to a handle, its drawn index `at`, and its stated `b`, under NOT, AND and OR, so a selection both
 * reads the fields a family draws and closed lookups, and is a disjunction, the shape of pantry's DocumentId key. A
 * stored instance is inserted by one call, valid by construction (each line's `a` its id, its `b` its index, each doc
 * the longest prefix of its drawn lines the keys over selections admit); a second call states one to three docs, each a
 * stored doc stated again with some of its lines replaced, or a fresh doc of fresh lines, each line's id, `a` and `b`
 * drawn from a swarm over fresh values, a stored line's, and one stated earlier in the call.
 *
 * The oracle is the README's set rule as a pure model (`verdictOf`): the stored rows and the stated rows as written, a
 * line at its doc, its index and its doc's kind, form one set; a stated row that agrees with another row of it at a
 * unique object, where both are rows the object holds, and differs elsewhere breaks that object's law, and a stated doc
 * whose lines differ from the stored doc's or another statement's breaks Doc's key ("the insert states the owner's
 * members"). A key over a selection holds the rows its selection is true of, in Kleene's logic over a closed read that
 * is NULL at an absent key (README "Closed relations": "a selection keeps only the rows its condition is true of"). A
 * call with no break is `unchanged` where every stated row is stored and `accepted` otherwise, and stores the set. A
 * call with one is `refused`, deciding its laws (`every`), each one a stated row breaks, storing what it stored, and its
 * witness is a stated row's values at the fields of an object of a law it names that the row breaks there, never
 * `unreported`.
 *
 * Features: each object a stated row meets (the family key, Line's key, a declared key, a key over a selection), by a
 * stored row or another stated one, under an immutable and a mutable Doc; a declared key met where the statement writes
 * several lines of different values there, which the host's single-value judgement left unreported; two members at a
 * selection key, only one of them selected, admitted, under each owner; a verdict at a selection key reading the
 * copied kind through a closed lookup, reading the drawn index, and under a disjunction; an accepted and an unchanged
 * call.
 *
 * Plants (~/.cache/grizzle-release/WITNESS/plants): family-insert-unprobed.patch, a family INSERT with no probe gate,
 * so PostgreSQL's 23505 reaches the host's single-value rule; family-probe-family-key-only.patch, a gate probing only a
 * family's own key. (~/.cache/grizzle-release/KEYPROBE/plants): probe-unfiltered.patch, a probe judging a key over a
 * selection over the whole relation (write/probe.ts withinRow reads no guard); driven-where-text.patch, a driven
 * read's key bindings and filter joined as text (sql/print.ts printDriven), so a stored row a disjunct of the selection
 * holds at another key meets the probe. Each must turn the property red.
 */

/** The roster of a doc's kind, which its lines copy. */
const kindNames = ["k0", "k1", "k2"] as const

type KindName = (typeof kindNames)[number]

/** The roster of Tagged's payload. */
const tagNames = ["t0", "t1"] as const

type TagName = (typeof tagNames)[number]

const Kind = closed("Kind", kindNames)
const Tag = closed("Tag", tagNames)

/** Tagged's rows: the tag of each kind it holds. */
type TaggedRows = ReadonlyArray<readonly [KindName, TagName]>

/** The closed relation Tagged over `rows`, a kind's tag, keyed by the kind. */
const taggedOf = (rows: TaggedRows) =>
	closed.relation(
		"Tagged",
		{ kind: closedId(Kind), tag: closedId(Tag) },
		["kind"],
		Arr.map(rows, ([kind, tag]) => ({ kind, tag }))
	)

type Tagged = ReturnType<typeof taggedOf>

/** A line as a call states it under its doc: its id and its payload; its doc, its index and its kind are its place. */
interface StatedLine {
	readonly id: number
	readonly a: number
	readonly b: number
}

/** A doc as a call states it: its id, its kind and its lines in order. */
interface StatedDoc {
	readonly id: number
	readonly kind: KindName
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

/** The fields of a key over a selection of Line: one per doc, as pantry's one ID per element, or over `b`. */
const selectedNames = ["doc", "b", "doc, b"] as const

type SelectedName = (typeof selectedNames)[number]

const selectedFields: { readonly [K in SelectedName]: Arr.NonEmptyReadonlyArray<"doc" | "b"> } = {
	doc: ["doc"],
	b: ["b"],
	"doc, b": ["doc", "b"]
}

/**
 * A condition of a selection over Line: its copied kind, a field its family draws, held by Tagged (`tagged`, a closed
 * presence), of a tag (`tag`, a closed read, NULL where Tagged lacks the kind) or equal to a handle (`kind`); its drawn
 * index at 0 (`first`) or past it (`later`); or its stated `b` equal to a value.
 */
type Atom =
	| { readonly kind: "tagged" }
	| { readonly kind: "tag"; readonly tag: TagName }
	| { readonly kind: "kind"; readonly handle: KindName }
	| { readonly kind: "first" }
	| { readonly kind: "later" }
	| { readonly kind: "b"; readonly value: number }

/** A selection's predicate: an atom, or NOT, AND or OR of predicates. */
type Pred =
	| { readonly kind: "atom"; readonly atom: Atom }
	| { readonly kind: "not"; readonly pred: Pred }
	| { readonly kind: "and" | "or"; readonly left: Pred; readonly right: Pred }

/** A key of Line over a selection: its predicate and its fields. */
interface SelectedKey {
	readonly pred: Pred
	readonly fields: SelectedName
}

/** A case's schema: Tagged's rows, Line's declared keys and its keys over selections, and whether Doc and Line are
 * mutable. */
interface Shape {
	readonly tagged: TaggedRows
	readonly keys: ReadonlyArray<KeyName>
	readonly selected: ReadonlyArray<SelectedKey>
	readonly mutableDoc: boolean
	readonly mutableLine: boolean
}

/** A case: its schema, the instance its first call stores, and the docs its second call states. */
interface UniqueCase {
	readonly shape: Shape
	readonly stored: ReadonlyArray<StatedDoc>
	readonly again: Arr.NonEmptyReadonlyArray<StatedDoc>
}

const Doc = relation("Doc", { id: pg.integer, kind: closedId(Kind), n: drawnField(natural) }, [
	"id"
])
const Line = relation(
	"Line",
	{
		id: pg.integer,
		doc: pg.integer,
		at: drawnField(natural),
		kind: accumulated(closedId(Kind), "k0"),
		a: pg.integer,
		b: pg.integer
	},
	["id"]
)

type LineRow = RowScalars<typeof Line>

/** `atom` over a row of Line, as a selection states it. */
const atomPredicate = (tagged: Tagged, atom: Atom, l: LineRow): Predicate => {
	switch (atom.kind) {
		case "tagged":
			return tagged.has(l.kind)
		case "tag":
			return l.eq(tagged.at("tag", l.kind), atom.tag)
		case "kind":
			return l.eq(l.kind, atom.handle)
		case "first":
			return l.eq(l.at, 0n)
		case "later":
			return l.ge(l.at, 1n)
		case "b":
			return l.eq(l.b, atom.value)
	}
}

/** `p` over a row of Line, as a selection states it. */
const predicateOf = (tagged: Tagged, p: Pred, l: LineRow): Predicate => {
	switch (p.kind) {
		case "atom":
			return atomPredicate(tagged, p.atom, l)
		case "not":
			return l.not(predicateOf(tagged, p.pred, l))
		case "and":
		case "or":
			return l[p.kind](predicateOf(tagged, p.left, l), predicateOf(tagged, p.right, l))
	}
}

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

/** The key over a selection `s` of Line, its predicate reading Tagged. */
const selectedStatement = (tagged: Tagged, s: SelectedKey) => {
	const side = select(Line, (l) => predicateOf(tagged, s.pred, l))
	switch (s.fields) {
		case "doc":
			return key(on(side, "doc"))
		case "b":
			return key(on(side, "b"))
		case "doc, b":
			return key(on(side, "doc", "b"))
	}
}

/** A case's relations and statements: the family, the copy of a doc's kind onto its lines, each declared key by its
 * name, each key over a selection by its fields, and every statement of its schema, built once per case, so the schema
 * under any name holds them and its laws are read back from them. */
const statementsOf = (shape: Shape) => {
	const tagged = taggedOf(shape.tagged)
	const lines = ordered(on(Line, "doc", "at"), fin(Doc, "n"))
	const keys = Arr.map(shape.keys, (k) => [k, keyStatement(k)] as const)
	const selected = Arr.map(shape.selected, (s) => [s, selectedStatement(tagged, s)] as const)
	return {
		lines,
		keys,
		selected,
		relations: [Kind, Tag, tagged, Doc, Line],
		all: [
			lines,
			contained(on(Line, "doc", "kind"), on(Doc, "id", "kind")),
			...Arr.map(keys, ([, statement]) => statement),
			...Arr.map(selected, ([, statement]) => statement),
			...(shape.mutableDoc ? [mutable(Doc)] : []),
			...(shape.mutableLine ? [mutable(Line)] : [])
		]
	}
}

/** A truth value of Kleene's logic: a selection holds a row where its predicate is true. */
type Truth = boolean | "unknown"

const kleeneNot = (t: Truth): Truth => (t === "unknown" ? t : !t)

const kleeneAnd = (x: Truth, y: Truth): Truth =>
	x === false || y === false ? false : x === true && y === true ? true : "unknown"

const kleeneOr = (x: Truth, y: Truth): Truth =>
	x === true || y === true ? true : x === false && y === false ? false : "unknown"

/** A line as a selection reads it: its copied kind, its drawn index and its stated `b`. */
interface LineView {
	readonly kind: KindName
	readonly at: bigint
	readonly b: number
}

/** `atom` of a line, under Tagged's rows `tagged`: a closed read at a kind Tagged lacks is NULL, so its comparison is
 * unknown. */
const atomTruth = (tagged: TaggedRows, atom: Atom, line: LineView): Truth => {
	switch (atom.kind) {
		case "tagged":
			return Arr.some(tagged, ([kind]) => kind === line.kind)
		case "tag":
			return Option.match(
				Arr.findFirst(tagged, ([kind]) => kind === line.kind),
				{ onNone: (): Truth => "unknown", onSome: ([, tag]) => tag === atom.tag }
			)
		case "kind":
			return line.kind === atom.handle
		case "first":
			return line.at === 0n
		case "later":
			return line.at >= 1n
		case "b":
			return line.b === atom.value
	}
}

/** `p` of a line in Kleene's logic, under Tagged's rows `tagged`. */
const truthOf = (tagged: TaggedRows, p: Pred, line: LineView): Truth => {
	switch (p.kind) {
		case "atom":
			return atomTruth(tagged, p.atom, line)
		case "not":
			return kleeneNot(truthOf(tagged, p.pred, line))
		case "and":
			return kleeneAnd(truthOf(tagged, p.left, line), truthOf(tagged, p.right, line))
		case "or":
			return kleeneOr(truthOf(tagged, p.left, line), truthOf(tagged, p.right, line))
	}
}

/** Whether a key over a selection holds a line: its predicate is true of it. */
const selects = (tagged: TaggedRows, p: Pred, line: LineView): boolean =>
	truthOf(tagged, p, line) === true

/** What a selection's predicate reads or is, as a situation names it. */
const predClasses = [
	"a closed lookup of the copied kind",
	"the drawn index",
	"a disjunction"
] as const

type PredClass = (typeof predClasses)[number]

/** The classes a predicate falls in. */
const classesOf = (p: Pred): ReadonlyArray<PredClass> => {
	switch (p.kind) {
		case "atom":
			return p.atom.kind === "tagged" || p.atom.kind === "tag"
				? ["a closed lookup of the copied kind"]
				: p.atom.kind === "first" || p.atom.kind === "later"
					? ["the drawn index"]
					: []
		case "not":
			return classesOf(p.pred)
		case "and":
			return Arr.union(classesOf(p.left), classesOf(p.right))
		case "or":
			return Arr.union(["a disjunction"], Arr.union(classesOf(p.left), classesOf(p.right)))
	}
}

/** A law a model names: Doc's key, Line's key, the family `lines`, a declared key of Line, or a key of Line over a
 * selection, by its fields. */
type LawName = "Doc key" | "Line key" | "lines" | `key ${KeyName}` | `selected ${SelectedName}`

/** A value of a row as stored: an integer field's number, a drawn natural's bigint, a closed id's handle. */
type Cell = number | bigint | string

/** A row as written, by field. */
type Row = Readonly<Record<string, Cell>>

/** A line as stored: its id, its place at its doc's index, its doc's kind copied, and its payload. */
type LineFact = {
	readonly id: number
	readonly doc: number
	readonly at: bigint
	readonly kind: KindName
	readonly a: number
	readonly b: number
}

/** A doc as stored: its id, its kind and its count of lines. */
type DocFact = { readonly id: number; readonly kind: KindName; readonly n: bigint }

/** Line's rows as a call writes them: each line at its doc and its index there, with its doc's kind. */
const lineRows = (docs: ReadonlyArray<StatedDoc>): ReadonlyArray<LineFact> =>
	Arr.flatMap(docs, (d) =>
		Arr.map(d.lines, (l, at) => ({
			id: l.id,
			doc: d.id,
			at: BigInt(at),
			kind: d.kind,
			a: l.a,
			b: l.b
		}))
	)

/** Doc's rows as a call writes them: each doc with its kind and its count of lines. */
const docRows = (docs: ReadonlyArray<StatedDoc>): ReadonlyArray<DocFact> =>
	Arr.map(docs, (d) => ({ id: d.id, kind: d.kind, n: BigInt(d.lines.length) }))

/** The rows of `rows`, each once. */
const distinct = <R>(rows: ReadonlyArray<R>): ReadonlyArray<R> =>
	Arr.dedupeWith(rows, (x, y) => deepEquals(x, y))

/** A row's values at `fields`. */
const at = (row: Row, fields: ReadonlyArray<string>): Row =>
	Rec.fromEntries(Arr.map(fields, (f) => [f, defined(row[f], `the field ${f} of a row`)] as const))

/** Whether two rows agree at `fields`. */
const agree = (x: Row, y: Row, fields: ReadonlyArray<string>): boolean =>
	Arr.every(fields, (f) => x[f] === y[f])

/** A unique object of the model over rows `R`: the law it states, its relation, the fields a conflict there names, and
 * the rows it holds apart, every row but where a selection leaves one out. */
interface ObjectAt<R> {
	readonly law: LawName
	readonly relation: "Doc" | "Line"
	readonly fields: Arr.NonEmptyReadonlyArray<string>
	readonly holds: (row: R) => boolean
}

const everyRow = (): boolean => true

/** Every unique object of a case's schema over Doc. */
const docObjects: ReadonlyArray<ObjectAt<DocFact>> = [
	{ law: "Doc key", relation: "Doc", fields: ["id"], holds: everyRow }
]

/** Every unique object of a case's schema over Line. */
const lineObjectsOf = (shape: Shape): ReadonlyArray<ObjectAt<LineFact>> => [
	{ law: "Line key", relation: "Line", fields: ["id"], holds: everyRow },
	{ law: "lines", relation: "Line", fields: ["doc", "at"], holds: everyRow },
	...Arr.map(shape.keys, (k): ObjectAt<LineFact> => ({
		law: `key ${k}`,
		relation: "Line",
		fields: keyFields[k],
		holds: everyRow
	})),
	...Arr.map(shape.selected, (s): ObjectAt<LineFact> => ({
		law: `selected ${s.fields}`,
		relation: "Line",
		fields: selectedFields[s.fields],
		holds: (line) => selects(shape.tagged, s.pred, line)
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
			readonly docs: ReadonlyArray<DocFact>
			readonly lines: ReadonlyArray<LineFact>
			readonly adds: boolean
	  }
	| { readonly kind: "refused"; readonly breaks: Arr.NonEmptyReadonlyArray<Break> }

/** Each break of `objects` by a stated row of `stated` against a row of `all`: one each object holds, which agrees with
 * it at the object's fields and differs elsewhere. */
const breaksAt = <R extends Row>(
	objects: ReadonlyArray<ObjectAt<R>>,
	stated: ReadonlyArray<R>,
	all: ReadonlyArray<R>,
	stored: ReadonlyArray<R>
): ReadonlyArray<Break> =>
	Arr.flatMap(objects, (o) =>
		Arr.flatMap(stated, (n) =>
			Arr.flatMap(all, (r): ReadonlyArray<Break> =>
				!deepEquals(r, n) && o.holds(r) && o.holds(n) && agree(r, n, o.fields)
					? [
							{
								law: o.law,
								relation: o.relation,
								values: at(n, o.fields),
								meets: Arr.some(stored, (s) => deepEquals(s, r)) ? "stored" : "stated"
							}
						]
					: []
			)
		)
	)

/** The set rule over a stored instance and a second call (see the header). */
const verdictOf = (
	shape: Shape,
	stored: ReadonlyArray<StatedDoc>,
	again: ReadonlyArray<StatedDoc>
): Verdict => {
	const storedDocs = distinct(docRows(stored))
	const storedLines = distinct(lineRows(stored))
	const statedDocs = distinct(docRows(again))
	const statedLines = distinct(lineRows(again))
	const allDocs = distinct([...storedDocs, ...statedDocs])
	const allLines = distinct([...storedLines, ...statedLines])
	const breaks: Array<Break> = [
		...breaksAt(docObjects, statedDocs, allDocs, storedDocs),
		...breaksAt(lineObjectsOf(shape), statedLines, allLines, storedLines)
	]
	/** Each doc's lines as a statement of it writes them, which a stored doc's or another statement's must equal. */
	const linesOf = (d: StatedDoc): ReadonlyArray<LineFact> => lineRows([d])
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
				docs: allDocs,
				lines: allLines,
				adds:
					Arr.some(statedDocs, (row) => !Arr.some(storedDocs, (s) => deepEquals(s, row))) ||
					Arr.some(statedLines, (row) => !Arr.some(storedLines, (s) => deepEquals(s, row)))
			}
}

/**
 * The keys over selections a written set holds two lines apart at, at least one of them stated, where exactly one of
 * the two is selected: a key that leaves a row out does not hold it apart.
 */
const oneSelectedPairs = (
	shape: Shape,
	lines: ReadonlyArray<LineFact>,
	stated: ReadonlyArray<LineFact>
): ReadonlyArray<SelectedKey> =>
	Arr.filter(shape.selected, (s) =>
		Arr.some(stated, (n) =>
			Arr.some(
				lines,
				(r) =>
					!deepEquals(r, n) &&
					agree(r, n, selectedFields[s.fields]) &&
					selects(shape.tagged, s.pred, r) !== selects(shape.tagged, s.pred, n)
			)
		)
	)

/** A doc's lines as a stored instance holds them: the longest prefix of `lines` the instance `before` and the keys of
 * `shape` admit, so every stored instance is valid by construction and keeps each line at its index. */
const admittedPrefix = (
	shape: Shape,
	before: ReadonlyArray<StatedDoc>,
	doc: StatedDoc
): StatedDoc => {
	for (let n = doc.lines.length; n > 0; n -= 1) {
		const prefix = { ...doc, lines: doc.lines.slice(0, n) }
		if (verdictOf(shape, [], [...before, prefix]).kind === "written") {
			return prefix
		}
	}
	return { ...doc, lines: [] }
}

/** `docs` as a stored instance: each doc the longest prefix of its lines the docs before it admit. */
const admitted = (shape: Shape, docs: ReadonlyArray<StatedDoc>): ReadonlyArray<StatedDoc> =>
	Arr.reduce(docs, Arr.empty<StatedDoc>(), (kept, d) => [...kept, admittedPrefix(shape, kept, d)])

/** A case's stored instance, valid by construction under every declared key (each line's `a` its id, its `b` its
 * index) and under every key over a selection (`admitted`). */
const storedGen =
	(shape: Shape): Gen<ReadonlyArray<StatedDoc>> =>
	(source) => {
		const docs: Array<StatedDoc> = []
		let next = 1
		for (let d = 1, count = source.draw(int(0, 3)); d <= count; d += 1) {
			const lines: Array<StatedLine> = []
			for (let i = 0, n = source.draw(int(0, 3)); i < n; i += 1) {
				lines.push({ id: next, a: next, b: i })
				next += 1
			}
			docs.push({ id: d, kind: source.draw(element(kindNames)), lines })
		}
		return admitted(shape, docs)
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
					kind: d.kind,
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
			return { id, kind: s.draw(element(kindNames)), lines }
		}
		const first = source.draw(docGen)
		const rest: Array<StatedDoc> = []
		for (let n = source.draw(int(0, 2)); n > 0; n -= 1) {
			rest.push(source.draw(docGen))
		}
		return [first, ...rest]
	}

/** An atom of a selection (`Atom`), every one but `b` over a field the family draws. */
const atomGen: Gen<Atom> = weighted([
	[1, (): Atom => ({ kind: "tagged" })],
	[1, (s): Atom => ({ kind: "tag", tag: s.draw(element(tagNames)) })],
	[1, (s): Atom => ({ kind: "kind", handle: s.draw(element(kindNames)) })],
	[1, (): Atom => ({ kind: "first" })],
	[1, (): Atom => ({ kind: "later" })],
	[1, (s): Atom => ({ kind: "b", value: s.draw(int(0, 2)) })]
])

/** A selection's predicate of at most `depth` connectives: an atom, or NOT, AND or OR of smaller ones, OR weighted as
 * NOT and AND together, since a disjunction is a guard that binds more loosely than the key's conjunction. */
const predGen = (depth: number): Gen<Pred> => {
	const atom: Gen<Pred> = (s) => ({ kind: "atom", atom: s.draw(atomGen) })
	if (depth === 0) {
		return atom
	}
	const smaller = predGen(depth - 1)
	const connective =
		(kind: "and" | "or"): Gen<Pred> =>
		(s) => ({ kind, left: s.draw(smaller), right: s.draw(smaller) })
	return weighted([
		[1, atom],
		[1, (s): Pred => ({ kind: "not", pred: s.draw(smaller) })],
		[1, connective("and")],
		[2, connective("or")]
	])
}

/** A predicate of the class `c` (`classesOf`), alone or beside a drawn one under AND or OR. */
const classPredGen =
	(c: PredClass): Gen<Pred> =>
	(source) => {
		const own = ((): Pred => {
			switch (c) {
				case "a closed lookup of the copied kind":
					return {
						kind: "atom",
						atom: source.draw(
							element([{ kind: "tagged" }, { kind: "tag", tag: "t0" }, { kind: "tag", tag: "t1" }])
						)
					}
				case "the drawn index":
					return {
						kind: "atom",
						atom: source.draw(element([{ kind: "first" }, { kind: "later" }]))
					}
				case "a disjunction":
					return { kind: "or", left: source.draw(predGen(1)), right: source.draw(predGen(1)) }
			}
		})()
		const beside = source.draw(element(["alone", "and", "or"] as const))
		return beside === "alone"
			? own
			: source.draw(boolean)
				? { kind: beside, left: own, right: source.draw(predGen(1)) }
				: { kind: beside, left: source.draw(predGen(1)), right: own }
	}

/** Tagged's rows: each kind tagged or not, its tag drawn. */
const taggedGen: Gen<TaggedRows> = (source) =>
	Arr.flatMap(kindNames, (kind) =>
		source.draw(boolean) ? [[kind, source.draw(element(tagNames))] as const] : []
	)

const shapeGen: Gen<Shape> = (source) => ({
	tagged: source.draw(taggedGen),
	keys: source.draw(subarray(keyNames)),
	selected: Arr.map(source.draw(subarray(selectedNames)), (fields) => ({
		pred: source.draw(predGen(2)),
		fields
	})),
	mutableDoc: source.draw(boolean),
	mutableLine: source.draw(boolean)
})

const caseGen: Gen<UniqueCase> = (source) => {
	const shape = source.draw(shapeGen)
	const stored = source.draw(storedGen(shape))
	return { shape, stored, again: source.draw(againGen(stored)) }
}

/** An owner's mutability as a situation names it: an immutable doc's lines are inserted ON CONFLICT at their key at
 * SERIALIZABLE, a mutable doc's by a plain INSERT (write/family/additions.ts memberArbitrated). */
type Owner = "an immutable doc" | "a mutable doc"

/** An object a refusal's witness meets, as a situation names it. */
type Met = "the family key" | "a declared key" | "the line key" | "the doc key" | "a selection key"

type Situation =
	| `${Met} met by a stored row, under ${Owner}`
	| `${Met} met by another stated row, under ${Owner}`
	| "a declared key met where the statement writes several lines of different values there"
	| `two members at a selection key, one selected, admitted, under ${Owner}`
	| `a verdict at a selection key over ${PredClass}`
	| "accepted"
	| "unchanged"

const metOf = (law: LawName): Met =>
	law === "lines"
		? "the family key"
		: law === "Line key"
			? "the line key"
			: law === "Doc key"
				? "the doc key"
				: Str.startsWith("selected")(law)
					? "a selection key"
					: "a declared key"

/** What a case aims at while a situation is pending: the object a stated row meets and by what, under which owner; a
 * key over a selection met by a stored or a stated row, or two members at it with one selected, under which owner and
 * over a predicate of which class, or any; an accepted or an unchanged call. */
type Aim =
	| {
			readonly kind: "meets"
			readonly met: Exclude<Met, "the doc key" | "a selection key">
			readonly by: "stored" | "stated"
			readonly owner: Owner
	  }
	| {
			readonly kind: "selection"
			readonly outcome: "stored" | "stated" | "one selected"
			readonly owner: Owner
			readonly over: PredClass | "any"
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
		] as const,
		[
			`a selection key met by a stored row, under ${owner}`,
			{ kind: "selection", outcome: "stored", owner, over: "any" }
		] as const,
		[
			`a selection key met by another stated row, under ${owner}`,
			{ kind: "selection", outcome: "stated", owner, over: "any" }
		] as const,
		[
			`two members at a selection key, one selected, admitted, under ${owner}`,
			{ kind: "selection", outcome: "one selected", owner, over: "any" }
		] as const
	]),
	[
		"a declared key met where the statement writes several lines of different values there",
		{ kind: "meets", met: "a declared key", by: "stored", owner: "a mutable doc" }
	],
	...Arr.map(
		predClasses,
		(over) =>
			[
				`a verdict at a selection key over ${over}`,
				{ kind: "selection", outcome: "one selected", owner: "an immutable doc", over }
			] as const
	)
]

const situations: Arr.NonEmptyReadonlyArray<Situation> = Arr.map(aims, ([s]) => s)

/** A stored instance of one to three docs, the first holding one to three lines, admitted as storedGen's. */
const someStoredGen =
	(shape: Shape): Gen<Arr.NonEmptyReadonlyArray<StatedDoc>> =>
	(source) => {
		const drawnStored = source.draw(storedGen(shape))
		const firstLines = Array.from({ length: source.draw(int(1, 3)) }, (_, i) => i)
		const offset = Arr.reduce(
			Arr.flatMap(drawnStored, (d) => d.lines),
			0,
			(most, l) => Math.max(most, l.id)
		)
		const first: StatedDoc = {
			id: drawnStored.length + 1,
			kind: source.draw(element(kindNames)),
			lines: Arr.map(firstLines, (i) => ({ id: offset + i + 1, a: offset + i + 1, b: i }))
		}
		const [kept, ...rest] = admitted(shape, [first, ...drawnStored])
		return [defined(kept, "the first stored doc"), ...rest]
	}

/** The largest id or `a` a stored instance holds, past its doc ids. */
const pastOf = (stored: ReadonlyArray<StatedDoc>): number =>
	Arr.reduce(
		Arr.flatMap(stored, (d) => d.lines),
		stored.length,
		(most, l) => Math.max(most, l.id, l.a)
	) + 1

/**
 * A case aimed at `aim`, a key over a selection: its owner's mutability forced, one key over a selection drawn of the
 * aimed class (`b` where a stored row meets it), and no declared key over (doc, b) where the selection's fields hold
 * `b`, so the call's lines meet no declared key; a stored instance admitted under it; and a second call of one fresh
 * doc, constructed from every kind and `b` its lines may take: two lines agreeing at the key's fields with exactly one
 * selected, its key held by no stored selected line (`one selected`); two lines agreeing there both selected
 * (`stated`); or one line at a stored selected line's `b`, selected (`stored`). Where no choice reaches the aim under the
 * drawn predicate, the call is drawn as any case's.
 */
const selectionAimedGen =
	(aim: Extract<Aim, { readonly kind: "selection" }>): Gen<UniqueCase> =>
	(source) => {
		const drawnShape = source.draw(shapeGen)
		const fields: SelectedName =
			aim.outcome === "stored" ? "b" : source.draw(element(selectedNames))
		const pred = source.draw(aim.over === "any" ? predGen(2) : classPredGen(aim.over))
		const holdsB = selectedFields[fields].includes("b")
		const shape: Shape = {
			...drawnShape,
			mutableDoc: aim.owner === "a mutable doc",
			selected: [{ pred, fields }],
			keys: holdsB ? Arr.filter(drawnShape.keys, (k) => k !== "doc, b") : drawnShape.keys
		}
		const stored = source.draw(someStoredGen(shape))
		const past = pastOf(stored)
		const selected = (kind: KindName, index: number, b: number): boolean =>
			selects(shape.tagged, pred, { kind, at: BigInt(index), b })
		const storedSelected = Arr.filter(lineRows(stored), (l) => selects(shape.tagged, pred, l))
		const holdsDoc = selectedFields[fields].includes("doc")
		const values = [0, 1, 2] as const
		const pairs = Arr.flatMap(kindNames, (kind) =>
			Arr.flatMap(values, (b0) =>
				Arr.flatMap(values, (b1) => (holdsB && b0 !== b1 ? [] : [{ kind, b0, b1 }]))
			)
		)
		const twoLines = (p: {
			readonly kind: KindName
			readonly b0: number
			readonly b1: number
		}) => ({
			id: past,
			kind: p.kind,
			lines: [
				{ id: past + 1, a: past + 1, b: p.b0 },
				{ id: past + 2, a: past + 2, b: p.b1 }
			]
		})
		const choices: ReadonlyArray<StatedDoc> = ((): ReadonlyArray<StatedDoc> => {
			switch (aim.outcome) {
				case "one selected":
					return Arr.map(
						Arr.filter(pairs, (p) => {
							const s0 = selected(p.kind, 0, p.b0)
							const s1 = selected(p.kind, 1, p.b1)
							const keyB = s0 ? p.b0 : p.b1
							return s0 !== s1 && (holdsDoc || !Arr.some(storedSelected, (l) => l.b === keyB))
						}),
						twoLines
					)
				case "stated":
					return Arr.map(
						Arr.filter(pairs, (p) => selected(p.kind, 0, p.b0) && selected(p.kind, 1, p.b1)),
						twoLines
					)
				case "stored":
					return Arr.flatMap(storedSelected, (r) =>
						Arr.flatMap(kindNames, (kind) =>
							selected(kind, 0, r.b)
								? [{ id: past, kind, lines: [{ id: past + 1, a: past + 1, b: r.b }] }]
								: []
						)
					)
			}
		})()
		const again: Arr.NonEmptyReadonlyArray<StatedDoc> = Arr.isReadonlyArrayNonEmpty(choices)
			? [defined(choices[source.draw(int(0, choices.length - 1))], "a choice")]
			: source.draw(againGen(stored))
		return { shape, stored, again }
	}

/**
 * A case aimed at `aim`: its owner's mutability forced, the key "a" among its declared keys where it meets one and none
 * where it meets the family key, a stored instance with lines, and a second call of one doc built to meet the aimed
 * object alone, every value a stored one it meets or fresh past every stored one.
 */
const aimedGen =
	(aim: Aim): Gen<UniqueCase> =>
	(source) => {
		if (aim.kind === "selection") {
			return source.draw(selectionAimedGen(aim))
		}
		const drawnShape = source.draw(shapeGen)
		const shape: Shape =
			aim.kind === "meets"
				? {
						...drawnShape,
						selected: [],
						mutableDoc: aim.owner === "a mutable doc",
						keys:
							aim.met === "a declared key"
								? Arr.union(["a"], drawnShape.keys)
								: aim.met === "the family key"
									? []
									: drawnShape.keys
					}
				: drawnShape
		const stored = source.draw(someStoredGen(shape))
		const storedLines = Arr.flatMap(stored, (d) => d.lines)
		const target = defined(
			storedLines[source.draw(int(0, storedLines.length - 1))],
			"a stored line"
		)
		const past = pastOf(stored)
		const freshDoc = (lines: ReadonlyArray<StatedLine>): StatedDoc => ({
			id: past,
			kind: source.draw(element(kindNames)),
			lines
		})
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
						kind: d.kind,
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

/** A call's facts: each doc with its kind and its lines nested at its count, each line its id and payload. */
const factsOf = (docs: ReadonlyArray<StatedDoc>) => ({
	insert: {
		Doc: Arr.map(docs, (d) => ({
			id: d.id,
			kind: d.kind,
			n: Arr.map(d.lines, (l) => ({ id: l.id, a: l.a, b: l.b }))
		}))
	}
})

/** Each relation of an installed case stores exactly `docs` and `lines`. */
const storesExactly = (
	done: Installed,
	docs: ReadonlyArray<DocFact>,
	lines: ReadonlyArray<LineFact>,
	after: string
) =>
	Effect.gen(function* () {
		const storedDocs = yield* tableState(done, Doc)
		const storedLines = yield* tableState(done, Line)
		unorderedEqual(
			storedDocs,
			Arr.map(docs, (r): StateRow => ({ ...r })),
			`Doc's rows after ${after}`
		)
		unorderedEqual(
			storedLines,
			Arr.map(lines, (r): StateRow => ({ ...r })),
			`Line's rows after ${after}`
		)
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
						coverage: required<Situation>(situations, { cases: 96, sense: notesOnly }),
						kept: [],
						runs: 16,
						shrink: boundedShrink(40),
						concurrency: 1,
						steerEvery: 8,
						caseHang,
						oracle: {
							kind: "specification",
							name: "the README's set rule over relations as sets of rows with their unique objects, a key over a selection holding the rows its selection is true of (verdictOf)"
						}
					},
					(drawnCase, c) =>
						Effect.gen(function* () {
							const { shape, stored, again } = aimedCase(drawnCase, c)
							const statements = statementsOf(shape)
							const schemaNamed = (name: string) =>
								schema(name, statements.relations, statements.all)
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
								]),
								...Arr.map(statements.selected, ([s, statement]): readonly [LawName, LawId] => [
									`selected ${s.fields}`,
									lawNames.lawOf(statement)
								])
							]
							const lawId = (law: LawName): LawId =>
								defined(
									Option.getOrUndefined(Arr.findFirst(lawIds, ([name]) => name === law))?.[1],
									`the law ${law}`
								)
							const owner: Owner = shape.mutableDoc ? "a mutable doc" : "an immutable doc"
							/** Notes a verdict a key over a selection decided, by each class its predicate falls in. */
							const noteClasses = (s: SelectedKey): void => {
								for (const over of classesOf(s.pred)) {
									c.note(`a verdict at a selection key over ${over}`)
								}
							}
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
									`the first insert of ${Formatter.format(stored)} under ${Formatter.format(shape)}`
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
									for (const s of oneSelectedPairs(
										shape,
										verdict.lines,
										distinct(lineRows(again))
									)) {
										c.note(`two members at a selection key, one selected, admitted, under ${owner}`)
										noteClasses(s)
									}
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
								for (const [s] of Arr.filter(
									statements.selected,
									([s]) => `selected ${s.fields}` === met.law
								)) {
									noteClasses(s)
								}
								const statedLines = distinct(lineRows(again))
								const fields = Option.getOrUndefined(
									Arr.findFirst(lineObjectsOf(shape), (o) => o.law === met.law)
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
