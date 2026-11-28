/**
 * A ChangeSet's enumerated members travel as arrays, one placeholder per column, whatever their count
 * (lower/shapes/relparam): an input drawn up to a quarter of a million facts binds every statement with no refusal,
 * each member array carrying every fact. No bound smaller than PostgreSQL's longest message and V8's longest string
 * refuses an input, and those two are met by inputs far past what a unit test builds. Every label holds
 * a quote, a backslash and braces, which an array literal escapes.
 *
 * Oracle: the bounds' statement (a specification): only messageMaxBytes and maxStringLength refuse an input, and each
 * member array carries every fact. Features: a few facts, a hundred thousand or more.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { paramArrayElements } from "#test/support/arrays.ts"
import { succeeded } from "#test/support/assert.ts"
import { parsedOf } from "#test/support/unit/write/changeset/fixtures.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	type CountFeature,
	fact,
	factCount,
	Item,
	program,
	Shop
} from "#test/unit/lower/shapes/relparam.fixtures.ts"

/**
 * A write's enumerated members lower to arrays, and an input of any count binds every statement with no refusal, each
 * array carrying every fact.
 *
 * Budget: 2 runs and 6 steered cases, what its suite stated before it became a property
 * (test/unit/lower/shapes/relparam.test.ts:66 at 8cad5bce, its runs and its coverage's cases).
 */
export const aWritesEnumeratedMembersLowerToArraysAndAnInputOfAnyCountBindsEveryStatementWithNoRefusalEachArrayCarryingEveryFact =
	property.explore(factCount, {
		needs: {},
		budget: { runs: 2, steered: 6 },
		situations: ["a few facts", "a hundred thousand facts or more"] satisfies ReadonlyArray<
			Reached<CountFeature>
		>,
		check: (_, c: Case<CountFeature>) => (sketch) =>
			Effect.sync(() => {
				const rows = ((count) => upTo(count, fact))(sketch)

				c.note(rows.length >= 100_000 ? "a hundred thousand facts or more" : "a few facts")
				const changes = ChangeSet.empty(Shop).insert(Item, rows)
				const compiled = program(changes)
				const members = collectInputs(compiled.binding.groups, parsedOf(changes).inputs)
				const flight = flightOf(servableWrite(compiled), compiled.frontend.codes, noAdvice)
				const bound = succeeded(
					bindWrite(flight, { members, params: {}, transport: inForce(bindFrame) })
				)
				if (bound.kind !== "bound") {
					return assert.fail(`the input binds, not ${bound.kind}`)
				}
				let arraysSent = 0
				for (const s of flight.statements) {
					if (bound.skip.has(s.index)) {
						continue
					}
					const form = bound.form(s)
					const params = succeeded(bound.values(s))
					assert.equal(params.length, form.paramSlots.length)
					for (const [i, slot] of form.paramSlots.entries()) {
						if (slot.kind !== "member") {
							continue
						}
						arraysSent += 1
						const elements = paramArrayElements(Option.getOrThrow(Arr.get(params, i)))
						assert.equal(elements.length, rows.length, `placeholder ${i + 1} carries every fact`)
					}
				}
				assert.ok(
					arraysSent >= Rec.keys(Item.fields).length,
					`${arraysSent} member arrays sent, one per column`
				)
			}),
		oracle: {
			kind: "specification",
			name: "an input is bounded by messageMaxBytes and maxStringLength alone, and its arrays carry every fact"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/codec/recordset.ts",
				original:
					"\t\tcolumnLiteral(input, column, facts, (fact) => codec.text(fact[column]), maxStringLength)",
				replacement:
					"\t\tcolumnLiteral(input, column, facts, (fact) => codec.text(fact[column]), facts.length > 65_535 ? 0 : maxStringLength)",
				why: "A member column of more than 65,535 facts is refused by an invented bound, its array's longest literal taken as zero; the search fails."
			}
		]
	})
