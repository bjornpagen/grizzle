/**
 * A relation keyed by the digests of its texts (ir/keys.ts GeneratedRead), on PostgreSQL 19: a point read by
 * the texts alone, no digest named, delivers the one reference at them or none, and a use's reference, attached by the
 * texts and stated an Option, which the types admit as at most one row per use, is delivered as the reference at its
 * texts or none: the texts determine their digests, so they key the relation as the digests do, a text at its byte
 * bound among them.
 *
 * Oracle: the specification, the reference at the asked texts, if one is, over the stored facts
 * (generated-key.fixtures.ts byTextsExpected, usesExpected).
 *
 * Features: a point read finding its reference and finding none, a use whose reference is stored and one naming none,
 * and a text at its byte bound.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	byTextsExpected,
	Digests,
	digestsInstall,
	digestsTemplate,
	type Feature,
	factsOf,
	featuresOf,
	type Sketch,
	sketchGen,
	useText,
	usesExpected
} from "#test/pg/reads/generated-key.fixtures.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** A point read by a digest key's texts finds at most the one reference at them, and a use's reference attached by them is an Option of it. */
export const aPointReadByTheTextsOfADigestKeyFindsAtMostTheOneReferenceAtThemAndAUsesReferenceIsAnOptionOfIt =
	property.explore(sketchGen, {
		needs: { fixture: Substrate.fresh(digestsTemplate) },
		situations: [
			"a point read finding its reference",
			"a point read finding none",
			"a use whose reference is stored",
			"a use naming no reference",
			"a text at its byte bound"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ fixture }, c: Case<Feature>) =>
			(s: Sketch) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(Digests, {}, digestsInstall, taken)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									yield* db.workload.load.once({ params: {}, facts: { insert: factsOf(s) } })
									const found = yield* db.workload.byTexts.once({
										params: { pkg: s.asked.pkg, path: s.asked.path },
										facts: {}
									})
									const foundRows: ReadonlyArray<{ readonly id: number; readonly note: number }> =
										Arr.map(Arr.fromIterable(found), (r) => ({ id: r.id, note: r.note }))
									assert.deepEqual(
										foundRows,
										byTextsExpected(s),
										"the point read finds the reference at the asked texts, or none"
									)
									const uses = yield* db.workload.uses.once({ params: {}, facts: {} })
									const delivered: ReadonlyArray<string> = Arr.sort(
										Arr.map(Arr.fromIterable(uses), (u) =>
											useText(
												u.n,
												Option.map(u.ref, (r) => ({ id: r.id, note: r.note }))
											)
										),
										Order.String
									)
									assert.deepEqual(
										delivered,
										usesExpected(s),
										"each use's reference is the one at its texts, or none"
									)
									for (const feature of featuresOf(s)) {
										c.note(feature)
									}
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the reference at the asked texts, if one is, over the stored facts (generated-key.fixtures.ts byTextsExpected, usesExpected)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\t\t\t\t\t\t\t\t\t\t...reading.generated.map(generationDetermines)\n",
				replacement: "",
				why: "The engine states no generated field's dependency (logical/props.ts logicalPropsOf, Base), so a use's reference by the texts is many rows to it and delivered as a list, not the Option the types state."
			}
		]
	})
