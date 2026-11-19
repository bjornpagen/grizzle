/** What the properties of places.test.ts read: their schemas, their cases with their verdicts, and their features. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { PlaceRule } from "#compiler/core/causes.ts"
import { instant, natural, pg, place } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, key, on, relation, schema } from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"

/** A stage decision of a child, at its clock of child `child`. */
const Stage = relation("Stage", { child: pg.integer, at: instant }, ["child", "at"])
/** A child's session of an item, at its place `n` within the child's item, its stage a reference to Stage's clock. */
const Session = relation(
	"Session",
	{ child: pg.integer, item: pg.integer, n: place({ by: "stage" }), stage: instant },
	["child", "item", "n"]
)
/** A mark at its place within a group that holds a clock: `at`, of child `child`. */
const Mark = relation(
	"Mark",
	{ child: pg.integer, at: instant, n: place({ by: "x" }), x: pg.integer },
	["child", "at", "n"]
)

export const Placed = schema(
	"Placed",
	[Stage, Session, Mark],
	[
		contained(on(Session, "child", "stage"), on(Stage, "child", "at")),
		key(on(Session, "child", "item", "stage")),
		key(on(Mark, "child", "at", "x"))
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

/** The keys a schema case declares beside Session's primary key: (child, item, stage), (child, item), (child, note)
 * and (item, stage, note), or none. */
type Keys = "group and stage" | "group" | "outside group and stage" | "none"

/** A schema's place, as a case declares it: its relation's key, its `by`, and the keys beside it. */
export interface PlaceSchemaCase {
	readonly name: string
	readonly primaryKey: KeyOf
	readonly by: string
	readonly keys: Keys
	/** The rule that refuses it, or none where it is a place. */
	readonly refusal: Exclude<PlaceRule, WriteRule> | undefined
}

const schemaCases: readonly [PlaceSchemaCase, ...ReadonlyArray<PlaceSchemaCase>] = [
	{
		name: "a place after its group, ordered by a key",
		primaryKey: ["child", "item", "n"],
		by: "stage",
		keys: "group and stage",
		refusal: undefined
	},
	{
		name: "a place ordered by a key within its group",
		primaryKey: ["child", "item", "n"],
		by: "stage",
		keys: "group",
		refusal: undefined
	},
	{
		name: "a place outside its key",
		primaryKey: ["child", "item", "stage"],
		by: "stage",
		keys: "none",
		refusal: { kind: "outsideKey" }
	},
	{
		name: "a place first in its key",
		primaryKey: ["n", "child", "item"],
		by: "stage",
		keys: "group and stage",
		refusal: { kind: "groupless" }
	},
	{
		name: "a place before another field of its key",
		primaryKey: ["child", "n", "item"],
		by: "stage",
		keys: "group and stage",
		refusal: { kind: "notLast" }
	},
	{
		name: "a place by no field",
		primaryKey: ["child", "item", "n"],
		by: "when",
		keys: "group and stage",
		refusal: { kind: "byUnknown", by: "when" }
	},
	{
		name: "a place by itself",
		primaryKey: ["child", "item", "n"],
		by: "n",
		keys: "none",
		refusal: { kind: "byItself" }
	},
	{
		name: "a place ordered by no key",
		primaryKey: ["child", "item", "n"],
		by: "stage",
		keys: "outside group and stage",
		refusal: { kind: "byUnkeyed", key: ["child", "item", "stage"] }
	}
]

export const placeSchemaGen: Gen<PlaceSchemaCase> = element(schemaCases)

/** The schema a schema case declares: Session's fields, its place `n` by the case's `by`, keyed as the case says. */
export const placeSchemaOf = (c: PlaceSchemaCase) => {
	const Declared = relation(
		"Session",
		{
			child: pg.integer,
			item: pg.integer,
			n: place({ by: c.by }),
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

/** What a schema case reaches: a place, or its refusal's rule. */
export type PlaceSchemaFeature = "a place" | Exclude<PlaceRule, WriteRule>["kind"]

export const schemaFeatureOf = (c: PlaceSchemaCase): PlaceSchemaFeature =>
	c.refusal === undefined ? "a place" : c.refusal.kind
