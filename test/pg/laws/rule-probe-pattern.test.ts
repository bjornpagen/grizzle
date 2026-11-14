/**
 * A rule over a query whose triggers probe a pattern-typed field fires on PostgreSQL 19rc2. Each trigger function's
 * probe casts its row's field to the column's installed type, the pattern's structural domain, which the installation
 * creates (lower/conservative/types.ts ConservativeSubject `ruleProbe`), and never to a served parameter's own pattern
 * domain, which no installation creates for a probe: PostgreSQL would raise 42704 the first time the trigger fires.
 *
 * The schema: Allowed and Closed, each a Tag (one to four lowercase letters) keyed by itself; Open, the derived relation
 * of Allowed's tags no Closed row holds; and Item, an id and a Tag, every Item's tag one of Open's. A containment into a
 * negation keeps its triggers (analysis/theory/laws.ts RuleLowering): on Item, at an insert and at an update of its tag,
 * whose probe reads NEW's tag; on Allowed, at a delete, whose probe reads OLD's tag; and on Closed, at an insert, whose
 * probe reads NEW's tag.
 *
 * - The specification turned into a checker: a state keeps the rule exactly when every Item's tag is an Allowed tag no
 *   Closed row holds. The box's first transaction stores a state that keeps it and must commit; its second, one write
 *   that fires one of the triggers, commits exactly when the state it leaves keeps the rule, and is refused otherwise
 *   by 23503, naming no constraint but the rule's.
 *
 * The box: the stored state, each subset of the tags a and b Allowed and each Closed, and Item 1 absent or at a tag the
 * rule admits there; then one write: Item 2 inserted at a or b, Item 1 updated to a or b, an Allowed tag deleted, or a
 * Closed tag inserted.
 *
 * Plants (~/.cache/grizzle-release/CONTRACTDOMAIN/plants): probe-as-served-param.patch lowers a probe as a served
 * query, its parameters cast to their own pattern domains, so the installation refuses to compile (UninstalledDomain)
 * and the box fails at its seat.
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Data, Effect, Formatter } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { cleared, seatOf } from "#test/pg/fin/installed.ts"
import { caseHang } from "#test/support/limits.ts"
import { attempt, momentText, refusalText } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Tag = str.regex("^[a-z]{1,4}$")
const Allowed = relation("Allowed", { tag: Tag }, ["tag"])
const Closed = relation("Closed", { tag: Tag }, ["tag"])
const Item = relation("Item", { id: pg.int4, tag: Tag }, ["id"])
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

const RELATIONS: Arr.NonEmptyReadonlyArray<string> = ["Allowed", "Closed", "Item"]

const TAGS = ["a", "b"] as const
type TagValue = (typeof TAGS)[number]

/** A state of the box: the Allowed and Closed tags, and Item 1's tag, absent or one the rule admits. */
interface State {
	readonly allowed: ReadonlyArray<TagValue>
	readonly closed: ReadonlyArray<TagValue>
	readonly item: TagValue | undefined
}

/** One write, each firing one of the rule's triggers (see the header). */
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

const sketchGen: Gen<Sketch> = (source) => ({
	state: source.draw(element(STATES)),
	write: source.draw(element(WRITES))
})

/** The state a write leaves, and the tag of the Item it inserts, if it inserts one; an update of an absent Item changes
 * no row. */
const after = (s: State, w: Write): State & { readonly inserted: TagValue | undefined } => {
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
const keeps = (s: State & { readonly inserted: TagValue | undefined }): boolean =>
	(s.item === undefined || open(s, s.item)) && (s.inserted === undefined || open(s, s.inserted))

type Feature = `committed ${Write["kind"]}` | `refused ${Write["kind"]}`

const FEATURES: Arr.NonEmptyReadonlyArray<Feature> = [
	"committed insert item",
	"refused insert item",
	"committed update item",
	"refused update item",
	"committed delete allowed",
	"refused delete allowed",
	"committed insert closed",
	"refused insert closed"
]

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

const literalOf = (s: Sketch): string => Formatter.format(s)

layer(Substrate.layer)(
	"a rule over a query whose triggers probe a pattern-typed field, on PostgreSQL 19rc2",
	(it) => {
		it.effect(
			"commits exactly the writes that leave every Item's tag Open's, refusing the rest by 23503, its probes casting each tag to its column's own type",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const seat = yield* seatOf(RuleProbePattern, RELATIONS, "rule_probe_pattern")
						const col = (r: string, f: string) => seat.column(r, f)
						const text = (tag: TagValue) => `'${tag}'`
						return yield* exhaust(
							{
								suite: "laws/rule-probe-pattern",
								generator: sketchGen,
								literal: literalOf,
								box: "every state of the tags a and b Allowed and Closed with Item 1 absent or at an Open tag, then one write of each kind at each tag",
								oracle: {
									kind: "specification",
									name: "the containment as a checker: every Item's tag an Allowed tag no Closed row holds"
								},
								coverage: requiredInSpace<Feature>(FEATURES),
								caseHang,
								concurrency: 1
							},
							(s, c) =>
								Effect.gen(function* () {
									const stored = [
										...Arr.map(
											s.state.allowed,
											(tag) =>
												`INSERT INTO ${seat.table("Allowed")} (${col("Allowed", "tag")}) VALUES (${text(tag)})`
										),
										...Arr.map(
											s.state.closed,
											(tag) =>
												`INSERT INTO ${seat.table("Closed")} (${col("Closed", "tag")}) VALUES (${text(tag)})`
										),
										...(s.state.item === undefined
											? []
											: [
													`INSERT INTO ${seat.table("Item")} (${col("Item", "id")}, ${col("Item", "tag")}) VALUES (1, ${text(s.state.item)})`
												])
									]
									const seeded = yield* attempt(seat.session, stored)
									if (seeded.kind !== "committed") {
										yield* cleared(seat, RELATIONS)
										return yield* new Disagreed({
											message: `refused a state that keeps the rule ${momentText(seeded.moment)} by ${refusalText(seeded.fields)}: ${literalOf(s)}`
										})
									}
									const w = s.write
									const statement =
										w.kind === "insert item"
											? `INSERT INTO ${seat.table("Item")} (${col("Item", "id")}, ${col("Item", "tag")}) VALUES (2, ${text(w.tag)})`
											: w.kind === "update item"
												? `UPDATE ${seat.table("Item")} SET ${col("Item", "tag")} = ${text(w.tag)} WHERE ${col("Item", "id")} = 1`
												: w.kind === "delete allowed"
													? `DELETE FROM ${seat.table("Allowed")} WHERE ${col("Allowed", "tag")} = ${text(w.tag)}`
													: `INSERT INTO ${seat.table("Closed")} (${col("Closed", "tag")}) VALUES (${text(w.tag)}) ON CONFLICT DO NOTHING`
									const real = yield* attempt(seat.session, [statement])
									yield* cleared(seat, RELATIONS)
									const lawful = keeps(after(s.state, w))
									if (real.kind === "committed") {
										if (!lawful) {
											return yield* new Disagreed({
												message: `committed a write that leaves an Item's tag outside Open: ${literalOf(s)}`
											})
										}
										c.note(`committed ${w.kind}`)
										return
									}
									if (lawful || real.fields.code !== "23503") {
										return yield* new Disagreed({
											message: `refused ${momentText(real.moment)} by ${refusalText(real.fields)}, where the state it leaves ${lawful ? "keeps" : "breaks"} the rule: ${literalOf(s)}`
										})
									}
									c.note(`refused ${w.kind}`)
								})
						)
					})
				)
		)
	}
)
