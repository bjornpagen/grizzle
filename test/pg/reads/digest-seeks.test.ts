/**
 * A read that binds a text of no byte bound by equality seeks by the text's declared digest and rechecks the text, on
 * PostgreSQL 19, whatever way the text reaches its equality (docs/limits.md "Keys and indexes"): T(k, g, t, t2) keyed by k, its
 * two texts of no byte bound each declaring its SHA-256, `h` and `h2`, and S(s, u) keyed by s, read by fifteen reads
 * that state a text of T equal to a value: a match's literal or parameter, a where's equality with a parameter of T's
 * text type or of another, a membership, an equality with S's text and one variable S's text and T's bind, a negation's
 * literal and parameter, a parameter through a query that delivers the text and its digest, and, by the digest's
 * lineage (check/carry.ts), through queries that deliver the text and never its digest: a parameter through one, a
 * literal through two (pantry's testPartRows over attributeValues, the ledger's three refused reads), one variable S's
 * text and two such queries bind (pantry's branch target, its two refused law probes), and a negation that correlates
 * S's text with T's or with such a query's. Every read installs, each seeking T by the digest of the value its text is
 * equated with (test/unit/physical/digest-seeks.test.ts proves the index), and delivers the rows the model does.
 *
 * Oracle: the specification, each rule restated over the stored facts, its texts compared as texts and never their
 * digests (digest-seeks.fixtures.ts `expected`).
 *
 * Features: a long text sought and found, two long texts that differ past a B-tree entry, a negation that drops a row
 * and one that keeps a row, and a join through queries that finds a row.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	Digests,
	digestReadsInstall,
	digestReadsTemplate,
	expected,
	type Feature,
	factsOf,
	featuresOf,
	type Sketch,
	sketchGen
} from "#test/pg/reads/digest-seeks.fixtures.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** Rows of T as the model compares them: `k/g`, in order. */
const tRows = (rows: Iterable<{ readonly k: number; readonly g: number }>): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(Arr.fromIterable(rows), (r) => `${r.k}/${r.g}`),
		Order.String
	)

/** Keys of S as the model compares them, in order. */
const sKeys = (rows: Iterable<{ readonly s: number }>): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(Arr.fromIterable(rows), (r) => String(r.s)),
		Order.String
	)

/** A read that binds a text of no byte bound by equality, through a match, a where, a join, a negation or queries that never deliver its digest, delivers the rows its rule states over the stored texts. Its budget is the runner's: a new property, with no suite before it to carry a count from. */
export const aReadThatEquatesATextOfNoByteBoundWithAValueDeliversItsRuleRowsSeekingByTheTextsDigest =
	property.explore(sketchGen, {
		needs: { fixture: Substrate.fresh(digestReadsTemplate) },
		situations: [
			"a long text sought and found",
			"two long texts that differ past a B-tree entry",
			"a negation that drops a row",
			"a negation that keeps a row",
			"a join through queries that finds a row"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ fixture }, c: Case<Feature>) =>
			(s: Sketch) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(Digests, {}, digestReadsInstall, taken)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									const w = db.workload
									yield* w.load.once({ params: {}, facts: { insert: factsOf(s) } })
									const model = expected(s)
									const at = { t: s.t }
									const delivered = yield* Effect.all({
										literal: Effect.map(w.literal.once({ params: {}, facts: {} }), tRows),
										parameter: Effect.map(w.parameter.once({ params: at, facts: {} }), tRows),
										equality: Effect.map(w.equality.once({ params: at, facts: {} }), tRows),
										otherType: Effect.map(
											w.otherType.once({ params: { w: s.w }, facts: {} }),
											tRows
										),
										membership: Effect.map(w.membership.once({ params: {}, facts: {} }), tRows),
										joined: Effect.map(w.joined.once({ params: { s: s.s }, facts: {} }), tRows),
										shared: Effect.map(w.shared.once({ params: { s: s.s }, facts: {} }), tRows),
										negatedLiteral: Effect.map(
											w.negatedLiteral.once({ params: {}, facts: {} }),
											sKeys
										),
										negatedParameter: Effect.map(
											w.negatedParameter.once({ params: at, facts: {} }),
											sKeys
										),
										imported: Effect.map(w.imported.once({ params: at, facts: {} }), tRows),
										carriedParameter: Effect.map(
											w.carriedParameter.once({ params: at, facts: {} }),
											tRows
										),
										carriedLiteral: Effect.map(
											w.carriedLiteral.once({ params: {}, facts: {} }),
											tRows
										),
										carriedJoin: Effect.map(
											w.carriedJoin.once({ params: { s: s.s }, facts: {} }),
											tRows
										),
										correlatedNegation: Effect.map(
											w.correlatedNegation.once({ params: {}, facts: {} }),
											sKeys
										),
										carriedNegation: Effect.map(
											w.carriedNegation.once({ params: {}, facts: {} }),
											sKeys
										)
									})
									assert.deepEqual(
										delivered,
										model,
										"each read delivers the rows its rule states over the stored texts"
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
			name: "each read's rule restated over the stored facts, its texts compared as texts and never their digests (digest-seeks.fixtures.ts expected)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/carry.ts",
				original: "\t\tconst column = digests(source.name).get(text)",
				replacement: "\t\tconst column = [...digests(source.name).values()][0]",
				why: "A query carries the first digest its relation declares, whatever text it copies: a read of T's second text t2 through queries that deliver it without its digest seeks by h, t's digest, at the SHA-256 of the value t2 is equated with, and delivers the rows whose t holds that value, or keeps the rows of S a row's t matches."
			}
		]
	})
