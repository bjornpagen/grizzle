/**
 * Which containment targets hold a key, through grizzle's lowering on PostgreSQL 19rc2: a search over a relation
 * Tgt(id, a, b, c, flag, depth) keyed by id and by at most one drawn key, over Tgt or a drawn selection of it, and a
 * containment from Src(sid, p, q, r) into a drawn selection of Tgt on a drawn list of its terms id, a and b, each
 * selection one condition per field at most, a field equal to a value, to another field, or other than a value.
 *
 * - **The specification turned into a checker:** a target is admitted exactly when it holds a key, a key of Tgt whose
 *   selection's conditions are all the target's, with its terms among the target's terms, or among its terms and the
 *   fields the target fixes outside the key's selection, each by one condition equating it to a value or to one of the
 *   target's terms. A target that holds no key is refused UnsupportedLawFamily when the schema compiles, and a drawn key
 *   over the whole relation at id alone, which restates the primary key, MalformedDescription (schema/own.ts
 *   distinctKeys).
 * - **The rules' meaning turned into a checker:** over an admitted schema, drawn states of Tgt and Src rows, each
 *   written in one transaction, Tgt first, and checked as its COMMIT would check it: a state commits exactly when its
 *   Tgt rows keep the drawn key and every Src row's tuple is a Tgt row's at the target's terms, a row the target's
 *   selection keeps. A state that breaks the key is refused 23505 by a unique of Tgt, and one that keeps it and breaks
 *   the containment 23503 by Src's foreign key reporting the containment's law, so the UNIQUE a fixed target references
 *   refuses no state the key admits.
 *
 * A case may also state a containment out of the target's selection, over id and the target's terms, into Tgt over the
 * same: it holds of every state, each selected row being its own tuple, and its reverse probe reads every one of the
 * target's own columns, so a fixed target is referenced at those under a UNIQUE that probe reads too (laws/model/plan.ts
 * `#reference`), which the key implies as it implies the one over the target's terms and fixed fields, and the
 * checker's verdicts stand unchanged.
 *
 * Kept beside the search, the downstream shapes: a target fixed to three values beyond its term, held by a key over a
 * wider selection whose condition is one of the three; and targets fixed to a natural and to a boolean, each held by a
 * key over the whole relation. And a drawn key over the whole relation at id alone, refused as a second key over the
 * primary key's set.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { seatOf } from "#test/pg/fin/installed.ts"
import {
	containmentBroken,
	Disagreed,
	heldOf,
	keyBroken,
	probeOf,
	RELATIONS,
	restatesPrimary,
	schemaOf,
	sharesTerms,
	sketchGen,
	statementsOf,
	type TargetKeyFeature,
	targetAims
} from "#test/pg/laws/target-keys.fixtures.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { attemptChecked, momentText, refusalText } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Which containment targets hold a key on PostgreSQL 19rc2 admit a target exactly when it holds a key, and refuse no state its key and its containment admit.
 *
 * Its pre-conversion budget: runs 96, coverage cases 32 (test/pg/laws/target-keys.test.ts at d8eed1786).
 */
export const whichContainmentTargetsHoldAKeyOnPostgreSQL19rc2AdmitATargetExactlyWhenItHoldsAKeyAndRefuseNoStateItsKeyAndItsContainmentAdmit =
	property.explore(aimed(sketchGen, targetAims), {
		needs: { substrate: Substrate.installing },
		situations: [
			"held by its terms",
			"held by fixed fields",
			"fixed to a value",
			"fixed to a term",
			"held by a key over a selection",
			"held by fixed fields, a probe out of its selection reading its terms",
			"refused, holding no key",
			"committed",
			"committed a source row",
			"committed two target rows equal at its terms",
			"refused by the key",
			"refused by the containment"
		] satisfies ReadonlyArray<Reached<TargetKeyFeature>>,
		check:
			({ substrate }, c: Case<TargetKeyFeature>) =>
			(s) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const desc = schemaOf(s)
							const held = heldOf(s)
							const compiled = testArtifacts(desc, testCompile)
							if (restatesPrimary(s)) {
								if (compiled.ok || compiled.error.reason._tag !== "MalformedDescription") {
									return yield* new Disagreed({
										message: `${compiled.ok ? "admitted" : `refused ${compiled.error.message}`} a key restating the primary key, not MalformedDescription: ${Formatter.format(s)}`
									})
								}
								c.note("refused, restating the primary key")
								return
							}
							if (!compiled.ok) {
								if (held.kind !== "none" || compiled.error.reason._tag !== "UnsupportedLawFamily") {
									return yield* new Disagreed({
										message: `refused ${compiled.error.message}, where the target holds a key (${held.kind}): ${Formatter.format(s)}`
									})
								}
								c.note("refused, holding no key")
								return
							}
							switch (held.kind) {
								case "none":
									return yield* new Disagreed({
										message: `admitted a target that holds no key: ${Formatter.format(s)}`
									})
								case "terms":
									c.note("held by its terms")
									break
								case "fixed":
									c.note("held by fixed fields")
									for (const x of held.fixed) {
										c.note(`fixed to ${x.to}`)
									}
									if (held.key.selection.length > 0) {
										c.note("held by a key over a selection")
									}
									if (probeOf(s).length > 0) {
										c.note("held by fixed fields, a probe out of its selection reading its terms")
									}
									break
							}
							const seat = yield* seatOf(desc, RELATIONS, "target_keys")
							const laws = seat.lawsOf("containment")
							for (const state of s.states) {
								const real = yield* attemptChecked(
									seat.session,
									statementsOf(state, seat.table, seat.column),
									Effect.void
								)
								const brokeKey = keyBroken(s, state)
								const brokeContainment = containmentBroken(s, state)
								const said = `the state breaks ${brokeKey ? "the key" : "no key"} and ${brokeContainment ? "the containment" : "no containment"}: ${Formatter.format(state)} of ${Formatter.format({ ...s, states: [] })}`
								if (real.kind === "committed") {
									if (brokeKey || brokeContainment) {
										return yield* new Disagreed({ message: `committed where ${said}` })
									}
									c.note("committed")
									if (Arr.some(state.src, (r) => r !== undefined)) {
										c.note("committed a source row")
									}
									if (sharesTerms(s, state)) {
										c.note("committed two target rows equal at its terms")
									}
									continue
								}
								const named = seat.refusedBy(real.fields)
								const byKey =
									brokeKey &&
									real.fields.code === "23505" &&
									Option.exists(named, (k) => k.relation === "Tgt")
								const byContainment =
									brokeContainment &&
									real.fields.code === "23503" &&
									Option.exists(
										named,
										(k) =>
											k.kind === "foreign" &&
											k.relation === "Src" &&
											Option.exists(k.law, (l) => laws.includes(l))
									)
								if (!byKey && !byContainment) {
									return yield* new Disagreed({
										message: `refused ${momentText(real.moment)} by ${refusalText(real.fields)}, where ${said}`
									})
								}
								c.note(byKey ? "refused by the key" : "refused by the containment")
							}
						})
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "a target holds a key by the rules, and a state commits exactly when it keeps the drawn key and every Src tuple is a Tgt tuple the target keeps"
		},
		budget: { runs: 96, steered: 32 },
		kept: [],
		kills: []
	})
