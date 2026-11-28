/**
 * The set algebra over a drafted bits domain keeps every padding bit 0, on PostgreSQL 19. A set over a roster of n
 * codes is bit(m), m the codes rounded up to whole bytes, and its domain's CHECK holds every bit past the last
 * code at 0; so every set grizzle computes must leave those bits clear, or the CHECK refuses the write with 23514.
 *
 * Each case installs a roster of 1 to 9 codes, so every padding of 0 to 7 bits is met, a closed relation C over pairs
 * of its codes, and a relation R holding two drawn sets a and b and a code k, whose generated columns are a ∪ b, a ∩ b,
 * a − b, the complement of a within the roster ((a ∪ the full set's literal) − a, the complement masked by the
 * roster's full set), and C.row(k), each cast to the bits domain by its column. The writes are drawn rows of R, which must all
 * be accepted: the domain's CHECK never fires on a value grizzle computed. A query reads each row back, its stored
 * columns and the same union and difference computed in the query, which must equal the host model's sets; and every
 * stored set's text must be the model's positional text at m bits (test/support/closed/bit-text.ts setText), so a bit
 * past the last code reads 0 wherever it lies.
 *
 * Oracle: the host model, plain Sets of codes, and the test oracle's positional text of each.
 *
 * Features: the vocabulary Feature below, each padding width a roster meets.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Layer, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import { Bit } from "#compiler/public/fields.ts"
import {
	space,
	codesOf,
	type Drawn,
	type Feature,
	handleOf,
	padFeature,
	schemaOf,
	sorted
} from "#test/pg/fields/set-padding.fixtures.ts"
import { writeAnswerOf, rowsOf } from "#test/support/calls.ts"
import { setText, setWidth } from "#test/support/closed/bit-text.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { installed } from "#test/support/pg/reads/support.ts"
import { ownerSession, Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** The set algebra over a drafted bits domain computes every set with its padding bits 0, accepted by the domain and read back as the model's. */
export const theSetAlgebraOverADraftedBitsDomainComputesEverySetWithItsPaddingBits0AcceptedByTheDomainAndReadBackAsTheModels =
	property.explore(space, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"one pad bit",
			"two pad bits",
			"three pad bits",
			"four to seven pad bits",
			"no pad bit",
			"an empty set computed",
			"a full set computed"
		] satisfies ReadonlyArray<Reached<Feature>>,
		/** Its pre-conversion budget: runs 12, coverage cases 16 (set-padding.test.ts at 4fbc3e95). */
		budget: { runs: 12, steered: 16 },
		check:
			({ substrate }, c: Case<Feature>) =>
			(d: Drawn) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const { S, R, Sets, programs } = schemaOf(d)
							const o = yield* installed(Sets, {}, { label: "setpadding", programs })
							const s = yield* Substrate
							const names = namesOf(o.installed)
							const all = Array.from({ length: d.size }, (_, code) => code)
							const model = Arr.map(d.rows, (row, id) => {
								const a = new Set(row.a)
								const b = new Set(row.b)
								return {
									id,
									a: sorted(row.a),
									b: sorted(row.b),
									u: sorted([...row.a, ...row.b]),
									i: sorted(Arr.filter(row.a, (x) => b.has(x))),
									d: sorted(Arr.filter(row.a, (x) => !b.has(x))),
									e: sorted(Arr.filter(all, (x) => !a.has(x))),
									w: sorted(Arr.filter(all, (to) => d.pairs[row.k * d.size + to] === true))
								}
							})
							yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								const outcome = yield* writeAnswerOf(
									db.workload.write.once({
										params: {},
										facts: {
											insert: {
												R: Arr.map(d.rows, (row, id) => ({
													id,
													k: handleOf(row.k),
													a: Bit.of(S, Arr.map(row.a, handleOf)),
													b: Bit.of(S, Arr.map(row.b, handleOf))
												}))
											}
										}
									})
								)
								assert.equal(
									outcome.kind,
									"accepted",
									`every computed set meets the domain: ${Formatter.format(d)}`
								)
								const read = yield* rowsOf(db.workload.sets.once({ params: {}, facts: {} }))
								assert.deepEqual(
									Arr.sort(
										Arr.map(read, (row) => ({
											id: row.id,
											u: codesOf(row.u),
											i: codesOf(row.i),
											d: codesOf(row.d),
											e: codesOf(row.e),
											w: codesOf(row.w),
											qu: codesOf(row.qu),
											qd: codesOf(row.qd)
										})),
										Order.mapInput(Order.Number, (row: { readonly id: number }) => row.id)
									),
									Arr.map(model, (m) => ({
										id: m.id,
										u: m.u,
										i: m.i,
										d: m.d,
										e: m.e,
										w: m.w,
										qu: m.u,
										qd: m.d
									})),
									"every stored and queried set is the model's"
								)
							}).pipe(
								(body) =>
									Effect.flatMap(Layer.build(o.served.layer), (context) =>
										Effect.provideContext(body, context)
									),
								Effect.scoped
							)
							const columns = ["a", "b", "u", "i", "d", "e", "w"] as const
							const owner = yield* s.session(ownerSession())
							const stored = yield* owner.values(
								`SELECT ${Arr.join(
									Arr.map(columns, (f) => `${names.column(R, f)}::text`),
									", "
								)} FROM ${names.table(R)} ORDER BY ${names.column(R, "id")}`,
								[]
							)
							assert.deepEqual(
								Arr.map(stored, (row) => Arr.map(row, (cell) => String(cell))),
								Arr.map(model, (m) => Arr.map(columns, (f) => setText(d.size, m[f]))),
								"every stored set is the model's positional text, its padding 0"
							)
							c.note(padFeature(setWidth(d.size) - d.size))
							if (
								Arr.some(model, (m) => m.d.length === 0 || m.i.length === 0 || m.e.length === 0)
							) {
								c.note("an empty set computed")
							}
							if (Arr.some(model, (m) => m.u.length === d.size || m.e.length === d.size)) {
								c.note("a full set computed")
							}
						})
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "second-implementation",
			name: "plain Sets of codes, and the oracle's positional text of each at the domain's width"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/codes.ts",
				original: "\t\tsetBit(digits, codeOf(codec, handle))\n\t}",
				replacement:
					"\t\tsetBit(digits, codeOf(codec, handle))\n\t}\n\tsetBit(digits, digits.length * 4 - 1)",
				why: "A set's text sets its last bit, a padding bit wherever the roster's codes do not fill their last byte."
			}
		]
	})
