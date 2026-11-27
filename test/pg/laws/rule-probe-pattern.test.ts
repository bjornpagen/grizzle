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
 *   Closed row holds. A case's first transaction stores a state that keeps it and must commit; its second, one write
 *   that one of the probes reads, commits exactly when the state it leaves keeps the rule, and is refused otherwise
 *   by 23503, naming no constraint but the rule's; a deletion of an Allowed tag, a data step's, is refused by its
 *   bracket's re-check inside the bracket, 23000 under the rule's law (data-step.ts refusedByRecheck), since the judge
 *   reads none of a closed relation's removed rows; but an update of Item 1 to another tag, where Item is immutable, is
 *   refused by Item's immutability guard (42501) before any rule judges the state, whatever it leaves: the guard holds
 *   every field outside the ones the schema changes in place (fixtures.ts `guarded`, ir/law.ts RelationInfo `inPlace`).
 *
 * The space, drawn: Item immutable, the schema's default, or declared mutable; the stored state, each subset of the tags
 * a and b Allowed and each Closed, and Item 1 absent or at a tag the rule admits there; then one write: Item 2 inserted
 * at a or b, Item 1 updated to a or b, an Allowed tag deleted, in a data step since Allowed is closed (data-step.ts
 * asDataStep), or a Closed tag inserted.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { seatIn } from "#test/pg/fin/installed.ts"
import {
	after,
	Disagreed,
	type Feature,
	FEATURES,
	guarded,
	keeps,
	literalOf,
	RELATIONS,
	ruleProbePatternTemplates,
	sketchGen,
	text
} from "#test/pg/laws/rule-probe-pattern.fixtures.ts"
import { asDataStep, refusedByRecheck } from "#test/support/data-step.ts"
import { attempt, momentText, refusalText } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A rule over a query whose probes read a pattern-typed field, on PostgreSQL 19 commits exactly the writes that leave every Item's tag Open's, refusing the rest by 23503, its probes casting each tag to its column's own type.
 *
 * Its budget, a generative search where an exhaustion ran 384 cases: one rotating case, the smallest at which its
 * witnesses still kill its kill, and the runner's steered cap, past which a green run spends nothing (its steered phase
 * ends at its last situation reached).
 *
 * @limitKind measured
 * @owner grizzle's network tier (test/pg/laws/rule-probe-pattern.test.ts)
 * @unit cases: rotating ones (runs), and steered ones while a required situation is unreached (steered)
 * @scope each run of this property, its floor stream (a quarter of runs, rounded up) and steered phase fixed by its
 *   identity, the same on every run seed
 * @evidence ~/.cache/grizzle-release/CULL-LAWS/measure/run-rpp-default.log and run-rpp-r1.log, uncommitted, each written
 *   by `runprop.sh <workspace> <tag> test/pg/laws/rule-probe-pattern.test.ts` (in the same folder): toolchain-test run
 *   under TEST_SEED=2219874524 with a fresh XDG_CACHE_HOME, so no cached verdict answers the kill
 * @observed 2026-11-23 04:15 to 04:30 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, load average 400 to 430; the machine's
 *   PostgreSQL 19.0 as an in-memory lane family (grizzle-m-cull-laws-b); grizzle main f87b2aaab with lane CULL-LAWS's
 *   cull, vendor/toolchain 2cc481724, Node 26.13.1
 * @workload this property alone on one worker, then its kill (the immutability guard dropped) against its witnesses
 * @result at the runner's budget (150 runs, 200 steered): green, 150 rotating cases and 64 steered, the kill killed; at
 *   1 run and 200 steered: green, every one of its 9 situations reached by 1 floor case, 1 rotating and 80 steered, the
 *   kill killed. Not measured: steered caps below 200, which cost a green run nothing above the 80 it spends
 * @decision 1 run, the least a search takes, kills the kill; 200 steered, the runner's steeredCases, since a green run
 *   spends 80 of them and a cap below that leaves a situation unreached. No headroom added
 * @revalidate a change of sketchGen or of the property's identity (its name or file), which moves its witnesses; a new
 *   kill; a toolchain repin that changes how witnesses are drawn
 */
export const aRuleOverAQueryWhoseProbesReadAPatternTypedFieldOnPostgreSQL19CommitsExactlyTheWritesThatLeaveEveryItemsTagOpensRefusingTheRestBy23503ItsProbesCastingEachTagToItsColumnsOwnType =
	property.explore(sketchGen, {
		needs: {
			immutable: Substrate.fresh(ruleProbePatternTemplates.immutable),
			mutable: Substrate.fresh(ruleProbePatternTemplates.mutable)
		},
		situations: FEATURES satisfies ReadonlyArray<Reached<Feature>>,
		check: (seats, c: Case<Feature>) => (s) =>
			Effect.gen(function* () {
				const taken = yield* seats[s.standing]
				const seat = yield* seatIn(
					taken,
					RELATIONS,
					s.standing === "mutable" ? "rule_probe_pattern_mutable" : "rule_probe_pattern"
				)
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
				const real = yield* attempt(
					seat.session,
					w.kind === "delete allowed"
						? asDataStep(seat.installed.installation, [statement])
						: [statement]
				)
				if (guarded(s)) {
					if (real.kind === "committed" || real.fields.code !== "42501") {
						return yield* new Disagreed({
							message: `${real.kind === "committed" ? "committed" : `refused ${momentText(real.moment)} by ${refusalText(real.fields)}`} an update of an immutable Item to another tag, which its immutability guard refuses by 42501: ${literalOf(s)}`
						})
					}
					c.note("an update of an immutable Item refused by its guard")
					return
				}
				const lawful = keeps(after(s.state, w))
				/** The rule's law, which a data step's re-check refuses a breaking deletion under. */
				const [rule] = seat.model.rules
				const law = rule === undefined ? undefined : rule.law.id
				if (real.kind === "committed") {
					if (!lawful) {
						return yield* new Disagreed({
							message: `committed a write that leaves an Item's tag outside Open: ${literalOf(s)}`
						})
					}
					c.note(`committed ${w.kind}`)
					return
				}
				const refusedAsLaw =
					w.kind === "delete allowed"
						? real.moment.kind === "statement" &&
							law !== undefined &&
							refusedByRecheck(real.fields, law)
						: real.fields.code === "23503"
				if (lawful || !refusedAsLaw) {
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
		budget: { runs: 1, steered: 200 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/immutable.ts",
				original: "\t\tif (relation.mutable) {",
				replacement: "\t\tif (relation.mutable || true) {",
				why: "No immutable relation carries its immutability guard, as before e51534fba: an update of an immutable Item to another tag is judged by the rule alone, committing where the tag it moves to is Open's and refused by 23503 elsewhere, where its guard refuses it by 42501."
			}
		]
	})
