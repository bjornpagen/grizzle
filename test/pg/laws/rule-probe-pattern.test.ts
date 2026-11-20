/**
 * A rule over a query whose probes read a pattern-typed field holds on PostgreSQL 19. The set judge's probe over its
 * region (physical/ddl/rules.ts) reads the field from the session's delta of its table, a column of the pattern's base
 * type, which no domain names, beside the stored column of the pattern's structural domain, which the installation
 * creates (lower/conservative/types.ts RegionLowering); no probe reads a served parameter's own pattern domain, which no
 * installation creates for a probe: PostgreSQL would raise 42704 the first time the judge ran it.
 *
 * The schema: Allowed and Closed, each a Tag (one to four lowercase letters) keyed by itself; Open, the derived relation
 * of Allowed's tags no Closed row holds; and Item, an id and a Tag, every Item's tag one of Open's. A containment into a
 * negation is judged over the rows a transaction wrote (analysis/theory/laws.ts RuleLowering): Item's inserted rows and
 * its updates of a tag, whose probe reads the new tag; Allowed's deleted rows, whose probe reads the old tag; and
 * Closed's inserted rows, whose probe reads the new tag.
 *
 * - The specification turned into a checker: a state keeps the rule exactly when every Item's tag is an Allowed tag no
 *   Closed row holds. The box's first transaction stores a state that keeps it and must commit; its second, one write
 *   that one of the probes reads, commits exactly when the state it leaves keeps the rule, and is refused otherwise
 *   by 23503, naming no constraint but the rule's.
 *
 * The box: the stored state, each subset of the tags a and b Allowed and each Closed, and Item 1 absent or at a tag the
 * rule admits there; then one write: Item 2 inserted at a or b, Item 1 updated to a or b, an Allowed tag deleted, or a
 * Closed tag inserted.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { seatIn } from "#test/pg/fin/installed.ts"
import {
	after,
	Disagreed,
	type Feature,
	FEATURES,
	keeps,
	literalOf,
	RELATIONS,
	ruleProbePatternTemplate,
	sketchGen,
	text
} from "#test/pg/laws/rule-probe-pattern.fixtures.ts"
import { attempt, momentText, refusalText } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A rule over a query whose probes read a pattern-typed field, on PostgreSQL 19 commits exactly the writes that leave every Item's tag Open's, refusing the rest by 23503, its probes casting each tag to its column's own type.
 */
export const aRuleOverAQueryWhoseProbesReadAPatternTypedFieldOnPostgreSQL19CommitsExactlyTheWritesThatLeaveEveryItemsTagOpensRefusingTheRestBy23503ItsProbesCastingEachTagToItsColumnsOwnType =
	property.exhaust(finite(sketchGen), {
		needs: { seated: Substrate.seat(ruleProbePatternTemplate) },
		situations: FEATURES satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ seated }, c: Case<Feature>) =>
			(s) =>
				Effect.gen(function* () {
					const taken = yield* seated
					const seat = yield* seatIn(taken, RELATIONS, "rule_probe_pattern")
					const col = (r: string, f: string) => seat.column(r, f)

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
				}),
		oracle: {
			kind: "specification",
			name: "the containment as a checker: every Item's tag an Allowed tag no Closed row holds"
		},
		box: "every state of the tags a and b Allowed and Closed with Item 1 absent or at an Open tag, then one write of each kind at each tag",
		kept: [],
		kills: []
	})
