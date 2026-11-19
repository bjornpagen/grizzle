/** What the properties of rule-probe-pattern.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Data, Formatter } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { seatTemplate } from "#test/pg/fin/installed.ts"

const Tag = str.regex("^[a-z]{1,4}$")

const Allowed = relation("Allowed", { tag: Tag }, ["tag"])

const Closed = relation("Closed", { tag: Tag }, ["tag"])

const Item = relation("Item", { id: pg.integer, tag: Tag }, ["id"])

const Base = schema("RuleProbePattern", [Allowed, Closed, Item], [])

const Open = derived(
	"Open",
	query(Base).rule((r) => {
		const { tag } = v(Allowed, "allowed")
		return r.match(Allowed, { tag }).where(r.not(Closed, { tag })).find({ tag })
	})
)

const RuleProbePattern = schema.extend(
	Base,
	"RuleProbePatternRule",
	[Open],
	[contained(on(Item, "tag"), on(Open, "tag"))]
)

export const RELATIONS: Arr.NonEmptyReadonlyArray<string> = ["Allowed", "Closed", "Item"]

const TAGS = ["a", "b"] as const

type TagValue = (typeof TAGS)[number]

/** A state of the box: the Allowed and Closed tags, and Item 1's tag, absent or one the rule admits. */
interface State {
	readonly allowed: ReadonlyArray<TagValue>
	readonly closed: ReadonlyArray<TagValue>
	readonly item: TagValue | undefined
}

/** One write, each one that one of the rule's probes reads (see the header). */
type Write =
	| { readonly kind: "insert item"; readonly tag: TagValue }
	| { readonly kind: "update item"; readonly tag: TagValue }
	| { readonly kind: "delete allowed"; readonly tag: TagValue }
	| { readonly kind: "insert closed"; readonly tag: TagValue }

interface Sketch {
	readonly state: State
	readonly write: Write
}

/** Whether `tag` is Open's in a state: Allowed holds it and Closed does not. */
const open = (s: Pick<State, "allowed" | "closed">, tag: TagValue): boolean =>
	Arr.contains(s.allowed, tag) && !Arr.contains(s.closed, tag)

const subsets: Arr.NonEmptyReadonlyArray<ReadonlyArray<TagValue>> = [[], ["a"], ["b"], ["a", "b"]]

/** Every state that keeps the rule: Item 1 absent, or at a tag Open holds. */
const STATES: Arr.NonEmptyReadonlyArray<State> = Arr.flatMap(subsets, (allowed) =>
	Arr.flatMap(subsets, (closed): Arr.NonEmptyReadonlyArray<State> => [
		{ allowed, closed, item: undefined },
		...Arr.map(
			Arr.filter(TAGS, (tag) => open({ allowed, closed }, tag)),
			(tag): State => ({ allowed, closed, item: tag })
		)
	])
)

const WRITES: Arr.NonEmptyReadonlyArray<Write> = Arr.flatMap(
	TAGS,
	(tag): Arr.NonEmptyReadonlyArray<Write> => [
		{ kind: "insert item", tag },
		{ kind: "update item", tag },
		{ kind: "delete allowed", tag },
		{ kind: "insert closed", tag }
	]
)

export const sketchGen: Gen<Sketch> = (source) => ({
	state: source.draw(element(STATES)),
	write: source.draw(element(WRITES))
})

/** The state a write leaves, and the tag of the Item it inserts, if it inserts one; an update of an absent Item changes
 * no row. */
export const after = (s: State, w: Write): State & { readonly inserted: TagValue | undefined } => {
	switch (w.kind) {
		case "insert item":
			return { ...s, inserted: w.tag }
		case "update item":
			return { ...s, item: s.item === undefined ? undefined : w.tag, inserted: undefined }
		case "delete allowed":
			return { ...s, allowed: Arr.filter(s.allowed, (t) => t !== w.tag), inserted: undefined }
		case "insert closed":
			return {
				...s,
				closed: Arr.contains(s.closed, w.tag) ? s.closed : [...s.closed, w.tag],
				inserted: undefined
			}
	}
}

/** Whether a state keeps the rule: every Item's tag is Open's. */
export const keeps = (s: State & { readonly inserted: TagValue | undefined }): boolean =>
	(s.item === undefined || open(s, s.item)) && (s.inserted === undefined || open(s, s.inserted))

export type Feature = `committed ${Write["kind"]}` | `refused ${Write["kind"]}`

export const FEATURES: Arr.NonEmptyReadonlyArray<Feature> = [
	"committed insert item",
	"refused insert item",
	"committed update item",
	"refused update item",
	"committed delete allowed",
	"refused delete allowed",
	"committed insert closed",
	"refused insert closed"
]

export class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

export const literalOf = (s: Sketch): string => Formatter.format(s)

export const text = (tag: TagValue) => `'${tag}'`

/** RuleProbePattern installed once per member (fin/installed.ts seatTemplate), which each case's seat holds. */
export const ruleProbePatternTemplate = seatTemplate(
	import.meta,
	RuleProbePattern,
	"rule_probe_pattern"
)
