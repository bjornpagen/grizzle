import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { set, structuralHash } from "@bjornpagen/testing/oracle"
import { type Case as CaseOf, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, Result } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import { queryOver } from "#compiler/query/build/query.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import {
	allFeatures,
	armsAlone,
	armsOf,
	caseGen,
	Cell,
	Cells,
	columns,
	type Feature,
	keyedOnTheWire,
	plantedArms,
	printRecords,
	reached,
	readRecords,
	sameRecord,
	unionOf,
	cellsInstall,
	cellsTemplate
} from "#test/pg/reads/union-cells.fixtures.ts"
import { namesOf, parsedName } from "#test/support/kernel/naming.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { inserted } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Union cells decodes a union's rows to exactly the records its arms decode to, each read alone, and refuses a literal against a numeric field.
 *
 * Its pre-conversion budget: runs 60, coverage cases 240 (test/pg/reads/union-cells.test.ts at 224caf39a).
 */
export const unionCellsDecodesAUnionsRowsToExactlyTheRecordsItsArmsDecodeToEachReadAloneAndRefusesALiteralAgainstANumericField =
	property.explore(caseGen, {
		needs: { fixture: Substrate.fresh(cellsTemplate) },
		situations: allFeatures satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ fixture }, notes: CaseOf<Feature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const s = yield* Substrate
								const opened = yield* openedIn(Cells, {}, cellsInstall, taken)
								const names = namesOf(opened.installed)
								const kinds = defined(
									opened.installed.names.codes.rosters.get(parsedName("Kind")),
									"the codes of Kind"
								)
								const table = names.table(Cell)
								const insert = `INSERT INTO ${table} (${Arr.join(
									Arr.map(columns, (c) => names.column(Cell, c)),
									", "
								)}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`
								const { ctx, load, serve } = yield* openServedDb(
									opened.installed,
									opened.server.roles.app,
									{}
								)

								yield* inserted(
									s.admin,
									Arr.map(c.facts, (fact, id) => ({
										sql: insert,
										params: [
											String(id),
											String(fact.int4),
											String(fact.int8),
											String(fact.bool),
											fact.text,
											String(codeOf(kinds, fact.handle)),
											fact.x,
											Object.is(fact.f, -0) ? "-0" : String(fact.f)
										]
									}))
								)
								if (c.kind === "planted") {
									notes.note(`planted literal against ${c.against}`)
									const [a, b] = plantedArms(c.against, c.literalFirst)
									const planted = queryOver(Cells).rule(a).rule(b)
									if (c.against === "numeric") {
										const refused = yield* Effect.result(serve({ planted }))
										assert.ok(
											Result.isFailure(refused),
											"a literal against the numeric field is compiled"
										)
										assert.ok(
											!(refused.failure instanceof OpenError),
											Formatter.format(refused.failure)
										)
										const error = refused.failure.error
										assert.ok(isCompileError(error), Formatter.format(error))
										assert.deepEqual(
											[refused.failure.place, error.reason._tag],
											[
												{ kind: "program", role: "app", program: "planted" },
												"MalformedDescription"
											],
											"a literal against the numeric field is refused where the member is compiled"
										)
										return
									}
									const served = yield* serve({
										planted,
										first: queryOver(Cells).rule(a),
										second: queryOver(Cells).rule(b)
									})
									const delivered = yield* readRecords(member(served, "planted"))
									const first = yield* readRecords(member(served, "first"))
									const second = yield* readRecords(member(served, "second"))
									const alone = armsAlone([first, second])
									assert.deepEqual(
										set(structuralHash, sameRecord)(delivered, alone),
										Option.none(),
										`the union delivered ${printRecords(delivered)}; its arms alone ${printRecords(alone)}`
									)
									return
								}
								const arms = armsOf(c.groups)
								const loaded = yield* load({
									union: unionOf(arms),
									...Rec.fromEntries(Arr.map(arms, (arm, j) => [`arm${j}`, unionOf([arm])]))
								})
								const unionMember = member(loaded, "union")
								const union = yield* readRecords(memberCalls(ctx, unionMember))
								const armRecords = yield* Effect.forEach(arms, (_arm, j) =>
									readRecords(memberCalls(ctx, member(loaded, `arm${j}`)))
								)
								const alone = armsAlone(armRecords)
								assert.deepEqual(
									set(structuralHash, sameRecord)(union, alone),
									Option.none(),
									`the union delivered ${printRecords(union)}; its arms alone ${printRecords(alone)}`
								)
								const wire = unionMember.wire.member
								yield* keyedOnTheWire(wire, union)
								if (wire.shape !== "write" && Arr.some(wire.key, (k) => k.kind === "lacked")) {
									notes.note("a key column a heading group lacks")
								}
								notes.noteAll(reached(c))
							}).pipe(Effect.scoped),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "each arm read alone as a query of its own, its records' set union"
		},
		budget: { runs: 60, steered: 240 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/reads/union-cells.test.ts#unionCellsDecodesAUnionsRowsToExactlyTheRecordsItsArmsDecodeToEachReadAloneAndRefusesALiteralAgainstANumericField:ffffff.0:0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0"
				),
				reason:
					"ORDERKEY2: a union of two heading groups keyed by int4 and by int8, whose common fields hold no key, refused (UnsupportedOperation, a completed total order over the fields common to every arm) where each group is ordered by its own key",
				since: "2026-11-24"
			}
		],
		kills: [
			{
				file: "packages/engine/src/live/member.ts",
				original: "columns.length < held.length ||",
				replacement: "columns.length < record.length ||",
				why: "cde9595d9's red, its second fix reverted: a key field must be a column of every heading, so a union of heading groups each holding a field of its own is refused at generate as an unsupported key, where its rows' key is that field, lacked by the other groups."
			}
		]
	})
