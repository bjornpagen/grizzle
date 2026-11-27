/**
 * A write's caller parameters admitted before any of its statements runs, against PostgreSQL 19.
 *
 * A write adds no statement for its admission (write/program/admission.ts): every caller parameter whose type
 * PostgreSQL checks beyond its base is bound, cast as its statements cast it, by an entry no query reads that leads each
 * statement a call may send first, its placeholders the statement's first, so PostgreSQL refuses a value outside its type
 * as it binds that statement, before the statement or any after it runs. A parameter rides every statement before the
 * first one the flight sends wherever its value may be refused (a scalar's in every call, a relation parameter's where
 * it holds a fact), and that one; where no statement is sent so, the flight's first is sent there besides. A ChangeSet of
 * reads alone holds no statement of its own, and its first read-back, the first statement its call sends, admits every
 * parameter as a query's statement does. Without it a parameter is checked only at the Bind of the first statement that
 * reads it, a statement before that one may fail first, under another law, and a parameter only a statement the
 * runtime leaves out reads, or no statement reads, is never checked.
 *
 * The box: Admit stores two items. Each of its three staged writes is two strata (ChangeSet.sequence): the first
 * inserts the items of the relation parameter `fresh`, none, one that collides with a stored item's key, or one that
 * does not, so the first stratum's statement is not sent, fails or not; the second reads a parameter of Code,
 * ^[a-z]{1,4}$, that no statement of the first reads:
 *
 * - `picked` inserts into Pick each stored item with the scalar parameter `p` as its code;
 * - `listed` inserts into Pick the one fact of the relation parameter `named`, the second stored item with its code;
 * - `guarded` inserts into Pick each item of the relation parameter `named` with `p` as its code, and every case passes
 *   `named` none, so the one statement that reads `p` is left out (runtime/write/steps.ts needs), and where `fresh` is
 *   none too, no statement is sent for the write's facts.
 *
 * A fourth, `scanned`, is a ChangeSet of reads alone: it reads back the stored items whose code is `p` under the
 * constant false filter, which leaves `p` unread, so its read-back's admission alone holds a placeholder of it.
 *
 * Each case draws the write, a staged write's first stratum's items, and the code, inside Code or outside it. The oracle
 * restates the pattern and the key: a code outside Code is refused at bind as ParamRejected, a `paramRejected` CallError
 * whose `param` is the parameter's place (`p`, or `named`'s field `code`), whatever the first stratum does, and nothing
 * is written; otherwise a collision is refused by Item's key; otherwise the write answers, Pick holding exactly the facts
 * it names, `guarded` with no items unchanged, and `scanned` unchanged, reading no item back.
 *
 * Features: a scalar parameter, and a relation parameter's field, read only by a statement after one that fails; a
 * scalar parameter read only by a statement the runtime leaves out where no other statement is sent; a scalar
 * parameter of a ChangeSet of reads alone that no statement reads; each staged write refused by the first stratum's key
 * with its code inside Code, and accepted; scanned answered.
 *
 * One variant a write cannot state, which the admission checks all the same: a refined take bound, since a bound is an
 * integer the checker refuses to type by a contract or a pattern beside it (check/params.ts ParamCell.use).
 */

import { assert, assertVariant } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { ParamPlace } from "#compiler/core/identity.ts"
import { isRecord } from "#compiler/core/record.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	Admit,
	caseSpace,
	collidingItem,
	type Feature,
	type First,
	freshId,
	freshItem,
	isCode,
	stored,
	admitInstall,
	admitTemplate
} from "#test/pg/parameters/admission.fixtures.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A write's parameters admitted before its statements, against PostgreSQL 19 a parameter outside its type is refused as its type refuses it, whatever a statement before its first reader does.
 *
 * Its budget, measured:
 *
 * @limitKind measured
 * @owner test/pg/parameters/admission.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `pnpm exec toolchain-test run test/pg/parameters/admission.test.ts` at this budget, the space before its
 *   aims (pg2.log) and with them (pg5.log), and at a steered cap of 200 before its aims (pg3.log); `pnpm exec
 *   toolchain-test kills test/pg/parameters/admission.test.ts` at this budget (kills.log); each in
 *   ~/.cache/grizzle-release/PLANONCE-P3-admit
 * @observed 2026-11-26, 19:10 to 19:50 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 450 to 530; PostgreSQL 19 in
 *   memory (the checkout's test family); Node 26.13.1; grizzle at 40bae51a8 with lane PLANONCE-P3's admission fold,
 *   vendor/toolchain at adfc2a0
 * @workload this property at the budget, then each declared kill applied alone and judged on the property's witnesses:
 *   its kept cases, its floor stream and its steered phase, which no run seed moves
 * @result with its aims every required situation was reached in 33 cases, 16 of them steered, and each of its three
 *   kills went red; drawn plainly, its floor and a steered cap of 40 reached neither a relation parameter's field after
 *   a failing statement nor guarded's left-out parameter (pg2.log), and a cap of 200 took 160 steered cases (pg3.log);
 *   with `scanned` and its two situations (lane ROWEVAL, 2026-11-27), its eleven situations were
 *   reached in 29 cases, 16 of them steered, and each of its four kills went red
 * @decision 13 runs and a steered cap of 40, the budget before guarded and the empty first stratum: each turn of the
 *   steered phase aims at a pending situation and draws a case that reaches it, so the phase stops at 16, within the cap
 * @revalidate a change of its space, aims, situations, kept cases or kills, of its label (the floor stream's seed), or
 *   of the runner's floor or steering rule
 */
export const aWritesParametersAdmittedBeforeItsStatementsAgainstPostgreSQL19AParameterOutsideItsTypeIsRefusedAsItsTypeRefusesItWhateverAStatementBeforeItsFirstReaderDoes =
	property.explore(caseSpace, {
		needs: { fixture: Substrate.fresh(admitTemplate) },
		situations: [
			"a scalar parameter read only by a statement after one that fails",
			"a relation parameter's field read only by a statement after one that fails",
			"a scalar parameter read only by a statement the runtime leaves out, no statement sent for the write's facts",
			"a scalar parameter of a ChangeSet of reads alone that no statement reads",
			"picked refused by the first stratum's key",
			"picked accepted",
			"listed refused by the first stratum's key",
			"listed accepted",
			"guarded refused by the first stratum's key",
			"guarded accepted",
			"scanned answered"
		] satisfies ReadonlyArray<Reached<Feature>>,
		budget: { runs: 13, steered: 40 },
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
								const freshOf = (first: First) =>
									first === "none" ? [] : [first === "colliding" ? collidingItem : freshItem]
								const named = stored[1].id
								const applied = yield* Effect.result(
									writeAnswerOf(
										k.write === "scanned"
											? db.workload.scanned.once({ params: { p: k.code }, facts: {} })
											: k.write === "picked"
												? db.workload.picked.once({
														params: { fresh: freshOf(k.first), p: k.code },
														facts: {}
													})
												: k.write === "listed"
													? db.workload.listed.once({
															params: {
																fresh: freshOf(k.first),
																named: [{ item: named, code: k.code }]
															},
															facts: {}
														})
													: db.workload.guarded.once({
															params: { fresh: freshOf(k.first), named: [], p: k.code },
															facts: {}
														})
									)
								)
								const param: ParamPlace =
									k.write === "listed"
										? { kind: "field", name: "named", field: "code" }
										: { kind: "scalar", name: "p" }
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
									if (k.write === "scanned") {
										c.note(
											"a scalar parameter of a ChangeSet of reads alone that no statement reads"
										)
										return
									}
									if (k.first === "colliding" && k.write !== "guarded") {
										c.note(
											k.write === "picked"
												? "a scalar parameter read only by a statement after one that fails"
												: "a relation parameter's field read only by a statement after one that fails"
										)
									}
									if (k.first === "none" && k.write === "guarded") {
										c.note(
											"a scalar parameter read only by a statement the runtime leaves out, no statement sent for the write's facts"
										)
									}
									return
								}
								if (Result.isFailure(applied)) {
									return assert.fail(`the write answers, not ${Formatter.format(applied.failure)}`)
								}
								const answer = applied.success
								if (k.write === "scanned") {
									assert.equal(
										answer.kind,
										"unchanged",
										"a ChangeSet of reads alone changes nothing"
									)
									assert.deepEqual(
										answer.kind === "unchanged" && isRecord(answer.reads)
											? answer.reads["coded"]
											: undefined,
										[],
										"the constant false reads no item back"
									)
									const unwritten = yield* written
									assert.deepEqual(unwritten, [], "Pick holds nothing")
									c.note("scanned answered")
									return
								}
								if (k.first === "colliding") {
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
								const unchanged = k.write === "guarded" && k.first === "none"
								assert.equal(
									answer.kind,
									unchanged ? "unchanged" : "accepted",
									"the write answers what it changed"
								)
								const rows = yield* written
								assert.deepEqual(
									rows,
									Arr.sort(
										k.write === "picked"
											? Arr.map(
													[
														...Arr.map(stored, (i) => i.id),
														...(k.first === "fresh" ? [freshId] : [])
													],
													(id) => `${id} ${k.code}`
												)
											: k.write === "listed"
												? [`${named} ${k.code}`]
												: [],
										Str.Order
									),
									"Pick holds the facts the write names"
								)
								if (!unchanged) {
									c.note(`${k.write} accepted`)
								}
							}).pipe(Effect.scoped, withLayer(o.served.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "each type restated over the bound value, then Item's key over the first stratum's items, then the items the write names"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/program/admission.ts",
				original: "\tif (!isNonEmpty(checked)) {\n\t\treturn placed\n\t}",
				replacement: "\tif (isNonEmpty(checked)) {\n\t\treturn placed\n\t}",
				why: "A write admits no parameter (write/program/admission.ts), so a code outside its pattern after a colliding first stratum is refused by Item's key instead."
			},
			{
				file: "packages/engine/src/write/program/admission.ts",
				original: "at <= lead.end ? [lead.param] : []",
				replacement: "at === lead.end ? [lead.param] : []",
				why: "A parameter rides only the first statement the flight sends wherever it is exposed, never the statements before it: picked's p rides its second stratum's statement alone, so a code outside Code after a colliding first stratum is refused by Item's key instead."
			},
			{
				file: "packages/engine/src/write/program/admission.ts",
				original:
					"const sentWherever = (p: OwnPlaced, exposed: Needs): boolean => covers(sentWhereOf(p), exposed)",
				replacement:
					'const sentWherever = (p: OwnPlaced, exposed: Needs): boolean => p.kind === "own" || covers(sentWhereOf(p), exposed)',
				why: "Every parameter rides the flight's first statement as its needs stand, sent only where the first stratum has items, and no statement is sent besides: guarded with none sends no statement, so a code outside Code is answered unchanged."
			},
			{
				file: "packages/engine/src/lower/conservative/admission.ts",
				original:
					'\tsubject.kind === "query" || (subject.kind === "readBack" && subject.admission === "own")',
				replacement: '\tsubject.kind === "query"',
				why: "A ChangeSet of reads alone admits no parameter its read-back leaves unread, its flight holding no statement of its own to carry its write's admission: scanned's code outside Code under the constant false is answered unchanged, reading no item back."
			}
		]
	})
