/**
 * A contract's values through a served Db on PostgreSQL 19 (contract-host.fixtures.ts): Held holds one contract over
 * each kind of column a contract's host reads, a bigint and a numeric converted by their carriers, a pattern's text, a
 * closed id read by its roster's names, and a uuid, each value its key's mint's.
 *
 * A case draws one to four holdings, each value at its type's edges, an amount below zero among them, which Amount's
 * predicate refuses. Every holding is written in one insert, its values minted from the drawn ones. Where every amount
 * is one Amount admits, the write is accepted, every holding reads back exactly as written, each value the one its mint
 * was given, and a parameter of Amount finds the ids of its amount; where one is below zero, the database refuses the
 * write, as it checks every contract's predicate, and no holding is stored.
 *
 * Oracle: the drawn values, which a round trip through PostgreSQL returns as they are (exactValue), and Amount's
 * predicate, which refuses a negative amount.
 *
 * Features: an amount Amount refuses, every amount it admits, several holdings in one insert.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Layer, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	factOf,
	type Feature,
	type Holding,
	Holdings,
	holdingsInstall,
	holdingsTemplate,
	notes,
	space
} from "#test/pg/fields/contract-host.fixtures.ts"
import { rowsOf, writeAnswerOf } from "#test/support/calls.ts"
import { exactValue } from "#test/support/equivalence.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const byId = Order.mapInput(Order.Number, (row: { readonly id: number }) => row.id)

/**
 * A contract's value its key's mint made is written and read back exactly, a parameter of the contract finds its row,
 * and the database refuses a value its predicate refuses.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aContractsMintedValueRoundTripsAndItsPredicateRefusesTheRest = property.explore(
	space,
	{
		needs: { fixture: Substrate.fresh(holdingsTemplate) },
		situations: [
			"an amount Amount refuses",
			"every amount Amount admits",
			"several holdings in one insert"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ fixture }, c: Case<Feature>) =>
			(holdings: Arr.NonEmptyReadonlyArray<Holding>) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.scoped(
							Effect.gen(function* () {
								for (const feature of notes(holdings)) {
									c.note(feature)
								}
								const o = yield* openedIn(Holdings, {}, holdingsInstall, taken)
								const facts = Arr.map(holdings, factOf)
								yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									const outcome = yield* writeAnswerOf(
										db.workload.store.once({ params: {}, facts: { insert: { Held: facts } } })
									)
									const read = yield* rowsOf(db.workload.held.once({ params: {}, facts: {} }))
									const stored = Arr.sort(read, byId)
									if (Arr.some(holdings, (h) => h.amount < 0n)) {
										assert.equal(
											outcome._tag,
											"refused",
											"Amount's predicate refuses a negative amount"
										)
										assert.deepEqual(stored, [], "a refused write stores no holding")
										return
									}
									assert.equal(outcome._tag, "accepted", "every minted holding is written")
									assert.ok(
										exactValue(stored, facts),
										"every holding reads back as written, each value the one its mint was given"
									)
									for (const fact of facts) {
										const found = yield* rowsOf(
											db.workload.byAmount.once({ params: { amount: fact.amount }, facts: {} })
										)
										assert.deepEqual(
											Arr.sort(
												Arr.map(found, (row) => row.id),
												Order.Number
											),
											Arr.flatMap(facts, (f) => (f.amount === fact.amount ? [f.id] : [])),
											"a parameter of Amount finds the ids of its amount"
										)
									}
								}).pipe(
									(body) =>
										Effect.flatMap(Layer.build(o.served.layer), (context) =>
											Effect.provideContext(body, context)
										),
									Effect.scoped
								)
							})
						),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "the drawn values, returned as they are by a round trip through PostgreSQL, and Amount's predicate"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/brand.ts",
				original: '\tif (typeof key !== "symbol") {',
				replacement: '\tif (typeof key === "symbol") {',
				why: "A mint refuses its module's own key, so no contract's value is ever made: the module that declares Held's contracts fails as it loads, and no holding is written."
			},
			{
				file: "packages/engine/src/core/brand.ts",
				original: "\t\thosted<A, K>(value)\n\t\treturn value",
				replacement: "\t\thosted<A, K>(value)\n\t\treturn undefined",
				why: "A mint loses the value it was given, so every minted amount, code, price, tone and account is undefined: no holding is written as drawn, and none reads back."
			}
		]
	}
)
