/** What the properties of places.test.ts read: their schemas, their cases with their verdicts, and their features. */

import { int as between, element, type Gen, map } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { PlaceRule } from "#compiler/core/causes.ts"
import { drawn, instant, natural, type PlaceField, pg, place } from "#compiler/public/fields.ts"
import { param, query, v } from "#compiler/public/query.ts"
import {
	contained,
	fin,
	key,
	mutable,
	on,
	ordered,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { asDrafted, compile, installedStatements } from "#test/support/migrate/kit.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/support/unit/write/changeset/fixtures.ts"

/** A stage decision of a child, at its clock of child `child`. */
const Stage = relation("Stage", { child: pg.integer, at: instant }, ["child", "at"])
/** A child's session of an item, at its place `n` within the child's item, its stage a reference to Stage's clock. */
const Session = relation(
	"Session",
	{ child: pg.integer, item: pg.integer, n: place.by("stage"), stage: instant },
	["child", "item", "n"]
)
/** A child's turn at its place `n`, its moves its ordered family: an owner whose delete removes its moves with it. */
const Turn = relation(
	"Turn",
	{ child: pg.integer, n: place, x: pg.integer, moves: drawn(natural) },
	["child", "n"]
)
/** A move of a turn, at its place among the turn's moves. */
const Move = relation(
	"Move",
	{ child: pg.integer, n: natural, at: drawn(natural), y: pg.integer },
	["child", "n", "at"]
)
/** A mark at its place within a group that holds a clock: `at`, of child `child`. */
const Mark = relation("Mark", { child: pg.integer, at: instant, n: place.by("x"), x: pg.integer }, [
	"child",
	"at",
	"n"
])

/** Session, Turn and Move mutable inside the unit of their child, so a put or a delete of them meets the place's own
 * rule. */
export const Placed = schema(
	"Placed",
	[Stage, Session, Mark, Turn, Move],
	[
		ordered(on(Move, "child", "n", "at"), fin(Turn, "moves")),
		contained(on(Session, "child", "stage"), on(Stage, "child", "at")),
		key(on(Session, "child", "item", "stage")),
		key(on(Mark, "child", "at", "x")),
		unit("Child", { child: pg.integer }),
		mutable(Session),
		mutable(Turn),
		mutable(Move)
	]
)

/** A stage's fields but its clock. */
const stage = query(Placed).rule((r) => r.find({ child: r.param("child", pg.integer) }))
/** A session's fields but its place and its stage, which Stage's clock stamps. */
const session = query(Placed).rule((r) =>
	r.find({ child: r.param("child", pg.integer), item: r.param("item", pg.integer) })
)
/** A session of each stored stage, its stage a stored instant, its place left out. */
const sessionOfStored = query(Placed).rule((r) => {
	const { child, at } = v(Stage, "stage")
	return r.match(Stage, { child, at }).find({ child, item: r.param("item", pg.integer), stage: at })
})
/** A session stating its place. */
const sessionAt = query(Placed).rule((r) => {
	const { child, at } = v(Stage, "stage")
	return r
		.match(Stage, { child, at })
		.find({ child, item: r.param("item", pg.integer), n: r.param("n", natural), stage: at })
})
/** A turn's fields but its place and its moves. */
const turn = query(Placed).rule((r) =>
	r.find({ child: r.param("child", pg.integer), x: r.param("x", pg.integer) })
)
/** A mark's fields but its clock and its place. */
const mark = query(Placed).rule((r) =>
	r.find({ child: r.param("child", pg.integer), x: r.param("x", pg.integer) })
)

const empty = ChangeSet.empty(Placed)

/** A rule a write is refused by: every place rule but a schema's. */
type WriteRule = Extract<PlaceRule, { readonly kind: "written" | "groupStamped" | "stampedApart" }>

/** What the rule says of a write case: it compiles; its rows state a place, which no member head holds, as no head
 * holds a field grizzle writes (check/member.ts); or it is refused at a place by a rule. */
export type Verdict =
	| { readonly kind: "compiled" }
	| { readonly kind: "stated" }
	| { readonly kind: "refused"; readonly relation: string; readonly rule: WriteRule }

/** One write case: its name, its ChangeSet, built anew as a caller builds it, and the rule's verdict. */
export interface PlaceWriteCase {
	readonly name: string
	readonly changeSet: () => unknown
	readonly verdict: Verdict
}

const compiled: Verdict = { kind: "compiled" }

const refusedAt = (relation: string, rule: WriteRule): Verdict => ({
	kind: "refused",
	relation,
	rule
})

const writeCases: readonly [PlaceWriteCase, ...ReadonlyArray<PlaceWriteCase>] = [
	{
		name: "an insert of host rows beside their stage's",
		changeSet: () => empty.insert(Stage, []).insert(Session, []),
		verdict: compiled
	},
	{
		name: "an insert leaving its place out, its stage stamped beside it",
		changeSet: () => empty.insert(Stage, stage).insert(Session, session),
		verdict: compiled
	},
	{
		name: "an insert leaving its place out, its stage a stored instant",
		changeSet: () => empty.insert(Session, sessionOfStored),
		verdict: compiled
	},
	{
		name: "an insert stating its place",
		changeSet: () => empty.insert(Session, sessionAt),
		verdict: { kind: "stated" }
	},
	{
		name: "a put of its relation",
		changeSet: () => empty.put(Session, sessionOfStored),
		verdict: refusedAt("Session", { kind: "written", op: "put" })
	},
	{
		name: "a delete of its relation",
		changeSet: () => empty.delete(Session, sessionOfStored),
		verdict: refusedAt("Session", { kind: "written", op: "delete" })
	},
	{
		name: "a delete of its relation's whole groups, by a field of its group",
		changeSet: () => empty.deleteWhere({ Session: { child: param("child", pg.integer) } }),
		verdict: compiled
	},
	{
		name: "a delete of its relation's whole groups, by its group's every field",
		changeSet: () =>
			empty.deleteWhere({
				Session: { child: param("child", pg.integer), item: param("item", pg.integer) }
			}),
		verdict: compiled
	},
	{
		name: "a delete of a family owner's whole groups, its members with them",
		changeSet: () => empty.deleteWhere({ Turn: { child: param("child", pg.integer) } }),
		verdict: compiled
	},
	{
		name: "a delete of a family owner's rows",
		changeSet: () => empty.delete(Turn, turn),
		verdict: refusedAt("Turn", { kind: "written", op: "delete" })
	},
	{
		name: "a place whose group the insert stamps",
		changeSet: () => empty.insert(Mark, mark),
		verdict: refusedAt("Mark", { kind: "groupStamped", stamped: "Mark.at" })
	},
	{
		name: "a place stamped in two strata",
		changeSet: () =>
			ChangeSet.sequence(
				empty.insert(Session, sessionOfStored),
				empty.insert(Session, sessionOfStored)
			),
		verdict: refusedAt("Session", { kind: "stampedApart", apart: "strata" })
	}
]

export const placeWriteGen: Gen<PlaceWriteCase> = element(writeCases)

/** What a write case reaches: a compiled ChangeSet, a stated place, or its refusal's rule. */
export type PlaceWriteFeature = "compiled" | "stated" | WriteRule["kind"]

export const writeFeatureOf = (v: Verdict): PlaceWriteFeature =>
	v.kind === "refused" ? v.rule.kind : v.kind

/** A field of a schema case's Session. */
type SessionField = "child" | "item" | "n" | "stage" | "note"

/** Fields of a schema case's Session in key order, at least one. */
type KeyOf = readonly [SessionField, ...ReadonlyArray<SessionField>]

/** The primary keys a schema case's Session takes: n after its group, outside it, first in it, or before another field;
 * none of them the fields of a key beside it (`keyFields`), which a schema refuses as malformed. */
const primaryKeys: readonly [KeyOf, ...ReadonlyArray<KeyOf>] = [
	["child", "item", "n"],
	["child", "item", "note"],
	["n", "child", "item"],
	["child", "n", "item"]
]

/** The keys a schema case declares beside Session's primary key: (child, item, stage), (child, item), (child, note)
 * and (item, stage, note), or none. */
type Keys = "group and stage" | "group" | "outside group and stage" | "none"

const keyChoices: readonly [Keys, ...ReadonlyArray<Keys>] = [
	"group and stage",
	"group",
	"outside group and stage",
	"none"
]

/** A schema case's place's order (ir/desc.ts PlaceOrderDesc): unordered, or by stage, by `when`, no field, or by n,
 * itself. */
type CaseOrder = { readonly kind: "unordered" } | { readonly kind: "by"; readonly by: string }

const orders: readonly [CaseOrder, ...ReadonlyArray<CaseOrder>] = [
	{ kind: "unordered" },
	{ kind: "by", by: "stage" },
	{ kind: "by", by: "when" },
	{ kind: "by", by: "n" }
]

/** A schema's place, as a case declares it: its relation's key, its order, and the keys beside it. */
export interface PlaceSchemaCase {
	readonly primaryKey: KeyOf
	readonly order: CaseOrder
	readonly keys: Keys
}

/** Every schema case: each primary key, order and keys beside it, drawn on its own. */
export const placeSchemaGen: Gen<PlaceSchemaCase> = (source) => ({
	primaryKey: source.draw(element(primaryKeys)),
	order: source.draw(element(orders)),
	keys: source.draw(element(keyChoices))
})

/** The fields of each key a case declares beside its primary key. */
const keyFields = (keys: Keys): ReadonlyArray<ReadonlyArray<SessionField>> => {
	switch (keys) {
		case "group and stage":
			return [["child", "item", "stage"]]
		case "group":
			return [["child", "item"]]
		case "outside group and stage":
			return [
				["child", "note"],
				["item", "stage", "note"]
			]
		case "none":
			return []
	}
}

/**
 * The rule that refuses a case's place, or none where it is a place, as docs/reads-and-writes.md "Places" states it: last in its
 * primary key after its group, and, ordered by a field, by another field of the relation under a key within the group and
 * that field.
 */
export const refusalOf = (c: PlaceSchemaCase): Exclude<PlaceRule, WriteRule> | undefined => {
	const at = c.primaryKey.indexOf("n")
	if (at < 0) {
		return { kind: "outsideKey" }
	}
	if (at === 0) {
		return { kind: "groupless" }
	}
	if (at !== c.primaryKey.length - 1) {
		return { kind: "notLast" }
	}
	if (c.order.kind === "unordered") {
		return undefined
	}
	const by = c.order.by
	if (!["child", "item", "n", "stage", "note"].includes(by)) {
		return { kind: "byUnknown", by }
	}
	if (by === "n") {
		return { kind: "byItself" }
	}
	const group = c.primaryKey.slice(0, at)
	const within = new Set<string>([...group, by])
	const keyed = Arr.some([c.primaryKey, ...keyFields(c.keys)], (k) =>
		Arr.every(k, (f) => within.has(f))
	)
	if (keyed) {
		return undefined
	}
	const [first, ...rest] = group
	return first === undefined ? undefined : { kind: "byUnkeyed", key: [first, ...rest, by] }
}

/** The schema a schema case declares: Session's fields, its place `n` of the case's order, keyed as the case says. */
export const placeSchemaOf = (c: PlaceSchemaCase) => {
	const Declared = relation(
		"Session",
		{
			child: pg.integer,
			item: pg.integer,
			n: c.order.kind === "unordered" ? place : place.by(c.order.by),
			stage: pg.integer,
			note: pg.integer
		},
		c.primaryKey
	)
	const keys = ((): ReadonlyArray<ReturnType<typeof key>> => {
		switch (c.keys) {
			case "group and stage":
				return [key(on(Declared, "child", "item", "stage"))]
			case "group":
				return [key(on(Declared, "child", "item"))]
			case "outside group and stage":
				return [key(on(Declared, "child", "note")), key(on(Declared, "item", "stage", "note"))]
			case "none":
				return []
		}
	})()
	return schema("Declared", [Declared], keys)
}

/** What a schema case reaches: a place by its order, or its refusal's rule. */
export type PlaceSchemaFeature =
	| "a place"
	| "an unordered place"
	| Exclude<PlaceRule, WriteRule>["kind"]

export const schemaFeatureOf = (c: PlaceSchemaCase): PlaceSchemaFeature => {
	const refusal = refusalOf(c)
	return refusal !== undefined
		? refusal.kind
		: c.order.kind === "unordered"
			? "an unordered place"
			: "a place"
}

/**
 * A relation whose place a twin pair declares two ways: its group of one field or two, its place, and an ordering
 * field `o`, keyed by the group and `o` or by the group alone.
 */
export interface OrderedPlaceCase {
	readonly group: 1 | 2
	readonly keyed: "group and order" | "group"
}

export const orderedPlaceGen: Gen<OrderedPlaceCase> = (source) => ({
	group: source.draw(map(between(1, 2), (n): 1 | 2 => (n === 1 ? 1 : 2))),
	keyed: source.draw(
		map(between(0, 1), (n): OrderedPlaceCase["keyed"] => (n === 0 ? "group and order" : "group"))
	)
})

export type OrderedPlaceFeature =
	| "a place over a group of one field"
	| "a place over a group of two fields"
	| "keyed by its group and order"
	| "keyed by its group"

export const orderedPlaceFeatures = (c: OrderedPlaceCase): ReadonlyArray<OrderedPlaceFeature> => [
	c.group === 1 ? "a place over a group of one field" : "a place over a group of two fields",
	c.keyed === "group and order" ? "keyed by its group and order" : "keyed by its group"
]

/** The case's relation with its place `n` as `n` declares it, and its schema. */
const twinOf = (c: OrderedPlaceCase, n: PlaceField) => {
	if (c.group === 1) {
		const Twin = relation("Twin", { a: pg.integer, n, o: pg.integer }, ["a", "n"])
		return {
			Twin,
			schema: schema(
				"Twins",
				[Twin],
				[c.keyed === "group and order" ? key(on(Twin, "a", "o")) : key(on(Twin, "a"))]
			)
		}
	}
	const Twin = relation("Twin", { a: pg.integer, b: pg.integer, n, o: pg.integer }, ["a", "b", "n"])
	return {
		Twin,
		schema: schema(
			"Twins",
			[Twin],
			[c.keyed === "group and order" ? key(on(Twin, "a", "b", "o")) : key(on(Twin, "a", "b"))]
		)
	}
}

/** The case's twins: its relation with its place ordered by `o`, and with it unordered. */
export const orderedPlaceTwins = (c: OrderedPlaceCase) => ({
	by: twinOf(c, place.by("o")),
	unordered: twinOf(c, place)
})

/**
 * What a twin installs and writes: every statement of its installation's content (migrate/kit.ts installedStatements),
 * and the compiled program of an insert of its host rows, each statement's AST and step.
 */
export const installedAndWritten = (twin: ReturnType<typeof twinOf>) => {
	const artifacts = succeeded(testArtifacts(twin.schema, testCompile), "the twin's artifacts")
	const written = succeeded(
		compileWrite(
			checking(twin.schema),
			descOf(ChangeSet.empty(twin.schema).insert(twin.Twin, [])),
			realityWrite(artifacts)
		),
		"the twin's insert compiles"
	)
	return {
		installed: installedStatements(compile(twin.schema, asDrafted)),
		written: {
			statements: Arr.map(written.artifact.statements, (s) => s.ast),
			steps: written.artifact.steps
		}
	}
}

/**
 * A stamped nesting (write/family/nesting.ts Nesting `stamps`): an owner Owner(g, s, x, ms) keyed (g, s), its `s` a place
 * of group `g`, owning the sequence M1 of members (g, s, at, v) at `ms`; `full` gives M1 a sequence of its own, M2 (g, s,
 * at, bt, w) at `ks`, and the owner a second one, N1 (g, s, ct, u) at `ns`. Each member carries its owner's `s` in its
 * group. A clock-keyed owner owns no family, its group being caller fields, which no instant is
 * (analysis/theory/fill.ts). Its ChangeSet inserts Owner's host rows, with its members nested in them.
 */
export interface StampedNesting {
	readonly full: boolean
}

export const stampedNestingGen: Gen<StampedNesting> = (source) => ({
	full: source.draw(map(between(0, 1), (n) => n === 1))
})

export type StampedNestingFeature = "one sequence of members" | "members two deep and two sequences"

export const stampedNestingFeatures = (c: StampedNesting): ReadonlyArray<StampedNestingFeature> => [
	c.full ? "members two deep and two sequences" : "one sequence of members"
]

/** The case's schema, the names of the relations its nesting writes, and its ChangeSet, built as a caller builds it. */
export const stampedNestingOf = (c: StampedNesting) => {
	const s = place
	const carried = natural
	if (!c.full) {
		const Owner = relation("Owner", { g: pg.integer, s, x: pg.integer, ms: drawn(natural) }, [
			"g",
			"s"
		])
		const M1 = relation("M1", { g: pg.integer, s: carried, at: drawn(natural), v: pg.integer }, [
			"g",
			"s",
			"at"
		])
		const Nested = schema(
			"Nested",
			[Owner, M1],
			[ordered(on(M1, "g", "s", "at"), fin(Owner, "ms"))]
		)
		return {
			relations: ["Owner", "M1"],
			schema: Nested,
			changeSet: () => ChangeSet.empty(Nested).insert(Owner, [])
		}
	}
	const Owner = relation(
		"Owner",
		{ g: pg.integer, s, x: pg.integer, ms: drawn(natural), ns: drawn(natural) },
		["g", "s"]
	)
	const M1 = relation(
		"M1",
		{ g: pg.integer, s: carried, at: drawn(natural), v: pg.integer, ks: drawn(natural) },
		["g", "s", "at"]
	)
	const M2 = relation(
		"M2",
		{ g: pg.integer, s: carried, at: natural, bt: drawn(natural), w: pg.integer },
		["g", "s", "at", "bt"]
	)
	const N1 = relation("N1", { g: pg.integer, s: carried, ct: drawn(natural), u: pg.integer }, [
		"g",
		"s",
		"ct"
	])
	const Nested = schema(
		"Nested",
		[Owner, M1, M2, N1],
		[
			ordered(on(M1, "g", "s", "at"), fin(Owner, "ms")),
			ordered(on(M2, "g", "s", "at", "bt"), fin(M1, "ks")),
			ordered(on(N1, "g", "s", "ct"), fin(Owner, "ns"))
		]
	)
	return {
		relations: ["M1", "M2", "N1", "Owner"],
		schema: Nested,
		changeSet: () => ChangeSet.empty(Nested).insert(Owner, [])
	}
}
