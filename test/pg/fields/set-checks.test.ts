/**
 * A set compared with a set value in a row check, on PostgreSQL 19: `Compute.disjoint` and `Compute.subset` take a
 * set value of the first operand's roster (Bits.of) as their second operand, a literal that takes the set's type, so its
 * bits are its handles' codes, and the installed CHECK holds a row exactly when the set algebra over its handles does.
 *
 * The box: every set over a roster of three handles, written as one row of R, whose checks hold its flags apart from
 * {a}, within {a, b}, and within one side, {a, b} or {b, c}, so a and c together break all three. The model restates
 * the checks over plain Sets: a row is accepted exactly when its flags hold every one; otherwise the write is refused naming `every` check the flags break, each once, in the schema's canonical order
 * of its laws, whichever CHECK PostgreSQL tried first, its witness the row's key. A query reads an accepted row back
 * through the same algebra against set values, whether its flags miss b and their union with {c}, which the model
 * computes over plain Sets.
 *
 * Features: a row accepted, and a row breaking each check alone and with others.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Layer, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import { Bits } from "#compiler/public/fields.ts"
import {
	allSets,
	Flag,
	restated,
	Sets,
	setsInstall,
	setsTemplate,
	type Situation,
	situationOf
} from "#test/pg/fields/set-checks.fixtures.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import { answered, rowsOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A row check over a set and a set value holds a row exactly when its flags are disjoint from and a subset of the set values, and a refusal names every check they break, all three at once included, for every set over the roster. */
export const aRowCheckOverASetAndASetValueHoldsARowExactlyWhenItsFlagsAreDisjointFromAndASubsetOfTheSetValuesAndARefusalNamesEveryCheckTheyBreakAllThreeAtOnceIncludedForEverySetOverTheRoster =
	property.exhaust(allSets, {
		box: "every set over the roster's three handles",
		needs: { sets: Substrate.seat(setsTemplate) },
		situations: [
			"accepted",
			"refused by Apart",
			"refused by Within",
			"refused by several checks"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ sets }, c: Case<Situation>) =>
			(flags) =>
				Effect.scoped(
					Effect.gen(function* () {
						const taken = yield* sets
						const o = yield* openedIn(Sets, {}, setsInstall, taken)
						const s = taken.substrate
						const names = namesOf(o.installed)
						return yield* Effect.gen(function* () {
							const db = yield* Db.open(o.served.login.roles.app, {})
							yield* replaceRows(s.admin, installationGroup(names), [])
							const outcome = yield* answered(
								db.workload.write.once({
									params: {},
									facts: { insert: { R: [{ id: 1, flags: Bits.of(Flag, flags) }] } }
								})
							)
							const held = new Set(flags)
							const broken = Arr.filter(restated, (r) => !r.holds(held))
							const brokenLaws = new Set(Arr.map(broken, (r) => names.lawOf(r.statement)))
							const named = Arr.flatMap(names.model.theory.laws, (law) =>
								brokenLaws.has(law.id) ? [names.described(law.id)] : []
							)
							if (!Arr.isReadonlyArrayNonEmpty(named)) {
								assert.equal(outcome.kind, "accepted", `${Formatter.format(flags)} is accepted`)
								const read = yield* rowsOf(db.workload.readBack.once({ params: {}, facts: {} }))
								assert.deepEqual(
									Arr.map(read, (row) => ({
										apart: row.apart,
										joined: Arr.sort(Arr.fromIterable(row.joined), Order.String)
									})),
									[
										{
											apart: !flags.includes("b"),
											joined: Arr.sort(Arr.dedupe([...flags, "c" as const]), Order.String)
										}
									],
									"the query's set algebra against set values agrees with the model's"
								)
								c.note(situationOf(broken))
								return
							}
							const refusal = `${Formatter.format(flags)} is refused naming every check it breaks, each once, in canonical order`
							assert.ok(outcome.kind === "refused", refusal)
							assert.equal(outcome.refused.kind, "every", refusal)
							assert.deepEqual(refusedLaws(outcome.refused), named, refusal)
							assert.deepEqual(
								outcome.witness,
								{ kind: "key", relation: "R", values: { id: 1 } },
								refusal
							)
							c.note(situationOf(broken))
						}).pipe(
							(body) =>
								Effect.flatMap(Layer.build(o.served.layer), (context) =>
									Effect.provideContext(body, context)
								),
							Effect.scoped
						)
					})
				),
		oracle: {
			kind: "specification",
			name: "the checks' set algebra restated over each set of the roster's handles"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/expr/ops.ts",
				original:
					'\t\t\treturn binary("=", call("bit_count", [without]), lit.int(0n, types.bigint))',
				replacement:
					'\t\t\treturn binary("=", call("bit_count", [binary("&", b, { kind: "complement", expr: a })]), lit.int(0n, types.bigint))',
				why: "subset lowers as b ⊆ a."
			},
			{
				file: "packages/engine/src/runtime/write/witness.ts",
				original:
					"\tconst [head, ...rest] = concatNonEmpty(broken.flatMap(statedLaws), statedLaws(refusing))",
				replacement: "\tconst [head, ...rest] = concatNonEmpty([], statedLaws(refusing))",
				why: "A refusal names only the CHECK PostgreSQL reported, as one did before a refused CHECK named every law its row breaks (runtime/write/witness.ts brokenLaws)."
			},
			{
				file: "packages/engine/src/runtime/write/witness.ts",
				original: "\t\tsortNonEmpty(once, (a, b) => order(a.law.law) - order(b.law.law)),",
				replacement: "\t\tsortNonEmpty(once, (a, b) => order(b.law.law) - order(a.law.law)),",
				why: "A refusal names the broken checks against the canonical order of the schema's laws (runtime/write/witness.ts brokenLaws)."
			}
		]
	})
