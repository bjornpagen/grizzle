/**
 * The executor's leak scan, the oracle every worlds suite's "no hidden value" rests on, held to real refusals with a
 * planted hidden value: a value a refusal does spell, named hidden, is reported as a leak in the field that spells it,
 * whatever the refusal's shape. Over the documents installation (model/bases/docs.ts) and a drawn reality, a case
 * plants one value in one refusal:
 * - a direct writer acting as its login, which holds no table, sends a statement on a relation's table (a select, an
 *   insert, a delete, an update or a truncate), which PostgreSQL refuses with 42501 naming the table in its message;
 * - the admin, a direct writer that took on a role holding the relation whole, inserts a stored fact again, which
 *   PostgreSQL refuses with 23505 naming the fact's key values in its DETAIL, on a relation whose key it shows the
 *   admin (session/catalog.ts keyShown): on a table under row security it omits the DETAIL, whatever the role's
 *   policy, so that refusal spells no value to plant;
 * - the admin's Db inserts a stored document's id with another owner and a word count its organization's documents
 *   leave free, which grizzle answers invariant-rejected on the primary key alone, its witness the submitted id.
 * The table, the key value or the id is the planted value: a scan that stopped reading a field, or read it under
 * another name, would let a real leak pass every suite unseen.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, Option } from "effect"
import {
	actionsOf,
	cases,
	docsWorld,
	leakCases,
	plantedTokens,
	type Reported,
	situations
} from "#test/pg/world-model/execute.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { templateWorld } from "#test/support/worlds/execute/template.ts"

/**
 * The leak scan reports every hidden value a refusal spells, in the field that spells it, each case on a fresh clone of
 * the documents world of its own (Substrate.freshOf), reset to its reality.
 *
 * Its pre-conversion budget: runs 21, coverage cases 84 (test/pg/world-model/execute.test.ts at 10a0cd919).
 */
export const theLeakScanReportsEveryHiddenValueARefusalSpellsInTheFieldThatSpellsIt =
	property.explore(leakCases, {
		needs: { docs: Substrate.freshOf(docsWorld) },
		situations: situations satisfies ReadonlyArray<Reached<Reported>>,
		check:
			({ docs }, c: Case<Reported>) =>
			({ reality, planted }) =>
				Effect.scoped(
					Effect.gen(function* () {
						const taken = yield* docs
						const world = yield* templateWorld(taken, Option.none())
						yield* world.reset(reality)
						const expected = plantedTokens(planted, world.names.tables)
						const [opening, refused] = actionsOf(planted)
						const opened = yield* world.perform(opening, new Set())
						assert.equal(opened.kind, "opened", "the session the refusal comes through opens")
						const observed = yield* world.perform(refused, expected.tokens)
						if (observed.kind !== "leak") {
							return assert.fail(
								`${Formatter.format(refused)} answered ${Formatter.format(observed)}, and the scan reported none of the planted values`
							)
						}
						assert.equal(
							observed.field,
							expected.field,
							"the scan reports the field that spells it"
						)
						assert.ok(expected.tokens.has(observed.token), "the scan reports a planted value")
						c.note(expected.reported)
					})
				),
		oracle: {
			kind: "specification",
			name: "the planted value: a refusal that spells it is a leak, in the field that spells it"
		},
		show: Formatter.format,
		budget: { runs: cases, steered: 4 * cases },
		kept: [],
		kills: []
	})
