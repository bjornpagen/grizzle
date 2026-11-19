/**
 * A read's parameters admitted whatever its logic reads of them, against PostgreSQL 19.
 *
 * A read is one statement, and every placeholder of a caller parameter is cast to its checked type, so PostgreSQL
 * checks a value as it binds the statement. A parameter the read's logic leaves unread (a rule whose filter is the
 * constant false, r.or(), reads nothing of what it matches) has no placeholder of its logic's, so the statement holds an
 * admission of it (lower/conservative/admission.ts withAdmission), an entry of its WITH no query reads, which PostgreSQL
 * parses and so binds. Without it such a read answered a value outside its pattern, which the same read without the
 * filter refuses.
 *
 * The box: Unread stores two items of Code, ^[a-z]{1,4}$. Its four reads are a scalar parameter `p` of Code matched
 * against an item's code, or a relation parameter `named` of an item and a code of Code matched as its own rows, each
 * filtered by nothing or by the constant false. Each case draws the read and the code, inside Code or outside it. The
 * oracle restates the pattern and the reads: a code outside Code is refused at bind as ParamRejected, a
 * `paramRejected` CallError whose `param` is the parameter's place (`p`, or `named`'s field `code`), whatever the
 * filter; otherwise the read under the constant false answers no row, and the plain read the stored items of that code,
 * or the one row `named` holds.
 *
 * Features: each parameter outside Code refused under each filter, and each read answered with a code inside Code.
 */

import { assert, assertVariant, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { ParamPlace } from "#compiler/core/identity.ts"
import type { CallError } from "#compiler/live/index.ts"
import {
	caseGen,
	type Feature,
	isCode,
	stored,
	Unread,
	readsInstall,
	readsTemplate
} from "#test/pg/parameters/read-admission.fixtures.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import { bareRecord } from "#test/support/assert.ts"
import { rowsOf } from "#test/support/calls.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** A read's parameters admitted whatever its logic reads, against PostgreSQL 19 a parameter outside its type is refused at bind, though a constant false filter leaves it unread. */
export const aReadsParametersAdmittedWhateverItsLogicReadsAgainstPostgreSQL19AParameterOutsideItsTypeIsRefusedAtBindThoughAConstantFalseFilterLeavesItUnread =
	property.explore(caseGen, {
		needs: { fixture: Substrate.seat(readsTemplate) },
		situations: [
			"scalar outside Code refused, filtered by none",
			"scalar outside Code refused, filtered by false",
			"relation outside Code refused, filtered by none",
			"relation outside Code refused, filtered by false",
			"scalar answered, filtered by none",
			"scalar answered, filtered by false",
			"relation answered, filtered by none",
			"relation answered, filtered by false"
		] satisfies ReadonlyArray<Reached<Feature>>,
		/** Its pre-conversion budget: runs 40, coverage cases 40 (read-admission.test.ts at 4fbc3e95). */
		budget: { runs: 40, steered: 40 },
		check:
			({ fixture }, c: CaseOf<Feature>) =>
			(k) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const o = yield* openedIn(Unread, { Item: [...stored] }, readsInstall, taken)
							return yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})

								const named = [{ item: stored[0].id, code: k.code }]
								const read: Result.Result<
									ReadonlyArray<Readonly<Record<string, unknown>>>,
									CallError
								> = k.via === "scalar"
									? yield* Effect.result(
											rowsOf(
												(k.filter === "false"
													? db.workload.scalarFalse
													: db.workload.scalarNone
												).once({ params: { p: k.code }, facts: {} })
											)
										)
									: yield* Effect.result(
											rowsOf(
												(k.filter === "false"
													? db.workload.relationFalse
													: db.workload.relationNone
												).once({ params: { named }, facts: {} })
											)
										)
								const param: ParamPlace =
									k.via === "scalar"
										? { kind: "scalar", name: "p" }
										: { kind: "field", name: "named", field: "code" }
								if (!isCode(k.code)) {
									if (Result.isSuccess(read)) {
										return assert.fail(
											`a code outside Code is refused at bind, not answered ${Formatter.format(read.success)}`
										)
									}
									const refused = read.failure
									assertVariant(refused, "kind", "paramRejected", "refused at bind")
									assert.deepEqual(refused.param, param, "the refusal names the parameter's place")
									c.note(`${k.via} outside Code refused, filtered by ${k.filter}`)
									return
								}
								if (Result.isFailure(read)) {
									return assert.fail(
										`a code inside Code is answered: ${Formatter.format(read.failure)}`
									)
								}
								const expected: ReadonlyArray<Readonly<Record<string, unknown>>> =
									k.filter === "false"
										? []
										: k.via === "scalar"
											? Arr.map(
													Arr.filter(stored, (item) => item.code === k.code),
													(item) => bareRecord({ id: item.id })
												)
											: Arr.map(named, (row) => bareRecord(row))
								unorderedEqual(read.success, expected, "the read's rows")
								c.note(`${k.via} answered, filtered by ${k.filter}`)
							}).pipe(Effect.scoped, withLayer(o.served.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "Code restated over the bound text, then the read's rows restated over the stored items"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/admission.ts",
				original: "\tconst entry = admissionEntry(cx)",
				replacement:
					'\tconst entry = cx.options.subject.kind === "query" ? undefined : admissionEntry(cx)',
				why: "A read's statement holds no admission, so a parameter its logic leaves unread is bound unchecked and a code outside Code under the constant false answers no row."
			}
		]
	})
