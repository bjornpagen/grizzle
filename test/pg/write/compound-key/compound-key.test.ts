import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	element,
	type Gen,
	int,
	shuffled,
	subset,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { boundedShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, Result } from "effect"
import { onceCalls, type WrittenOutcome } from "#adapter/db/handles.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { ParamMap } from "#compiler/plan/common.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { schema, type Statement } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"
import { describeFieldOrThrow } from "#compiler/scalar/registry.ts"
import { relation } from "#compiler/schema/relation.ts"
import { btreeMaxItemSize, keyLayout } from "#compiler/schema/representability.ts"
import {
	containedBuilder,
	keyBuilder,
	mutableBuilder,
	onBuilder
} from "#compiler/schema/statements.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { rowOf } from "#test/pg/page/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, deepEquals, defined, nonEmpty, unorderedEqual } from "#test/support/assert.ts"
import { answered, readOnce, type WriteAnswer, writeOnce } from "#test/support/calls.ts"
import { paramsOver } from "#test/support/compile.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { lawNamesOf, namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { plannedIndexes, recordingMembers, sentProblems, unanalyzed } from "#test/support/plans.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { type StateRow, tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { wideOctets } from "#test/support/wide-text.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * Compound keys of byte-bounded text under writes and reads, on PostgreSQL 19rc2, with their arity, their order and
 * their texts' byte bounds drawn per case, up to and past PostgreSQL's B-tree item limit (nbtree.h BTMaxItemSize, 2,704
 * bytes on an 8 KiB page, schema/representability.ts btreeMaxItemSize).
 *
 * A case declares Parent(t0, t1, t2, n, payload), each `t` text of at most its drawn number of UTF-8 bytes
 * (`str.bytes(w, str.regex("^.*$", "su"))`), keyed by a drawn ordering of a drawn subset of (t0, t1, t2, n) holding a
 * text, with a declared key over `payload` and a drawn subset of the texts in a drawn order, mutable or not; and
 * Child(id, c_<f> for each key field f) whose c_ fields are contained in Parent's key, the containment's fields in a
 * drawn order of them. A text value is the empty text, `a`, `b`, or the widest value its bound admits, which no
 * compression shortens (test/support/wide-text.ts wideOctets); `n` and `payload` are small integers. One of the key's
 * texts may be sized to the widest bound grizzle's layout admits beside the rest, or one byte past it.
 *
 * Oracles:
 * - PostgreSQL's own acceptance (README "Keys and indexes": "A key past either is UnrepresentableKey when the schema
 *   compiles, naming each column's counted bytes, not PostgreSQL's 54000 at the first write"). A schema it refuses is
 *   refused with `UnrepresentableKey`, a `btreeEntry` fault counting past BTMaxItemSize, naming one of Parent's keys
 *   in its declared order, never an internal error. A schema it installs takes the widest value at every text through
 *   its writes, and PostgreSQL holds the widest entry of each of its keys in a unique index over a table of the same
 *   columns in that order. Whether PostgreSQL also refuses a refused key's widest entry is noted, never asserted: the
 *   README counts an entry "from its columns' types", at its worst alignment.
 * - The catalog: Parent's primary key and its declared key are unique indexes over exactly their fields in their
 *   declared order, and the containment is one foreign key from Child to Parent pairing its fields in its declared
 *   order (README "Keys and containment").
 * - The set model of each write (README "Writes"): an insert adds the rows no stored row repeats and a put leaves the
 *   row at each primary key the one given, each refused on a key where two rows it adds share it and differ; a delete
 *   removes the stored rows equal to a row it names, so a row unlike the stored one at its key changes nothing and two
 *   rows it names at one key are no refusal (README.md:2695-2697, "a deletion names its row exactly"); every declared
 *   key holds after each, and every Child row's key is a Parent's at commit. A refused write names only laws its rows
 *   break; a key's refusal is witnessed by a row the write states that breaks it, at the broken key's fields or at the
 *   row's primary key (README.md:2853-2856 says both "the key of one row that breaks the rule" and "witnessed by the key
 *   you submitted"), and a containment's is `unreported` (README "Errors and outcomes", Witness: "unreported for a
 *   foreign key").
 * - PostgreSQL's plans: every read by the primary key, by the declared key and of a Child joined to its Parent,
 *   EXPLAINed as the runtime sent it over relations left unanalyzed with sequential and index scans disabled
 *   (test/support/plans.ts sentProblems), reads each restricted relation through an index the installation planned;
 *   and each returns the model's rows.
 *
 * Features: each arity of the primary key with its texts in declared order and out of it, a key refused past the item
 * limit, a key at the limit accepted, a containment out of the key's order, a write of each op refused on each law,
 * and a delete at a key at the limit of a row unlike the stored one there, alone or beside it.
 *
 * Plants: ~/.cache/grizzle-release/KEYSTRESS/plants/compound-key-unique-reordered.patch, a key's UNIQUE planned over
 * its fields in sorted order, and compound-key-oversized-internal.patch, the B-tree entry bound never refusing, so the
 * widest write meets 54000 as an ExecutionFailure; ~/.cache/grizzle-release/LONGKEY/plants/
 * compound-key-delete-at-key.patch, a delete matching stored rows at the primary key alone; each must turn the property
 * red.
 */

const TEXTS = ["t0", "t1", "t2"] as const

type TextField = (typeof TEXTS)[number]

type KeyField = TextField | "n"

/** A Parent row's values: each text, `n` and `payload`. */
type ParentRow = {
	readonly t0: string
	readonly t1: string
	readonly t2: string
	readonly n: number
	readonly payload: number
}

/** A Child row: its id and the values of the Parent key it names, each at its key field. */
type ChildRow = {
	readonly id: number
	readonly t0: string
	readonly t1: string
	readonly t2: string
	readonly n: number
}

/** A ChangeSet: an insert of Parent and Child rows, a put of Parent rows, or a delete of Parent rows by their keys. */
type Write =
	| {
			readonly op: "insert"
			readonly parents: ReadonlyArray<ParentRow>
			readonly children: ReadonlyArray<ChildRow>
	  }
	| { readonly op: "put" | "delete"; readonly parents: Arr.NonEmptyReadonlyArray<ParentRow> }

/** A write's facts as its call states them: under each operation, each relation's facts. */
type CallFacts = Readonly<Record<string, Readonly<Record<string, ReadonlyArray<unknown>>>>>

/** A case's schema: each text's byte bound, the keys' orders, the containment's, and whether Parent is mutable. */
interface Shape {
	readonly widths: readonly [number, number, number]
	readonly key: Arr.NonEmptyReadonlyArray<KeyField>
	readonly unique: Arr.NonEmptyReadonlyArray<"payload" | TextField>
	readonly target: Arr.NonEmptyReadonlyArray<KeyField>
	readonly mutable: boolean
}

interface KeyCase {
	readonly shape: Shape
	readonly salt: number
	readonly writes: ReadonlyArray<Write>
}

/** A write's op as a situation names it. */
type OpLabel = "an insert" | "a put" | "a delete"

const opLabels: { readonly [O in Write["op"]]: OpLabel } = {
	insert: "an insert",
	put: "a put",
	delete: "a delete"
}

/** A primary key's arity as a situation names it. */
const arityOf = (key: Arr.NonEmptyReadonlyArray<KeyField>): 1 | 2 | 3 | 4 => {
	switch (key.length) {
		case 1:
			return 1
		case 2:
			return 2
		case 3:
			return 3
		default:
			return 4
	}
}

type Situation =
	| `a primary key of ${1 | 2 | 3 | 4} fields, its texts ${"in" | "out of"} their declared order`
	| "a key refused past the item limit"
	| "a key at the item limit accepted"
	| "a containment out of the key's order"
	| `${OpLabel} refused on ${"the primary key" | "the declared key" | "the containment"}`
	| "a write of the widest values accepted"
	| "a delete of a row unlike the stored one at its key, which keeps it"
	| "a delete of two rows at one key, which is no refusal"
	| "a refused key whose widest entry PostgreSQL refuses too"
	| "a refused key whose widest entry PostgreSQL holds"

const situations: Arr.NonEmptyReadonlyArray<Situation> = [
	"a primary key of 1 fields, its texts in their declared order",
	"a primary key of 2 fields, its texts in their declared order",
	"a primary key of 2 fields, its texts out of their declared order",
	"a primary key of 3 fields, its texts out of their declared order",
	"a primary key of 4 fields, its texts out of their declared order",
	"a key refused past the item limit",
	"a key at the item limit accepted",
	"a containment out of the key's order",
	"an insert refused on the primary key",
	"an insert refused on the declared key",
	"an insert refused on the containment",
	"a put refused on the declared key",
	"a delete refused on the containment",
	"a write of the widest values accepted",
	"a delete of a row unlike the stored one at its key, which keeps it",
	"a delete of two rows at one key, which is no refusal"
]

/** A byte-bounded text of at most `w` bytes. */
const textOf = (w: number) => str.bytes(w, str.regex("^.*$", "su"))

/** Parent's field descriptors by name. */
const parentFields = (s: Shape): Readonly<Record<string, FieldBase>> => ({
	t0: textOf(s.widths[0]),
	t1: textOf(s.widths[1]),
	t2: textOf(s.widths[2]),
	n: pg.int4,
	payload: pg.int4
})

/** A key field's name on Child. */
const childField = (f: KeyField): string => `c_${f}`

/** Child's field descriptors by name: its id and a field of each Parent key field's type. */
const childFields = (s: Shape): Readonly<Record<string, FieldBase>> => {
	const parent = parentFields(s)
	return Rec.fromEntries([
		["id", pg.int4] as const,
		...Arr.map(s.key, (f) => [childField(f), defined(parent[f], "a key field")] as const)
	])
}

/** A case's schema value under a declared name, its relations, and its statements by role. */
const built = (s: Shape) => {
	const Parent = relation("Parent", parentFields(s), s.key, [])
	const Child = relation("Child", childFields(s), ["id"], [])
	const declaredKey = keyBuilder(onBuilder(Parent, s.unique))
	const containment = containedBuilder(
		onBuilder(Child, Arr.map(s.target, childField)),
		onBuilder(Parent, s.target)
	)
	const statements: ReadonlyArray<Statement> = [
		declaredKey,
		containment,
		...(s.mutable ? [mutableBuilder(Parent)] : [])
	]
	return {
		Parent,
		Child,
		declaredKey,
		containment,
		rename: (name: string) => schema(name, [Parent, Child], statements)
	}
}

/** The most bytes a key's B-tree entry can reach by grizzle's layout, or none where it refuses the key. */
const layoutBytes = (s: Shape, fields: ReadonlyArray<string>): Option.Option<number> => {
	const parent = parentFields(s)
	const layout = keyLayout(
		Arr.map(fields, (field) => ({
			field,
			desc: describeFieldOrThrow(
				defined(parent[field], "a key field"),
				SourceLoc(`Parent.${field}`, [])
			).desc
		}))
	)
	return layout.ok ? Option.some(layout.value.btreeBytes) : Option.none()
}

/** A byte bound: a few bytes, a few hundred, or near a third of the item limit. */
const widthGen: Gen<number> = weighted([
	[3, int(1, 8)],
	[2, int(9, 300)],
	[2, int(600, 1400)]
])

/** Where a shape's widths stand: drawn, one key text at the widest bound grizzle's layout admits, or a byte past it. */
type Edge = "drawn" | "at the limit" | "past the limit"

/** What a witness aims a shape at: its primary key's arity and whether its texts stand in order, or its edge. */
type ShapeAim =
	| { readonly kind: "key"; readonly arity: 1 | 2 | 3 | 4; readonly inOrder: boolean }
	| { readonly kind: "edge"; readonly edge: Exclude<Edge, "drawn"> }

/**
 * What a witness aims a case at: its shape, or a delete of a row unlike the widest row at its key, one of whose texts is
 * at the item limit, once the widest row alone is inserted: the unlike row alone, or (`beside`) beside the widest row;
 * and (`held`) with a Child naming the widest row inserted beside it.
 */
type Aim = ShapeAim | { readonly kind: "delete"; readonly beside: boolean; readonly held: boolean }

/** Every permutation of `xs`, drawn. */
const all = <A>(xs: ReadonlyArray<A>): Gen<ReadonlyArray<A>> =>
	shuffled(xs, { min: xs.length, max: xs.length })

/**
 * The key fields of a primary key of `arity` fields, its texts in their declared order or out of it: three texts and
 * `n` for four, a drawn choice of texts with `n` or not below it, the texts sorted or, where they are two or more, in a
 * drawn order out of it.
 */
const aimedKey =
	(arity: 1 | 2 | 3 | 4, inOrder: boolean): Gen<Arr.NonEmptyReadonlyArray<KeyField>> =>
	(source) => {
		const withN = arity === 4 || (arity > 1 && (inOrder || arity === 3) && source.draw(boolean))
		const textCount = Math.min(3, withN ? arity - 1 : arity)
		const texts = source.draw(subset(TEXTS, { min: textCount, max: textCount }))
		const ordered = inOrder ? texts : Arr.reverse(texts)
		return nonEmpty(withN ? [...ordered, "n" as const] : ordered)
	}

/**
 * A shape: drawn bounds; a primary key over a drawn subset of the key fields holding a text, in a drawn order (or the
 * aimed arity and order); a declared key over `payload` and a drawn subset of the texts, in a drawn order, `payload`
 * alone where an edge is aimed at; the containment in a drawn order of the primary key's fields; and, at an edge, one
 * of the key's texts sized to the widest bound grizzle's layout admits beside the rest, or one byte past it.
 */
const shapeWith =
	(aim: Option.Option<ShapeAim>): Gen<Shape> =>
	(source) => {
		const drawnKey = (): Arr.NonEmptyReadonlyArray<KeyField> => {
			const texts = source.draw(subset(TEXTS, { min: 1, max: 3 }))
			const withN = source.draw(boolean)
			return nonEmpty(source.draw(all<KeyField>([...texts, ...(withN ? (["n"] as const) : [])])))
		}
		const key = Option.match(aim, {
			onNone: drawnKey,
			onSome: (a) => (a.kind === "key" ? source.draw(aimedKey(a.arity, a.inOrder)) : drawnKey())
		})
		const texts = Arr.filter(TEXTS, (t) => Arr.some(key, (f) => f === t))
		const edgeAim = Option.flatMap(aim, (a) =>
			a.kind === "edge" ? Option.some(a.edge) : Option.none()
		)
		const unique = Option.isSome(edgeAim)
			? nonEmpty(["payload" as const])
			: nonEmpty(
					source.draw(all(["payload" as const, ...source.draw(subset(TEXTS, { min: 0, max: 3 }))]))
				)
		const target = nonEmpty(source.draw(all(key)))
		const widths: [number, number, number] = [
			source.draw(widthGen),
			source.draw(widthGen),
			source.draw(widthGen)
		]
		const base: Shape = { widths, key, unique, target, mutable: source.draw(boolean) }
		const edge: Edge = Option.getOrElse(edgeAim, () =>
			source.draw(element(["drawn", "at the limit", "past the limit"] as const))
		)
		if (edge === "drawn" || !Arr.isReadonlyArrayNonEmpty(texts)) {
			return base
		}
		const sized = source.draw(element(texts))
		const at = TEXTS.indexOf(sized)
		const sizedTo = (w: number): Shape => ({
			...base,
			widths: [at === 0 ? w : widths[0], at === 1 ? w : widths[1], at === 2 ? w : widths[2]]
		})
		if (Option.isNone(layoutBytes(sizedTo(1), key))) {
			return base
		}
		let lo = 1
		let hi = btreeMaxItemSize.value
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2)
			if (Option.isSome(layoutBytes(sizedTo(mid), key))) {
				lo = mid
			} else {
				hi = mid - 1
			}
		}
		return sizedTo(edge === "at the limit" ? lo : lo + 1)
	}

/** A text field's values: the empty text, `a`, `b`, and its widest value. */
const valuesOf = (s: Shape, salt: number, f: TextField): Arr.NonEmptyReadonlyArray<string> => {
	const at = TEXTS.indexOf(f)
	return ["", "a", "b", wideOctets(defined(s.widths[at], "a bound"), salt + at)]
}

const parentGen =
	(s: Shape, salt: number): Gen<ParentRow> =>
	(source) => ({
		t0: source.draw(element(valuesOf(s, salt, "t0"))),
		t1: source.draw(element(valuesOf(s, salt, "t1"))),
		t2: source.draw(element(valuesOf(s, salt, "t2"))),
		n: source.draw(int(0, 2)),
		payload: source.draw(int(0, 2))
	})

/** The widest row: every text at its widest value. */
const widest = (s: Shape, salt: number): ParentRow => ({
	t0: Arr.lastNonEmpty(valuesOf(s, salt, "t0")),
	t1: Arr.lastNonEmpty(valuesOf(s, salt, "t1")),
	t2: Arr.lastNonEmpty(valuesOf(s, salt, "t2")),
	n: 0,
	payload: 0
})

/** A Child naming a drawn Parent row, stored or not, by its key. */
const childGen =
	(parents: Arr.NonEmptyReadonlyArray<ParentRow>, id: number): Gen<ChildRow> =>
	(source) => {
		const p = source.draw(element(parents))
		return { id, t0: p.t0, t1: p.t1, t2: p.t2, n: p.n }
	}

/**
 * A case: its shape, its salt, and up to four ChangeSets, the first inserting the widest row beside drawn ones; or,
 * aimed at a delete, inserting the widest row alone (and a Child naming it, where `held`), then the aimed delete of a
 * row unlike it in `payload` alone, then the drawn ones.
 */
const caseWith =
	(aim: Option.Option<Aim>): Gen<KeyCase> =>
	(source) => {
		const deleting = Option.flatMap(aim, (a) =>
			a.kind === "delete" ? Option.some(a) : Option.none()
		)
		const shape = source.draw(
			shapeWith(
				Option.map(aim, (a): ShapeAim =>
					a.kind === "delete" ? { kind: "edge", edge: "at the limit" } : a
				)
			)
		)
		const salt = source.draw(int(0, 0xffff))
		const wide = widest(shape, salt)
		const pool = nonEmpty([wide, ...source.draw(array(parentGen(shape, salt), { min: 1, max: 4 }))])
		const writes: Array<Write> = Option.match(deleting, {
			onNone: (): Array<Write> => [
				{
					op: "insert",
					parents: [wide, ...source.draw(array(element(pool), { min: 0, max: 2 }))],
					children: source.draw(array(childGen(pool, 1), { min: 0, max: 1 }))
				}
			],
			onSome: ({ beside, held }): Array<Write> => {
				const unlike: ParentRow = { ...wide, payload: source.draw(int(1, 2)) }
				const child: ChildRow = { id: 1, t0: wide.t0, t1: wide.t1, t2: wide.t2, n: wide.n }
				return [
					{ op: "insert", parents: [wide], children: held ? [child] : [] },
					{ op: "delete", parents: beside ? [unlike, wide] : [unlike] }
				]
			}
		})
		for (let left = source.draw(int(0, 3)); left > 0; left -= 1) {
			const op = source.draw(element(["insert", "put", "delete"] as const))
			const parents = nonEmpty(source.draw(array(element(pool), { min: 1, max: 3 })))
			writes.push(
				op === "insert"
					? {
							op,
							parents,
							children: source.draw(
								array(childGen(pool, source.draw(int(1, 3))), { min: 0, max: 2 })
							)
						}
					: { op, parents }
			)
		}
		return { shape, salt, writes }
	}

const caseGen: Gen<KeyCase> = caseWith(Option.none())

/** The situations a witness aims at, each with its aim. */
const aims: ReadonlyArray<readonly [Situation, Aim]> = [
	[
		"a primary key of 1 fields, its texts in their declared order",
		{ kind: "key", arity: 1, inOrder: true }
	],
	[
		"a primary key of 2 fields, its texts in their declared order",
		{ kind: "key", arity: 2, inOrder: true }
	],
	[
		"a primary key of 2 fields, its texts out of their declared order",
		{ kind: "key", arity: 2, inOrder: false }
	],
	[
		"a primary key of 3 fields, its texts out of their declared order",
		{ kind: "key", arity: 3, inOrder: false }
	],
	[
		"a primary key of 4 fields, its texts out of their declared order",
		{ kind: "key", arity: 4, inOrder: false }
	],
	["a key refused past the item limit", { kind: "edge", edge: "past the limit" }],
	["a key at the item limit accepted", { kind: "edge", edge: "at the limit" }],
	[
		"a delete of a row unlike the stored one at its key, which keeps it",
		{ kind: "delete", beside: false, held: false }
	],
	[
		"a delete of two rows at one key, which is no refusal",
		{ kind: "delete", beside: true, held: false }
	],
	["a delete refused on the containment", { kind: "delete", beside: true, held: true }]
]

/** The case a witness runs: its drawn one, or, while an aimed situation is pending, a case aimed at one of them. */
const aimedCase = (drawnCase: KeyCase, c: Case<Situation>): KeyCase => {
	const pending = Option.getOrUndefined(c.steering)
	const open = Arr.filter(aims, ([situation]) => pending?.has(situation) === true)
	return Arr.isReadonlyArrayNonEmpty(open)
		? c.draw(caseWith(Option.some(c.draw(element(open))[1])))
		: drawnCase
}

/** A row's values at `fields`. */
/** A row as a record of its values by field. */
type Values = Readonly<Record<string, string | number>>

const at = (
	row: Values,
	fields: ReadonlyArray<string>
): ReadonlyArray<string | number | undefined> => Arr.map(fields, (f) => row[f])

/** A row's value at a field it holds. */
const valueAt = (row: Values, f: string): string | number => defined(row[f], `the field ${f}`)

/** Whether two rows agree at `fields`. */
const agreeAt = (a: Values, b: Values, fields: ReadonlyArray<string>) =>
	deepEquals(at(a, fields), at(b, fields))

/** A law a write breaks, by its role in the shape. */
type Broken = "the primary key" | "the declared key" | "the child key" | "the containment"

/** What a write does by the set model: written, leaving the rows, changed or not; or refused on the laws it breaks. */
type Verdict =
	| {
			readonly kind: "written"
			readonly parents: ReadonlyArray<ParentRow>
			readonly children: ReadonlyArray<ChildRow>
			readonly changed: boolean
			readonly added: { readonly Parent: number; readonly Child: number }
	  }
	| {
			readonly kind: "refused"
			readonly broken: ReadonlySet<Broken>
			readonly stated: ReadonlyArray<{
				readonly broken: Broken
				readonly row: ParentRow | ChildRow
			}>
	  }

/** The rows of `rows` once, identical rows being one. */
const once = <A>(rows: ReadonlyArray<A>): ReadonlyArray<A> => Arr.dedupeWith(rows, deepEquals)

/** Each stated row sharing a key with another stated or stored row and differing from it, with that key's law. */
const clashes = <A extends ParentRow | ChildRow>(
	stated: ReadonlyArray<A>,
	against: ReadonlyArray<A>,
	keys: ReadonlyArray<readonly [Broken, ReadonlyArray<string>]>
) =>
	Arr.flatMap(stated, (row) =>
		Arr.flatMap(keys, ([broken, fields]) =>
			Arr.some(against, (other) => agreeAt(row, other, fields) && !deepEquals(row, other))
				? [{ broken, row }]
				: []
		)
	)

/** The set model's verdict on a write from the stored rows (see the header). */
const verdictOf = (
	s: Shape,
	parents: ReadonlyArray<ParentRow>,
	children: ReadonlyArray<ChildRow>,
	w: Write
): Verdict => {
	const parentKeys: ReadonlyArray<readonly [Broken, ReadonlyArray<string>]> = [
		["the primary key", s.key],
		["the declared key", s.unique]
	]
	const stated = once(w.parents)
	const added = w.op === "delete" ? [] : stated
	const statedChildren = w.op === "insert" ? once(w.children) : []
	const clashed = [
		...clashes(added, added, parentKeys),
		...clashes(statedChildren, statedChildren, [["the child key", ["id"]]])
	]
	const next = (): {
		readonly parents: ReadonlyArray<ParentRow>
		readonly children: ReadonlyArray<ChildRow>
	} => {
		switch (w.op) {
			case "insert":
				return {
					parents: once([...parents, ...stated]),
					children: once([...children, ...statedChildren])
				}
			case "put":
				return {
					parents: [
						...Arr.filter(parents, (p) => !Arr.some(stated, (x) => agreeAt(p, x, s.key))),
						...stated
					],
					children
				}
			case "delete":
				return {
					parents: Arr.filter(parents, (p) => !Arr.some(stated, (x) => deepEquals(p, x))),
					children
				}
		}
	}
	const after = next()
	const keyed = [
		...clashed,
		...(w.op === "insert"
			? [
					...clashes(stated, parents, parentKeys),
					...clashes(statedChildren, children, [["the child key", ["id"]]])
				]
			: w.op === "put"
				? clashes(stated, after.parents, [["the declared key", s.unique]])
				: [])
	]
	const contained = Arr.every(after.children, (c) =>
		Arr.some(after.parents, (p) => agreeAt(c, p, s.key))
	)
	const broken = new Set<Broken>([
		...Arr.map(keyed, (k) => k.broken),
		...(contained ? [] : ["the containment" as const])
	])
	if (broken.size > 0) {
		return { kind: "refused", broken, stated: keyed }
	}
	const addedParents = Arr.filter(after.parents, (p) => !Arr.some(parents, (q) => deepEquals(p, q)))
	const addedChildren = Arr.filter(
		after.children,
		(c) => !Arr.some(children, (d) => deepEquals(c, d))
	)
	return {
		kind: "written",
		parents: after.parents,
		children: after.children,
		changed:
			Arr.isReadonlyArrayNonEmpty(addedParents) ||
			Arr.isReadonlyArrayNonEmpty(addedChildren) ||
			after.parents.length !== parents.length,
		added: {
			Parent: w.op === "insert" ? addedParents.length : 0,
			Child: addedChildren.length
		}
	}
}

/** The columns PostgreSQL lays a key's entry out over, as raw DDL spells them. */
const columnSql = (f: string): string =>
	f === "n" || f === "payload" ? "integer" : "text COLLATE pg_c_utf8"

/** A value as a raw insert binds it. */
const rawValue = (row: ParentRow, f: string): string => String(valueAt(row, f))

/**
 * Whether PostgreSQL itself refuses the widest entry of a unique index over `fields` (54000), in a table of those
 * columns in a scratch schema of the case's, its transaction rolled back.
 */
const refusesWidest = (fields: ReadonlyArray<string>, row: ParentRow) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const scratch = yield* s.schema({ create: false, label: "keywidth" })
		const session = yield* s.admin.pin
		const table = `${quoteIdent(scratch)}.${quoteIdent("t")}`
		const columns = Arr.map(fields, (f) => quoteIdent(f))
		const run = Effect.gen(function* () {
			yield* session.query("BEGIN", [])
			yield* session.query(`CREATE SCHEMA ${quoteIdent(scratch)}`, [])
			yield* session.query(
				`CREATE TABLE ${table} (${Arr.join(
					Arr.map(fields, (f, i) => `${defined(columns[i])} ${columnSql(f)} NOT NULL`),
					", "
				)})`,
				[]
			)
			yield* session.query(`CREATE UNIQUE INDEX ON ${table} (${Arr.join(columns, ", ")})`, [])
			yield* session.query(
				`INSERT INTO ${table} VALUES (${Arr.join(
					Arr.map(fields, (_, i) => `$${i + 1}`),
					", "
				)})`,
				Arr.map(fields, (f) => rawValue(row, f))
			)
		}).pipe(Effect.ensuring(Effect.ignore(session.query("ROLLBACK", []))))
		const outcome = yield* Effect.result(run)
		if (Result.isSuccess(outcome)) {
			return false
		}
		const code = pgErrorFields(outcome.failure)?.code
		return code === "54000"
			? true
			: assert.fail(
					`the widest entry over ${Formatter.format(fields)} failed otherwise: ${Formatter.format(outcome.failure)}`
				)
	}).pipe(Effect.scoped)

/** Whether a primary key's texts stand in their declared order, t0 before t1 before t2. */
const textsInOrder = (key: ReadonlyArray<KeyField>): boolean => {
	const places = Arr.flatMap(key, (f) => (f === "n" ? [] : [TEXTS.indexOf(f)]))
	return Arr.every(places, (p, i) => i === 0 || (places[i - 1] ?? p) < p)
}

/** A Parent row as a fact and a stored row hold it. */
const parentFact = (row: ParentRow): StateRow => ({
	t0: row.t0,
	t1: row.t1,
	t2: row.t2,
	n: row.n,
	payload: row.payload
})

/** A Child row as a fact and a stored row hold it: its id and the key it names, at its own fields. */
const childFact = (s: Shape, row: ChildRow): StateRow =>
	Rec.fromEntries([
		["id", row.id] as const,
		...Arr.map(s.key, (f) => [childField(f), valueAt(row, f)] as const)
	])

/** The unique indexes of a table, each its columns in index order, and whether it is the primary key's. */
const uniqueIndexes = (schemaName: string, table: string) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const rows = yield* s.admin.queryValues(
			"SELECT i.indexrelid::text, i.indisprimary, k.ord::int4, a.attname::text " +
				"FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class AS c ON c.oid = i.indrelid " +
				"JOIN pg_catalog.pg_namespace AS ns ON ns.oid = c.relnamespace " +
				"CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) " +
				"JOIN pg_catalog.pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = k.attnum " +
				"WHERE ns.nspname = $1 AND c.relname = $2 AND i.indisunique ORDER BY 1, 3",
			[schemaName, table]
		)
		const byIndex = Arr.groupBy(rows, (r) => String(r[0]))
		return Arr.map(Rec.values(byIndex), (cols) => ({
			primary: Arr.headNonEmpty(cols)[1] === true,
			columns: Arr.map(cols, (r) => String(r[3]))
		}))
	})

/** The foreign keys of a table into another, each its (referencing, referenced) column pairs in constraint order. */
const foreignKeys = (schemaName: string, from: string, to: string) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const rows = yield* s.admin.queryValues(
			"SELECT con.oid::text, k.ord::int4, a.attname::text, fa.attname::text " +
				"FROM pg_catalog.pg_constraint AS con JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid " +
				"JOIN pg_catalog.pg_class AS fc ON fc.oid = con.confrelid " +
				"JOIN pg_catalog.pg_namespace AS ns ON ns.oid = c.relnamespace " +
				"CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, fattnum, ord) " +
				"JOIN pg_catalog.pg_attribute AS a ON a.attrelid = con.conrelid AND a.attnum = k.attnum " +
				"JOIN pg_catalog.pg_attribute AS fa ON fa.attrelid = con.confrelid AND fa.attnum = k.fattnum " +
				"WHERE con.contype = 'f' AND ns.nspname = $1 AND c.relname = $2 AND fc.relname = $3 ORDER BY 1, 2",
			[schemaName, from, to]
		)
		return Arr.map(Rec.values(Arr.groupBy(rows, (r) => String(r[0]))), (cols) =>
			Arr.map(cols, (r) => [String(r[2]), String(r[3])] as const)
		)
	})

layer(Substrate.layer, { excludeTestServices: true })("compound text keys", (it) => {
	it.effect(
		"are installed in their declared order or refused as UnrepresentableKey exactly where PostgreSQL refuses their widest entry, and their writes and reads keep the set rule through the keys' indexes",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/write/compound-key",
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
							kind: "postgresql",
							name: "PostgreSQL's B-tree item limit (54000) and its catalog and plans, beside the set model of each write"
						}
					},
					(drawnCase, c) =>
						Effect.gen(function* () {
							const k = aimedCase(drawnCase, c)
							const s = k.shape
							const b = built(s)
							const widestRow = widest(s, k.salt)
							const declared = b.rename("Keyed")
							const field = (f: string) => defined(b.Parent.fields[f], "a Parent field")
							/**
							 * The case's members over `over`, the declared schema or the installed one, which a level's content
							 * makes one: its writes, and its reads by the key, the declared key and the child's id.
							 */
							const programsOver = (over: typeof declared) => ({
								insert: ChangeSet.empty(over).insert(b.Parent, []).insert(b.Child, []),
								put: ChangeSet.empty(over).put(b.Parent, []),
								delete: ChangeSet.empty(over).delete(b.Parent, []),
								byKey: query(over).rule((r) => {
									const p = v(b.Parent, "p")
									const bound = Rec.fromEntries(
										Arr.map(Rec.keys(b.Parent.fields), (f) =>
											Arr.some(s.key, (x) => x === f)
												? ([f, r.param(`k_${f}`, field(f))] as const)
												: ([f, defined(p[f], "a variable")] as const)
										)
									)
									return r.match(b.Parent, bound).find(bound)
								}),
								byUnique: query(over).rule((r) => {
									const p = v(b.Parent, "p")
									const bound = Rec.fromEntries(
										Arr.map(Rec.keys(b.Parent.fields), (f) =>
											Arr.some(s.unique, (x) => x === f)
												? ([f, r.param(`u_${f}`, field(f))] as const)
												: ([f, defined(p[f], "a variable")] as const)
										)
									)
									return r.match(b.Parent, bound).find(bound)
								}),
								childParent: query(over).rule((r) => {
									const ch = v(b.Child, "c")
									const p = v(b.Parent, "p")
									const joined = Rec.fromEntries(
										Arr.map(Rec.keys(b.Parent.fields), (f) => {
											const keyed = Arr.findFirst(s.key, (x) => x === f)
											return [
												f,
												Option.isSome(keyed)
													? defined(ch[childField(keyed.value)], "a child variable")
													: defined(p[f], "a parent variable")
											] as const
										})
									)
									return r
										.match(b.Child, ch)
										.match(b.Parent, joined)
										.where(r.eq(defined(ch["id"], "the child id"), r.param("id", pg.int4)))
										.find(joined)
								})
							})
							const declaredWorld = fullWorld(declared, {})
							const installedOrNot = yield* Effect.result(
								installMigrated(declared, {
									ambient: ordinarySession,
									label: "keyed",
									logins: [declaredWorld.server],
									extensions: [
										paramsOver([
											{
												login: "server",
												workloads: [workload(declaredWorld.app, programsOver(declared))]
											}
										])
									]
								})
							)
							if (Result.isFailure(installedOrNot)) {
								const e = installedOrNot.failure
								if (!isCompileError(e) || e.reason._tag !== "UnrepresentableKey") {
									return assert.fail(
										`a schema whose keys are refused is refused as UnrepresentableKey, not ${Formatter.format(e)}`
									)
								}
								const reason = e.reason
								const fault = reason.fault
								if (fault.kind !== "btreeEntry") {
									return assert.fail(
										`a byte-bounded key is refused by its entry's bytes, not ${Formatter.format(fault)}`
									)
								}
								assert.ok(
									fault.bytes > fault.limit && fault.limit === btreeMaxItemSize.value,
									`the refusal counts the entry past BTMaxItemSize: ${Formatter.format(fault)}`
								)
								assert.ok(
									deepEquals<ReadonlyArray<string>>(reason.key, s.key) ||
										deepEquals<ReadonlyArray<string>>(reason.key, s.unique),
									`the refusal names a key of Parent in its declared order, not ${Formatter.format(reason.key)}`
								)
								const refused = yield* refusesWidest(reason.key, widestRow)
								c.note("a key refused past the item limit")
								c.note(
									refused
										? "a refused key whose widest entry PostgreSQL refuses too"
										: "a refused key whose widest entry PostgreSQL holds"
								)
								return
							}
							const done = installedOrNot.success
							for (const fields of [s.key, s.unique]) {
								const refused = yield* refusesWidest(fields, widestRow)
								assert.ok(
									!refused,
									`grizzle installs ${Formatter.format(fields)}, whose widest entry PostgreSQL refuses`
								)
							}
							if (
								Option.exists(layoutBytes(s, s.key), (bytes) => bytes > btreeMaxItemSize.value - 8)
							) {
								c.note("a key at the item limit accepted")
							}
							const names = namesOf(done)
							const parentTable = done.names.relation(b.Parent.name)
							const childTable = done.names.relation(b.Child.name)
							const column = (r: string, f: string) => done.names.column(r, f)
							const indexes = yield* uniqueIndexes(parentTable.schema, parentTable.name)
							assert.ok(
								Arr.some(
									indexes,
									(i) =>
										i.primary &&
										deepEquals(
											i.columns,
											Arr.map(s.key, (f) => column(b.Parent.name, f))
										)
								),
								`Parent's primary key is planned over ${Formatter.format(s.key)} in that order: ${Formatter.format(indexes)}`
							)
							assert.ok(
								Arr.some(indexes, (i) =>
									deepEquals(
										i.columns,
										Arr.map(s.unique, (f) => column(b.Parent.name, f))
									)
								),
								`Parent's declared key is planned over ${Formatter.format(s.unique)} in that order: ${Formatter.format(indexes)}`
							)
							const fks = yield* foreignKeys(parentTable.schema, childTable.name, parentTable.name)
							assert.ok(
								Arr.some(fks, (pairs) =>
									deepEquals(
										pairs,
										Arr.map(
											s.target,
											(f) =>
												[column(b.Child.name, childField(f)), column(b.Parent.name, f)] as const
										)
									)
								),
								`the containment is one foreign key pairing ${Formatter.format(s.target)} in that order: ${Formatter.format(fks)}`
							)
							const value = b.rename(done.schema)
							const world = fullWorld(value, {})
							const lawNames = lawNamesOf(value)
							const lawOf: { readonly [B in Broken]: LawId } = {
								"the primary key": lawNames.primaryKeyLaw({ name: b.Parent.name }),
								"the declared key": lawNames.lawOf(b.declaredKey),
								"the child key": lawNames.primaryKeyLaw({ name: b.Child.name }),
								"the containment": lawNames.lawOf(b.containment)
							}
							const keyFieldsOf: { readonly [B in Broken]: ReadonlyArray<string> } = {
								"the primary key": s.key,
								"the declared key": s.unique,
								"the child key": ["id"],
								"the containment": []
							}
							const programs = programsOver(value)
							yield* Effect.gen(function* () {
								const db = yield* openServedDb(done, world.server.roles.app, {})
								const loaded = yield* db.load(programs)
								const applied = (name: Write["op"], facts: CallFacts) =>
									answered(
										writeOnce(onceCalls(db.ctx, member(loaded, name)))({ params: {}, facts })
									)
								let parents: ReadonlyArray<ParentRow> = []
								let children: ReadonlyArray<ChildRow> = []
								for (const [i, w] of k.writes.entries()) {
									const label = `write ${String(i)} (${w.op}) over ${Formatter.format(s)}`
									const verdict = verdictOf(s, parents, children, w)
									const facts: CallFacts =
										w.op === "insert"
											? {
													insert: {
														Parent: Arr.map(w.parents, parentFact),
														Child: Arr.map(w.children, (x) => childFact(s, x))
													}
												}
											: { [w.op]: { Parent: Arr.map(w.parents, parentFact) } }
									const outcome: WriteAnswer<WrittenOutcome> = yield* applied(w.op, facts)
									if (verdict.kind === "refused") {
										judgeRefused(label, outcome, verdict, lawOf, keyFieldsOf, names.reported, s)
										for (const broken of verdict.broken) {
											if (broken !== "the child key") {
												c.note(`${opLabels[w.op]} refused on ${broken}`)
											}
										}
									} else {
										assert.equal(outcome.kind, verdict.changed ? "accepted" : "unchanged", label)
										if (outcome.kind === "accepted" && w.op === "insert") {
											for (const [r, n] of Rec.toEntries(verdict.added)) {
												const counted = Arr.findFirst(outcome.counts, (x) => x.relation === r)
												assert.equal(
													Option.getOrUndefined(counted)?.added ?? 0n,
													BigInt(n),
													`${label}: ${r}'s added rows`
												)
											}
										}
										if (i === 0 && Arr.some(verdict.parents, (p) => deepEquals(p, widestRow))) {
											c.note("a write of the widest values accepted")
										}
										if (
											w.op === "delete" &&
											Arr.some(verdict.parents, (p) =>
												Arr.some(w.parents, (x) => agreeAt(p, x, s.key) && !deepEquals(p, x))
											)
										) {
											c.note("a delete of a row unlike the stored one at its key, which keeps it")
										}
										if (
											w.op === "delete" &&
											Arr.some(w.parents, (x) =>
												Arr.some(w.parents, (y) => agreeAt(x, y, s.key) && !deepEquals(x, y))
											)
										) {
											c.note("a delete of two rows at one key, which is no refusal")
										}
										parents = verdict.parents
										children = verdict.children
									}
									const storedParents = yield* tableState(done, b.Parent)
									unorderedEqual(
										storedParents,
										Arr.map(parents, parentFact),
										`Parent's rows after ${label}`
									)
									const storedChildren = yield* tableState(done, b.Child)
									unorderedEqual(
										storedChildren,
										Arr.map(children, (x) => childFact(s, x)),
										`Child's rows after ${label}`
									)
								}
								const sub = yield* Substrate
								yield* unanalyzed(sub.admin, [parentTable, childTable])
								const planned = plannedIndexes(done.installation)
								const { calls, counts } = recordingMembers(db.ctx)
								const read = (name: string, params: ParamMap) =>
									Effect.gen(function* () {
										const before = counts.sent.length
										const collected = yield* readOnce(calls(member(loaded, name)))({
											params,
											facts: {}
										})
										const rows = Arr.map(collected, (row) => ({ ...rowOf(row) }))
										const problems = yield* sentProblems(
											sub.admin,
											name,
											counts.sent.slice(before),
											planned
										)
										assert.deepEqual(problems, [], `${name} reads through the keys' indexes`)
										return rows
									})
								for (const p of [...parents, widestRow]) {
									const got = yield* read(
										"byKey",
										Rec.fromEntries(Arr.map(s.key, (f) => [`k_${f}`, valueAt(p, f)] as const))
									)
									unorderedEqual(
										got,
										Arr.map(
											Arr.filter(parents, (q) => agreeAt(q, p, s.key)),
											parentFact
										),
										`the Parent at ${Formatter.format(at(p, s.key))}`
									)
									const byUnique = yield* read(
										"byUnique",
										Rec.fromEntries(Arr.map(s.unique, (f) => [`u_${f}`, valueAt(p, f)] as const))
									)
									unorderedEqual(
										byUnique,
										Arr.map(
											Arr.filter(parents, (q) => agreeAt(q, p, s.unique)),
											parentFact
										),
										`the Parent at the declared key ${Formatter.format(at(p, s.unique))}`
									)
								}
								for (const ch of children) {
									const got = yield* read("childParent", { id: ch.id })
									unorderedEqual(
										got,
										Arr.map(
											Arr.filter(parents, (q) => agreeAt(q, ch, s.key)),
											parentFact
										),
										`the Parent of Child ${String(ch.id)}`
									)
								}
								c.note(
									`a primary key of ${arityOf(s.key)} fields, its texts ${textsInOrder(s.key) ? "in" : "out of"} their declared order`
								)
								if (!deepEquals<ReadonlyArray<KeyField>>(s.target, s.key)) {
									c.note("a containment out of the key's order")
								}
							}).pipe(Effect.scoped)
						}).pipe(Effect.scoped)
				)
			)
	)
})

/**
 * A refusal judged against the set model: refused, naming only laws the write breaks; a key's refusal
 * witnessed by that key's values, at its fields, of a row the write states that breaks it, and a containment's alone
 * `unreported`.
 */
const judgeRefused = (
	label: string,
	outcome: WriteAnswer<WrittenOutcome>,
	v: Extract<Verdict, { readonly kind: "refused" }>,
	lawOf: { readonly [B in Broken]: LawId },
	keyFieldsOf: { readonly [B in Broken]: ReadonlyArray<string> },
	reported: ReturnType<typeof namesOf>["reported"],
	s: Shape
): void => {
	if (outcome.kind !== "refused") {
		return assert.fail(
			`${label}: it breaks ${Formatter.format([...v.broken])}, so it is refused, not ${outcome.kind}`
		)
	}
	const allowed = new Set(Arr.map([...v.broken], (x) => lawOf[x]))
	const named = Arr.map(outcome.refused.laws, reported)
	assert.equal(
		outcome.refused.kind,
		"every",
		`${label}: a key's or a containment's refusal decides its one law`
	)
	for (const law of named) {
		assert.ok(
			allowed.has(law),
			`${label}: the refusal names ${law}, which the write does not break: ${Formatter.format([...v.broken])}`
		)
	}
	const witness = outcome.witness
	const keyNamed = Arr.filter(v.stated, (x) => named.includes(lawOf[x.broken]))
	if (!Arr.isReadonlyArrayNonEmpty(keyNamed)) {
		assert.equal(witness.kind, "unreported", `${label}: a containment's refusal reports no key`)
		return
	}
	if (witness.kind === "unreported") {
		return assert.fail(
			`${label}: the refusal of a key the write's own rows break reports no witness: ${Formatter.format(keyNamed)}`
		)
	}
	const valuesAt = (row: ParentRow | ChildRow, fields: ReadonlyArray<string>) =>
		Rec.fromEntries(Arr.map(fields, (f) => [f, valueAt(row, f)] as const))
	assert.ok(
		Arr.some(
			keyNamed,
			(x) =>
				witness.relation === (x.broken === "the child key" ? "Child" : "Parent") &&
				Arr.some([keyFieldsOf[x.broken], x.broken === "the child key" ? ["id"] : s.key], (fields) =>
					deepEquals<unknown>(witness.values, valuesAt(x.row, fields))
				)
		),
		`${label}: the witness ${Formatter.format(witness)} is the key a stated row breaks, at the fields of a key the refusal names (${Formatter.format(s.key)} or ${Formatter.format(s.unique)})`
	)
}
