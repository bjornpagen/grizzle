/** What the properties of superkey-orders.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int, shuffled, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order } from "effect"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import {
	contained,
	eq,
	f,
	field as fieldRef,
	key,
	literal,
	on,
	onWhere,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { type Catalogued, seatOf } from "#test/support/pg/fin/installed.ts"
import { attempt } from "#test/support/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/** T's fields beyond its key `k`, which a reference's columns draw from. */
const others = ["a", "b", "c"] as const

type Other = (typeof others)[number]

type Column = "k" | Other

/** T's columns in its declared order. */
const columnsInOrder: Arr.NonEmptyReadonlyArray<Column> = ["k", ...others]

/** The value every row of T holds in each field beyond its key, and the literal every fixed target fixes. */
const held = 7

/**
 * A reference into T: a superkey reference, its columns `k` and some of the other fields in `order`; or a fixed target,
 * `fixed` fixed by the literal and `order` its terms, `k` among them.
 */
type Reference =
	| { readonly kind: "superkey"; readonly order: Arr.NonEmptyReadonlyArray<Column> }
	| {
			readonly kind: "fixed"
			readonly order: Arr.NonEmptyReadonlyArray<Column>
			readonly fixed: Other
	  }

/** The columns of T a reference names, in its order: a fixed target's terms, then its fixed field. */
const columnsOf = (r: Reference): Arr.NonEmptyReadonlyArray<Column> =>
	r.kind === "superkey" ? r.order : Arr.append(r.order, r.fixed)

/**
 * The columns of T a fixed target's own UNIQUE holds, a side over its selection (README "Sides"): its guarded term, the
 * one over T's earliest field, its primary key `k` first and every other field after it in declared order
 * (columnsInOrder), generated under its selection, as the seat names a column generated from a field
 * (test/support/pg/fin/installed.ts), and each other term its field's own column. One guarded column holds the side apart:
 * UNIQUE NULLS DISTINCT and MATCH SIMPLE pass over a row whose guarded column is NULL, a row outside the selection.
 */
const ownColumnsOf = (r: Extract<Reference, { readonly kind: "fixed" }>): ReadonlyArray<string> => {
	const rank = (c: Column): number => columnsInOrder.indexOf(c)
	const guarded = Arr.reduce(Arr.tailNonEmpty(r.order), Arr.headNonEmpty(r.order), (held, c) =>
		rank(c) < rank(held) ? c : held
	)
	return Arr.map(r.order, (c) => (c === guarded ? `‹gen ${c}›` : c))
}

/** A column set as one text, its columns in code-unit order. */
const setText = (columns: ReadonlyArray<string>): string =>
	Arr.join(Arr.sort(columns, Order.String), ",")

/**
 * A reference: its first field beyond the key and the rest of its set in any order, `k` at any place among its columns;
 * a fixed target fixes the first field, its terms the rest and `k`.
 */
const referenceOver =
	(kind: Reference["kind"], set: Arr.NonEmptyReadonlyArray<Other>): Gen<Reference> =>
	(source) => {
		const first = source.draw(element(set))
		const rest = Arr.filter(set, (o) => o !== first)
		const shuffledRest = source.draw(shuffled(rest, { min: rest.length, max: rest.length }))
		const withKey = (columns: ReadonlyArray<Column>): Arr.NonEmptyReadonlyArray<Column> => {
			const at = source.draw(int(0, columns.length))
			return Arr.appendAll(Arr.append(columns.slice(0, at), "k"), columns.slice(at))
		}
		return kind === "fixed"
			? { kind: "fixed", order: withKey(shuffledRest), fixed: first }
			: { kind: "superkey", order: withKey([first, ...shuffledRest]) }
	}

/** A reference of `kind` over `k` and one to all of T's other fields. */
const referenceOf =
	(kind: Reference["kind"]): Gen<Reference> =>
	(source) => {
		const first = source.draw(element(others))
		const more = source.draw(
			subset(
				Arr.filter(others, (o) => o !== first),
				{ min: 0, max: others.length - 1 }
			)
		)
		return source.draw(referenceOver(kind, Arr.prepend(more, first)))
	}

const referenceGen: Gen<Reference> = (source) =>
	source.draw(referenceOf(source.draw(boolean) ? "fixed" : "superkey"))

/** A key a statement declares on T beside its primary key `k`: some of T's columns, in any order. */
type Declared = Arr.NonEmptyReadonlyArray<Column>

const declaredGen: Gen<Declared> = (source) => {
	const first = source.draw(element(columnsInOrder))
	const more = source.draw(
		subset(
			Arr.filter(columnsInOrder, (c) => c !== first),
			{ min: 0, max: columnsInOrder.length - 1 }
		)
	)
	return Arr.prepend(source.draw(shuffled(more, { min: more.length, max: more.length })), first)
}

/** A case's draw: T's declared keys and the references into it. */
interface Drawn {
	readonly keys: ReadonlyArray<Declared>
	readonly refs: ReadonlyArray<Reference>
}

export const drawnGen: Gen<Drawn> = (source) => ({
	keys: source.draw(array(declaredGen, { min: 0, max: 2 })),
	refs: source.draw(array(referenceGen, { min: 2, max: 4 }))
})

export type Feature =
	| "two references over one set in two orders"
	| "a fixed target and a superkey reference over one set"
	| "references over two sets"
	| "a declared key and a reference over one set"
	| "a fixed target referenced at its own columns"
	| "a declared key over the set of another key of T refused"
	| "a source row meeting T committed"
	| "a source row naming no row of T refused by its own foreign key"

/** T's keys a statement states, its primary key first: the declared keys, each distinct order once, as a schema's
 * statements declared twice identically are one (schema/own.ts). */
const keysOf = (keys: ReadonlyArray<Declared>): ReadonlyArray<ReadonlyArray<Column>> => [
	["k"],
	...Arr.dedupeWith(keys, (x, y) => Arr.join(x, ",") === Arr.join(y, ","))
]

/** Whether two of T's keys are over one column set, which the schema refuses. */
const clashes = (keys: ReadonlyArray<Declared>): boolean => {
	const sets = Arr.map(keysOf(keys), setText)
	return Arr.dedupe(sets).length < sets.length
}

/** What a case's references hold, from the sketch alone. */
const referenceNotes = (refs: ReadonlyArray<Reference>): ReadonlyArray<Feature> => {
	const pairs = Arr.flatMap(refs, (r, i) => Arr.map(refs.slice(i + 1), (s) => [r, s] as const))
	const sameSet = (r: Reference, s: Reference) => setText(columnsOf(r)) === setText(columnsOf(s))
	return [
		...(Arr.some(
			pairs,
			([r, s]) => sameSet(r, s) && Arr.join(columnsOf(r), ",") !== Arr.join(columnsOf(s), ",")
		)
			? ["two references over one set in two orders" as const]
			: []),
		...(Arr.some(pairs, ([r, s]) => sameSet(r, s) && r.kind !== s.kind)
			? ["a fixed target and a superkey reference over one set" as const]
			: []),
		...(Arr.some(pairs, ([r, s]) => !sameSet(r, s)) ? ["references over two sets" as const] : [])
	]
}

/** What a case holds, from the sketch alone. */
const notesOf = (d: Drawn): ReadonlyArray<Feature> =>
	clashes(d.keys)
		? ["a declared key over the set of another key of T refused"]
		: [
				...referenceNotes(d.refs),
				...(Arr.some(d.keys, (k) => Arr.some(d.refs, (r) => setText(k) === setText(columnsOf(r))))
					? ["a declared key and a reference over one set" as const]
					: [])
			]

/** A superkey reference over the columns of `r`, in any order. */
const superkeyOver =
	(r: Reference): Gen<Reference> =>
	(source) => {
		const columns = columnsOf(r)
		const head = source.draw(element(columns))
		const tail = Arr.filter(columns, (c) => c !== head)
		return {
			kind: "superkey",
			order: Arr.prepend(source.draw(shuffled(tail, { min: tail.length, max: tail.length })), head)
		}
	}

/** Two references over one set in two orders, the first one `kind`. */
const sameSetGen =
	(kind: Reference["kind"]): Gen<Drawn> =>
	(source) => {
		const r = source.draw(referenceOf(kind))
		return { keys: [], refs: [r, source.draw(superkeyOver(r))] }
	}

/** A declared key over the columns of a superkey reference, in another order the reference draws. */
const declaredBesideGen: Gen<Drawn> = (source) => {
	const r = source.draw(referenceOf("superkey"))
	return { keys: [columnsOf(r)], refs: [source.draw(superkeyOver(r))] }
}

/**
 * Two fixed targets over T's key alone under one selection, each from its own source: the shared UNIQUE adds its index
 * and a constant on each source, the own one its index and one generated column (laws/model/plan.ts).
 */
const sameTargetGen: Gen<Drawn> = (source) => {
	const r: Reference = { kind: "fixed", order: ["k"], fixed: source.draw(element(others)) }
	return { keys: [], refs: [r, r] }
}

/** A declared key over T's primary key's set, or two declared keys over one set of two columns in both orders. */
const clashGen: Gen<Drawn> = (source) => {
	const first = source.draw(element(others))
	const primary: Column = "k"
	const rest: Arr.NonEmptyReadonlyArray<Column> = Arr.prepend(
		Arr.filter(others, (c) => c !== first),
		primary
	)
	const second = source.draw(element(rest))
	return {
		keys: source.draw(boolean)
			? [["k"]]
			: [
					[first, second],
					[second, first]
				],
		refs: []
	}
}

/** What each required situation is aimed at while it is pending, drawn beside a drawn case (besideDrawn). */
const aimsAt: ReadonlyArray<readonly [Feature, Gen<Drawn>]> = [
	["two references over one set in two orders", sameSetGen("superkey")],
	["a fixed target and a superkey reference over one set", sameSetGen("fixed")],
	[
		"references over two sets",
		() => ({
			keys: [],
			refs: [
				{ kind: "superkey", order: ["k", "a"] },
				{ kind: "superkey", order: ["b", "k"] }
			]
		})
	],
	["a declared key and a reference over one set", declaredBesideGen],
	["a fixed target referenced at its own columns", sameTargetGen],
	["a declared key over the set of another key of T refused", clashGen]
]

/** A drawn case with what `aim` draws beside it: both one's keys and references. */
const besideDrawn =
	(aim: Gen<Drawn>): Gen<Drawn> =>
	(source) => {
		const d = source.draw(drawnGen)
		const more = source.draw(aim)
		return { keys: [...d.keys, ...more.keys], refs: [...d.refs, ...more.refs] }
	}

/**
 * Each required situation `aimsAt` names, with the case a witness whose turn aims at it draws (aimed): a drawn case
 * with what is aimed at the situation beside it.
 */
export const aims: ReadonlyArray<readonly [Feature, Gen<Drawn>]> = Arr.map(
	aimsAt,
	([feature, aim]) => [feature, besideDrawn(aim)] as const
)

/** The source relation of reference `i`: its key `id`, and a field for each of T's columns. */
const sourceName = (i: number): string => `S${i}`

const sourceField = (c: Column): string => `x${c}`

/** Reference `r`'s containment from source `i`'s fields into T. */
const containmentOf = (r: Reference, i: number) =>
	r.kind === "superkey"
		? contained(on(sourceName(i), Arr.map(r.order, sourceField)), on("T", r.order))
		: contained(
				on(sourceName(i), Arr.map(r.order, sourceField)),
				onWhere("T", r.order, eq(fieldRef(r.fixed), literal(held)))
			)

/** T and `sources` source relations, with `statements`. */
const schemaWith = (sources: number, statements: SchemaDesc["statements"]): SchemaDesc => ({
	name: "SuperkeyOrders",
	relations: [
		relation("T", { k: f.integer, a: f.integer, b: f.integer, c: f.integer }, ["k"]),
		...upTo(sources, (i) =>
			relation(
				sourceName(i),
				{ id: f.integer, xk: f.integer, xa: f.integer, xb: f.integer, xc: f.integer },
				["id"]
			)
		)
	],
	statements,
	bases: []
})

/** The schema of a case: T with its declared keys, and each reference's source, with the reference's containment. */
const schemaOf = (d: Drawn): SchemaDesc =>
	schemaWith(d.refs.length, [
		...Arr.map(d.keys, (k) => key(on("T", k))),
		...Arr.map(d.refs, containmentOf)
	])

/** The unique and primary constraints of T, and the foreign keys into it. */
const keysOfT = (constraints: ReadonlyArray<Catalogued>): ReadonlyArray<Catalogued> =>
	Arr.filter(
		constraints,
		(c) => c.relation === "T" && (c.kind === "unique" || c.kind === "primary")
	)

export const referencesCase = (d: Drawn, note: (feature: Feature) => void) =>
	Effect.gen(function* () {
		for (const feature of notesOf(d)) {
			note(feature)
		}
		const refs = d.refs
		const compiled = testArtifacts(schemaOf(d), testCompile)
		if (clashes(d.keys)) {
			assert.ok(
				!compiled.ok && compiled.error.reason._tag === "MalformedDescription",
				`two keys of T over one column set are refused MalformedDescription, not ${compiled.ok ? "admitted" : compiled.error.message}`
			)
			return
		}
		assert.ok(
			compiled.ok,
			`T's keys over distinct column sets compile, not ${compiled.ok ? "" : compiled.error.message}`
		)
		const relations: Arr.NonEmptyReadonlyArray<string> = [
			"T",
			...Arr.map(refs, (_, i) => sourceName(i))
		]
		const seat = yield* seatOf(schemaOf(d), relations, "superkey orders")
		const keys = keysOfT(seat.constraints)
		const sets = Arr.map(keys, (c) => setText(c.columns))
		const landings = Arr.map(refs, (r, i) => {
			const into = Arr.filter(
				seat.constraints,
				(c) =>
					c.kind === "foreign" &&
					c.relation === sourceName(i) &&
					Option.exists(c.target, (t) => t.relation === "T")
			)
			const [fk, ...more] = into
			if (fk === undefined || more.length > 0) {
				return assert.fail(`${sourceName(i)} holds one foreign key into T, not ${into.length}`)
			}
			const landing = Option.match(fk.target, {
				onNone: () => "",
				onSome: (t) => setText(t.columns)
			})
			const allowed =
				r.kind === "superkey"
					? [setText(columnsOf(r))]
					: [setText(columnsOf(r)), setText(ownColumnsOf(r))]
			assert.ok(
				Arr.contains(allowed, landing),
				`${sourceName(i)}'s foreign key lands on ${Arr.join(allowed, " or ")}, not ${landing}`
			)
			if (r.kind === "fixed" && landing === setText(ownColumnsOf(r))) {
				note("a fixed target referenced at its own columns")
			}
			return landing
		})
		const expected = Arr.dedupe([...Arr.map(keysOf(d.keys), setText), ...landings])
		assert.deepEqual(
			Arr.sort(sets, Order.String),
			Arr.sort(expected, Order.String),
			"T holds one unique index per column set: each declared key's and each a reference's foreign key lands on"
		)
		for (const fk of seat.constraints) {
			if (fk.kind !== "foreign" || Option.isNone(fk.target) || fk.target.value.relation !== "T") {
				continue
			}
			const referenced = setText(fk.target.value.columns)
			assert.equal(
				Arr.filter(sets, (s) => s === referenced).length,
				1,
				`${fk.name} lands on exactly one unique index over ${referenced}`
			)
		}
		const t = seat.table("T")
		const col = (r: string, c: string) => seat.column(r, c)
		const row = (r: string, id: number, key: number) =>
			`INSERT INTO ${seat.table(r)} (${col(r, "id")}, ${Arr.join(
				Arr.map(columnsInOrder, (c) => col(r, sourceField(c))),
				", "
			)}) VALUES (${id}, ${key}, ${held}, ${held}, ${held})`
		const meeting = yield* attempt(seat.session, [
			`INSERT INTO ${t} (${col("T", "k")}, ${col("T", "a")}, ${col("T", "b")}, ${col("T", "c")}) VALUES (1, ${held}, ${held}, ${held})`,
			...Arr.map(refs, (_, i) => row(sourceName(i), 1, 1))
		])
		assert.equal(
			meeting.kind,
			"committed",
			"a source row meeting T's row commits for every reference"
		)
		note("a source row meeting T committed")
		for (const [i] of refs.entries()) {
			const naming = yield* attempt(seat.session, [row(sourceName(i), 2, 2)])
			if (naming.kind !== "refused") {
				return assert.fail(`${sourceName(i)}'s row naming no row of T commits`)
			}
			const by = seat.refusedBy(naming.fields)
			assert.ok(
				naming.fields.code === "23503" &&
					Option.exists(by, (c) => c.kind === "foreign" && c.relation === sourceName(i)),
				`${sourceName(i)}'s row naming no row of T is refused by its own foreign key, not ${naming.fields.code} by ${Option.match(by, { onNone: () => "no constraint", onSome: (c) => c.name })}`
			)
		}
		note("a source row naming no row of T refused by its own foreign key")
	})
