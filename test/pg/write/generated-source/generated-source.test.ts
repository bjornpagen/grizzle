/**
 * A query-sourced write into a relation with generated fields, against PostgreSQL 19.
 *
 * Items holds two relations of one heading, Item, closed, and Spot, open, mutable inside the unit of its id: each a key
 * `id`, four written fields (`v`, a tier, a numeral `k`, also a candidate key, and a day's text, one per numeral) and
 * four generated fields of three kinds: `copy`, the written `v` itself; `rate`, a closed read of the tier's rate, which
 * Rate holds for low and mid and not for high, so a high row's `rate` has no value; `parsed`, the numeral cast into a
 * bigint; and `when`, the day's text parsed into a date, which a generated column holds only as an IMMUTABLE
 * expression. Each case stores up to three lawful rows, then writes one to three rows, each fresh or a repeat of a
 * stored one, from a query over a relation parameter, a source the write cannot prove unique on the key: an insert into
 * Item, or an insert or a put into Spot. The write's statements request the rows' written fields alone, and a requested
 * fact's generated values are its generation expressions over them.
 *
 * The oracle is the write restated over the drawn rows: the source's rows as a set; two at one key that differ is
 * the primary key's refusal; a high row the generated `rate`'s; an insert at a stored key that differs, the primary
 * key's; two source rows, or two rows after the write, that share `k` under two keys, the candidate key's; any other
 * write is applied, the stored rows after it each source row at its key over the rows before, every generated field
 * its expression's value, accepted where it changed a row and unchanged otherwise. A refused write names one of the
 * laws it breaks and changes nothing.
 *
 * Features: each relation's insert applied, Spot's put applied, a refusal by each law, and an unchanged write.
 */

import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	appliedOf,
	caseGen,
	expectedOf,
	factOf,
	type Feature,
	Items,
	type Row,
	type Target,
	type Write,
	writtenOf,
	genqueryInstall,
	genqueryTemplate
} from "#test/pg/write/generated-source/generated-source.fixtures.ts"
import { writeAnswerOf, rowsOf } from "#test/support/calls.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A query-sourced write into generated fields, against PostgreSQL 19 an insert or a put from a query requests the written fields alone and stores every generated field's value.
 *
 * Its pre-conversion budget: runs 60, coverage cases 60 (test/pg/write/generated-source/generated-source.test.ts at d8eed1786).
 */
export const aQuerySourcedWriteIntoGeneratedFieldsAgainstPostgreSQL19AnInsertOrAPutFromAQueryRequestsTheWrittenFieldsAloneAndStoresEveryGeneratedFieldsValue =
	property.explore(caseGen, {
		needs: { fixture: Substrate.fresh(genqueryTemplate) },
		situations: [
			"Item insert applied",
			"Spot insert applied",
			"Spot put applied",
			"refused by primaryKey",
			"refused by generated",
			"refused by key",
			"an unchanged write"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ fixture }, c: CaseOf<Feature>) =>
			(k) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(Items, {}, genqueryInstall, taken)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									/** The rows of `target` as grizzle reads them. */
									const read = (target: Target) =>
										target === "Item"
											? rowsOf(db.workload.itemRows.once({ params: {}, facts: {} }))
											: rowsOf(db.workload.spotRows.once({ params: {}, facts: {} }))
									/** `rows` inserted into `target`. */
									const seed = (target: Target, rows: ReadonlyArray<Row>) =>
										target === "Item"
											? writeAnswerOf(
													db.workload.seedItem.once({
														params: {},
														facts: { insert: { Item: Arr.map(rows, writtenOf) } }
													})
												)
											: writeAnswerOf(
													db.workload.seedSpot.once({
														params: {},
														facts: { insert: { Spot: Arr.map(rows, writtenOf) } }
													})
												)
									/** The write of the case into `target` from its query over `rows`. */
									const write = (w: Write, rows: ReadonlyArray<Row>) => {
										const params = { rows: Arr.map(rows, writtenOf) }
										return w.target === "Item"
											? writeAnswerOf(db.workload.insertItem.once({ params, facts: {} }))
											: w.op === "insert"
												? writeAnswerOf(db.workload.insertSpot.once({ params, facts: {} }))
												: writeAnswerOf(db.workload.putSpot.once({ params, facts: {} }))
									}

									if (Arr.isReadonlyArrayNonEmpty(k.stored)) {
										const seeded = yield* seed(k.target, k.stored)
										assert.equal(seeded.kind, "accepted", "the stored rows are lawful")
									}
									const before: ReadonlyArray<Readonly<Record<string, unknown>>> = yield* read(
										k.target
									)
									const applied = yield* Effect.result(write(k, k.source))
									if (Result.isFailure(applied)) {
										return assert.fail(
											`a lawful schema's write is an outcome: ${applied.failure.kind}`
										)
									}
									const outcome = applied.success
									const after: ReadonlyArray<Readonly<Record<string, unknown>>> = yield* read(
										k.target
									)
									const expected = expectedOf(k)
									if (expected.kind === "refused") {
										if (outcome.kind !== "refused") {
											return assert.fail(
												`a write breaking ${Arr.join(expected.laws, ", ")} is refused, not ${outcome.kind}`
											)
										}
										const [law] = refusedLaws(outcome.refused)
										assert.ok(
											expected.laws.includes(law.kind),
											`the refusal names one of ${Arr.join(expected.laws, ", ")}, not ${Formatter.format(law)}`
										)
										unorderedEqual(after, before, "a refused write changes nothing")
										c.note(
											law.kind === "generated"
												? "refused by generated"
												: law.kind === "key"
													? "refused by key"
													: "refused by primaryKey"
										)
										return
									}
									assert.equal(
										outcome.kind,
										expected.changed ? "accepted" : "unchanged",
										"accepted where the write changed a row"
									)
									unorderedEqual(after, Arr.map(expected.rows, factOf), "the rows after the write")
									c.note(expected.changed ? appliedOf(k) : "an unchanged write")
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}).pipe(Effect.scoped),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the write restated over the drawn rows, each generated field its expression's value"
		},
		budget: { runs: 60, steered: 60 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/write/generated-source/generated-source.test.ts#aQuerySourcedWriteIntoGeneratedFieldsAgainstPostgreSQL19AnInsertOrAPutFromAQueryRequestsTheWrittenFieldsAloneAndStoresEveryGeneratedFieldsValue:-:0.1.1.1.0.0.0.0.0.0.2.0.0.0"
				),
				reason:
					"the swarm's crash: a put from a query of one row into a relation with a generated field compiled to a statement requesting the generated column from its input",
				since: "2026-11-19"
			}
		],
		kills: []
	})
