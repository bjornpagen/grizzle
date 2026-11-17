/**
 * A write's caller parameters admitted before any of its statements runs, against PostgreSQL 19.
 *
 * Every write's flight begins with its admission (write/admission/statement.ts): one statement binding every caller
 * parameter whose type PostgreSQL checks beyond its base, each cast as its statements cast it, so PostgreSQL refuses a
 * value outside its type as it binds that statement, before the strata run. Without it a parameter is checked only at
 * the Bind of the first statement that reads it, and a statement before that one may fail first, under another law.
 *
 * The box: Admit stores two items. Each of its two writes is two strata (ChangeSet.sequence): the first inserts the
 * items of the relation parameter `fresh`, which collides with a stored item's key or not, so the first stratum fails or
 * not; the second reads a parameter of Code, ^[a-z]{1,4}$, that no statement of the first reads:
 *
 * - `picked` inserts into Pick each stored item with the scalar parameter `p` as its code;
 * - `listed` inserts into Pick the one fact of the relation parameter `named`, the second stored item with its code.
 *
 * Each case draws the write, whether the first stratum collides, and the code, inside Code or outside it. The oracle
 * restates the pattern and the key: a code outside Code is refused at bind as ParamRejected, a `paramRejected`
 * CallError whose `param` is the parameter's place (`p`, or `named`'s field `code`), whatever the first stratum does,
 * and nothing is written; otherwise a collision is refused by Item's key; otherwise the write is accepted, Pick holding
 * exactly the facts it names.
 *
 * Features: a scalar parameter, and a relation parameter's field, read only by a statement after one that fails; each
 * write refused by the first stratum's key with its code inside Code, and accepted.
 *
 * Two variants a write cannot state, which the admission checks all the same: a parameter read only by a statement the
 * runtime skips (runtime/write/steps.ts skipWhenEmpty), one whose enumerated input holds no fact (write/insert/input.ts
 * skipWhenEmptyOf), which reads that input and no caller parameter; and a refined take bound, since a bound is an
 * integer the checker refuses to type by a contract or a pattern beside it (check/params.ts ParamCell.use).
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { ParamPlace } from "#compiler/core/identity.ts"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import {
	Admit,
	caseGen,
	collidingItem,
	type Feature,
	freshId,
	freshItem,
	isCode,
	stored,
	admitInstall,
	admitTemplate
} from "#test/pg/parameters/admission.fixtures.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import { assert, assertVariant } from "#test/support/assert.ts"
import { answered } from "#test/support/calls.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** A write's parameters admitted before its statements, against PostgreSQL 19 a parameter outside its type is refused as its type refuses it, whatever a statement before its first reader does. */
export const aWritesParametersAdmittedBeforeItsStatementsAgainstPostgreSQL19AParameterOutsideItsTypeIsRefusedAsItsTypeRefusesItWhateverAStatementBeforeItsFirstReaderDoes =
	property.explore(caseGen, {
		needs: { fixture: Substrate.seat(admitTemplate) },
		situations: [
			"a scalar parameter read only by a statement after one that fails",
			"a relation parameter's field read only by a statement after one that fails",
			"picked refused by the first stratum's key",
			"picked accepted",
			"listed refused by the first stratum's key",
			"listed accepted"
		] satisfies ReadonlyArray<Reached<Feature>>,
		/** Its pre-conversion budget: runs 40, coverage cases 40 (admission.test.ts at 4fbc3e95). */
		budget: { runs: 40, steered: 40 },
		check:
			({ fixture }, c: CaseOf<Feature>) =>
			(k) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const s = yield* Substrate
							const o = yield* openedIn(Admit, { Item: [...stored] }, admitInstall, taken)
							const names = o.installed.installation.names
							const table = (r: string) => printObjectName(names.relation(r))
							const itemId = quoteIdent(names.column("Item", "id"))
							/** The installation as it was installed: Pick empty, Item its two stored items. */
							const reset = Effect.forEach(
								[
									`DELETE FROM ${table("Pick")}`,
									`DELETE FROM ${table("Item")} WHERE ${itemId} = '${freshId}'::uuid`
								],
								(sql) => s.admin.query(sql, []),
								{ discard: true }
							)
							/** Each row Pick holds, its item and its code, in code point order. */
							const written = Effect.map(
								s.admin.queryValues(
									`SELECT ${quoteIdent(names.column("Pick", "item"))}::text, ${quoteIdent(names.column("Pick", "code"))}::text FROM ${table("Pick")}`,
									[]
								),
								(rows) =>
									Arr.sort(
										Arr.map(rows, (row) => Arr.join(Arr.map(row, String), " ")),
										Str.Order
									)
							)
							return yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})

								yield* reset
								const fresh = [k.collides ? collidingItem : freshItem]
								const named = stored[1].id
								const applied = yield* Effect.result(
									answered(
										k.write === "picked"
											? db.workload.picked.once({ params: { fresh, p: k.code }, facts: {} })
											: db.workload.listed.once({
													params: { fresh, named: [{ item: named, code: k.code }] },
													facts: {}
												})
									)
								)
								const param: ParamPlace =
									k.write === "picked"
										? { kind: "scalar", name: "p" }
										: { kind: "field", name: "named", field: "code" }
								if (!isCode(k.code)) {
									if (Result.isSuccess(applied)) {
										return assert.fail(
											`a code outside its pattern is refused at bind, not answered ${applied.success.kind}`
										)
									}
									const refused = applied.failure
									assertVariant(refused, "kind", "paramRejected", "refused at bind")
									assert.deepEqual(refused.param, param, "the refusal names the parameter's place")
									const unwritten = yield* written
									assert.deepEqual(unwritten, [], "nothing is written")
									if (k.collides) {
										c.note(
											k.write === "picked"
												? "a scalar parameter read only by a statement after one that fails"
												: "a relation parameter's field read only by a statement after one that fails"
										)
									}
									return
								}
								if (Result.isFailure(applied)) {
									return assert.fail(`the write answers, not ${Formatter.format(applied.failure)}`)
								}
								const answer = applied.success
								if (k.collides) {
									if (answer.kind !== "refused") {
										return assert.fail(
											`a stored item inserted again is refused, not ${answer.kind}`
										)
									}
									assert.deepEqual(
										Arr.map(refusedLaws(answer.refused), (law) => law.kind),
										["primaryKey"],
										"refused by Item's key"
									)
									c.note(`${k.write} refused by the first stratum's key`)
									return
								}
								assert.equal(answer.kind, "accepted", "the write is accepted")
								const rows = yield* written
								assert.deepEqual(
									rows,
									Arr.sort(
										k.write === "picked"
											? Arr.map(
													[...Arr.map(stored, (i) => i.id), freshId],
													(id) => `${id} ${k.code}`
												)
											: [`${named} ${k.code}`],
										Str.Order
									),
									"Pick holds the facts the write names"
								)
								c.note(`${k.write} accepted`)
							}).pipe(Effect.scoped, withLayer(o.served.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "each type restated over the bound value, then Item's key over the first stratum's item, then the items the write names"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/program/compile.ts",
				original: "\tconst admission = buildAdmission(lowering.w, callerParams(frontend.params))",
				replacement: "\tconst admission: ReturnType<typeof buildAdmission> = undefined",
				why: "A write places no admission (write/program/compile.ts), so a code outside its pattern after a colliding first stratum is refused by Item's key instead."
			}
		]
	})
