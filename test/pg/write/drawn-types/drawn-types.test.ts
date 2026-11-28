/**
 * A family drawn over a contract over an integer, on PostgreSQL 19: `drawn(c)`, c natural or a contract whose base is
 * int2, int4 or int8, types an ordered family's count and its index by c, its column c's domain over c's base, so a
 * field of c elsewhere, metis's test number, is contained in the family's held numbers and they in it under the
 * containment's one identity rule. Each kind of the box (drawn-types.fixtures.ts) is a series, its issued numbers and
 * the tests that hold the held ones: natural; a contract from 0 to 3 over smallint, integer and bigint; metis's
 * contract over integer from 0 to 2,147,483,647; and a contract over smallint from 0, bounded by its carrier alone.
 *
 * Property, per case: one call issues numbers to a fresh series, which the host draws, stating a test for every held
 * number it issues. It is accepted exactly where the series' count stays within the kind's greatest, its contract's
 * bound and its carrier's, and then the series counts every number, each number reads back as its place from 0, a
 * JavaScript integer over smallint and integer and a bigint over bigint, as the column's carrier is read; past the
 * contract's bound it is `refused` on the kind's contract, the one law a count past the bound breaks, and past the
 * carrier its input is refused before any statement; either way the tables hold nothing. No value is ever wrapped, and
 * no call fails otherwise. Oracle: the model (expectedOf), every value compared as an integer.
 *
 * Features: each kind, a count at its contract's and at its carrier's bound, a call past each refused, a series of no
 * numbers, the containments in each direction.
 */
import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { CallError, CallErrorOf } from "#compiler/live/index.ts"
import type { WriteOutcome } from "#compiler/live/program.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	contractOf,
	Drawn,
	type DrawnFeature,
	drawnInstall,
	drawnTemplate,
	type Expected,
	expectedOf,
	type Issues,
	type Issuing,
	issuingGen,
	type Kind,
	kinds,
	type MoveFeature,
	moveGen,
	moveSituations,
	situations,
	toBig,
	toSmall,
	toTall,
	toWhole,
	toWide
} from "#test/pg/write/drawn-types/drawn-types.fixtures.ts"
import { writeAnswerOf, type WriteAnswer } from "#test/support/calls.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { refusedEntries } from "#test/support/refused.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** The features a case reaches, by the model's answer to its call. */
const featuresOf = (c: Issuing, expected: Expected): ReadonlyArray<DrawnFeature> => {
	const kind: Readonly<Record<Kind, DrawnFeature>> = {
		Natural: "natural",
		Small: "a contract over smallint",
		Whole: "a contract over integer",
		Big: "a contract over bigint",
		Wide: "metis's test number",
		Tall: "a contract over smallint"
	}
	const { most, carrier } = kinds[c.kind]
	const count = c.issues.length
	const reached: ReadonlyArray<readonly [boolean, DrawnFeature]> = [
		[true, kind[c.kind]],
		[count === most, "a count at its contract's bound"],
		[count === carrier, "a count at its carrier's bound"],
		[expected.kind === "refused", "a count past its contract's bound, refused"],
		[expected.kind === "input", "a count past its carrier's bound, refused"],
		[count === 0, "a series of no numbers"],
		[
			expected.kind === "accepted" && Arr.some(expected.numbers, (n) => n.issue === "held"),
			"a held number in each direction of the containments"
		]
	]
	return Arr.flatMap(reached, ([holds, feature]) => (holds ? [feature] : []))
}

/**
 * A call's answer as the property reads it, whatever its kind: accepted, with the numbers its read-back decodes; refused,
 * with the contracts whose laws the refusal names; or any other answer, which no case meets.
 */
type Answer =
	| {
			readonly kind: "accepted"
			readonly rows: ReadonlyArray<{ readonly number: number | bigint; readonly issue: string }>
	  }
	| { readonly kind: "refused"; readonly contracts: ReadonlyArray<string>; readonly text: string }
	| { readonly kind: "input"; readonly text: string }
	| { readonly kind: "other"; readonly text: string }

/** A call's answer (answerOf), its input refused before any statement among them, every other failure still its own. */
const answerOfCall = (
	write: Effect.Effect<WriteOutcome<Issued>, CallError>
): Effect.Effect<Answer, CallError> =>
	Effect.catchIf(Effect.map(writeAnswerOf(write), answerOf), isInput, (error) =>
		Effect.succeed<Answer>({ kind: "input", text: error.message })
	)

/** Whether a call's failure is its input's refusal, before any statement. */
const isInput = (error: CallError): error is CallErrorOf<"input"> => error.kind === "input"

/** The read-back of a kind's call: each issued number as the query decodes it, and whether a test holds it. */
type Issued = {
	readonly issued: ReadonlyArray<{ readonly number: number | bigint; readonly issue: string }>
}

const answerOf = (answer: WriteAnswer<WriteOutcome<Issued>>): Answer => {
	switch (answer.kind) {
		case "accepted":
			return {
				kind: "accepted",
				rows: Arr.map(answer.reads.issued, (row) => ({ number: row.number, issue: row.issue }))
			}
		case "refused":
			return {
				kind: "refused",
				contracts: Arr.flatMap(refusedEntries(answer.refused), (l) =>
					l.law.kind === "contract" ? [l.law.contract] : []
				),
				text: Formatter.format(answer.refused)
			}
		case "unchanged":
		case "outsideWorld":
			return { kind: "other", text: Formatter.format(answer) }
	}
}

/** A drawn family over a contract over an integer counts and indexes by the contract, refused past its bound. */
export const aFamilyDrawnOverAContractOverAnIntegerCountsAndIndexesByItsTypeAndIsRefusedPastItsBound =
	property.explore(issuingGen, {
		needs: { fixture: Substrate.fresh(drawnTemplate) },
		situations,
		check:
			({ fixture }, k: Case<DrawnFeature>) =>
			(c) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const s = yield* Substrate
							const o = yield* openedIn(Drawn, {}, drawnInstall, taken)
							const names = o.installed.installation.names
							return yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								/**
								 * The kind's member called with `issues` nested under the series, and a test of each number of
								 * `held`: its answer, its read-back's numbers as the query decodes them.
								 */
								const issuing = (issues: Issues, held: ReadonlyArray<number>) => {
									const series = [
										{ series: "test" as const, issued: Arr.map(issues, (issue) => ({ issue })) }
									]
									switch (c.kind) {
										case "Natural":
											return answerOfCall(
												db.workload.Natural.once({
													params: {},
													facts: {
														insert: {
															NaturalSeries: series,
															NaturalNumber: Arr.map(held, (n) => ({
																test: n + 1,
																number: BigInt(n)
															}))
														}
													}
												})
											)
										case "Small":
											return answerOfCall(
												db.workload.Small.once({
													params: {},
													facts: {
														insert: {
															SmallSeries: series,
															SmallNumber: Arr.map(held, (n) => ({
																test: n + 1,
																number: toSmall(n)
															}))
														}
													}
												})
											)
										case "Whole":
											return answerOfCall(
												db.workload.Whole.once({
													params: {},
													facts: {
														insert: {
															WholeSeries: series,
															WholeNumber: Arr.map(held, (n) => ({
																test: n + 1,
																number: toWhole(n)
															}))
														}
													}
												})
											)
										case "Big":
											return answerOfCall(
												db.workload.Big.once({
													params: {},
													facts: {
														insert: {
															BigSeries: series,
															BigNumber: Arr.map(held, (n) => ({
																test: n + 1,
																number: toBig(BigInt(n))
															}))
														}
													}
												})
											)
										case "Wide":
											return answerOfCall(
												db.workload.Wide.once({
													params: {},
													facts: {
														insert: {
															WideSeries: series,
															WideNumber: Arr.map(held, (n) => ({ test: n + 1, number: toWide(n) }))
														}
													}
												})
											)
										case "Tall":
											return answerOfCall(
												db.workload.Tall.once({
													params: {},
													facts: {
														insert: {
															TallSeries: series,
															TallNumber: Arr.map(held, (n) => ({ test: n + 1, number: toTall(n) }))
														}
													}
												})
											)
									}
								}
								/** The series' count and its numbers as PostgreSQL stores them, each an integer. */
								const stored = Effect.gen(function* () {
									const series = yield* s.admin.queryValues(
										`SELECT ${quoteIdent(names.column(`${c.kind}Series`, "issued"))}::text FROM ${printObjectName(names.relation(`${c.kind}Series`))}`,
										[]
									)
									const numbers = yield* s.admin.queryValues(
										`SELECT ${quoteIdent(names.column(`${c.kind}Issued`, "number"))}::text FROM ${printObjectName(names.relation(`${c.kind}Issued`))}`,
										[]
									)
									return {
										count: Arr.map(series, (row) => BigInt(String(row[0]))),
										numbers: Arr.sort(
											Arr.map(numbers, (row) => BigInt(String(row[0]))),
											Order.BigInt
										)
									}
								})
								const seated = yield* stored
								assert.deepEqual(
									seated,
									{ count: [], numbers: [] },
									`${c.kind}: the seat holds no series before the call`
								)
								const expected = expectedOf(c.kind, c.issues)
								k.noteAll(featuresOf(c, expected))
								const held = Arr.flatMap(c.issues, (issue, i) => (issue === "held" ? [i] : []))
								const answer = yield* issuing(c.issues, held)
								const after = yield* stored
								if (expected.kind === "refused" || expected.kind === "input") {
									assert.equal(
										answer.kind,
										expected.kind,
										`${c.kind}: a count of ${c.issues.length} past ${Math.min(kinds[c.kind].most, kinds[c.kind].carrier)} is ${expected.kind}, not ${answer.kind}: ${"text" in answer ? answer.text : Formatter.format(answer.rows)}`
									)
									if (answer.kind === "refused") {
										assert.ok(
											answer.contracts.includes(contractOf[c.kind]),
											`${c.kind}: the refusal names the contract ${contractOf[c.kind]}: ${answer.text}`
										)
									}
									assert.deepEqual(
										after,
										{ count: [], numbers: [] },
										`${c.kind}: a refused call stores nothing`
									)
									return
								}
								if ("text" in answer) {
									return assert.fail(
										`${c.kind}: a call issuing ${c.issues.length} numbers, within its bounds, is accepted, not ${answer.text}; the series stores ${Formatter.format(after)}`
									)
								}
								assert.deepEqual(
									after.count,
									[BigInt(expected.count)],
									`${c.kind}: the series counts its ${expected.count} numbers`
								)
								assert.deepEqual(
									after.numbers,
									Arr.map(expected.numbers, (n) => BigInt(n.number)),
									`${c.kind}: each number is its place from 0`
								)
								const read = Arr.sort(
									answer.rows,
									Order.mapInput(Order.BigInt, (row: (typeof answer.rows)[number]) =>
										BigInt(row.number)
									)
								)
								assert.ok(
									Arr.every(read, (row) => typeof row.number === kinds[c.kind].host),
									`${c.kind}: every number reads back as a ${kinds[c.kind].host}`
								)
								assert.deepEqual(
									Arr.map(read, (row) => ({ number: BigInt(row.number), issue: row.issue })),
									Arr.map(expected.numbers, (n) => ({ number: BigInt(n.number), issue: n.issue })),
									`${c.kind}: the numbers read back by value`
								)
							}).pipe(Effect.scoped, withLayer(o.served.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "each number its place from 0 and the count their number, compared as integers; refused on the contract past the kind's greatest count"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/fill.ts",
				original:
					"\tconst stored = storedValue(column.spec, integerHostOf(column.spec.carrier, BigInt(value)))",
				replacement: "\tconst stored = Result.ok(BigInt(value))",
				why: "The host draws every value as a bigint, natural's host type, whatever its column: a series over smallint or integer is refused as its input, its count no JavaScript integer, instead of accepted."
			},
			{
				file: "packages/engine/src/schema/relation.ts",
				original:
					'\tfieldEntries.set(value, { kind: "written", writing: { kind: "drawn" } })\n\tregisterWrittenField(value, type)\n',
				replacement:
					'\tfieldEntries.set(value, { kind: "written", writing: { kind: "drawn" } })\n\tregisterWrittenField(value, naturalDescriptor)\n',
				why: "drawn(c) is installed as natural, an int8 column of natural's domain whatever c: a test of a number of a contract over smallint or integer is refused in a containment with the drawn numbers, natural's base carrier int8 against the contract's, the sides' field types differing, so the schema installs no template and no case runs."
			},
			{
				file: "packages/engine/src/scalar/compute/literal.ts",
				original: '\tcarrier === "int2" || carrier === "int4" ? Number(value) : value',
				replacement: "\tvalue",
				why: "pred's 0 and 1 are bigints whatever the drawn type: a family over a contract over smallint or integer reads its last member at a literal its type refuses, so the schema installs no template and no case runs."
			}
		]
	})

/**
 * A put that moves members into a group the family's statement draws in SQL, past its stored members, is refused on the
 * drawn contract where the group's count passes its carrier, and accepted where it meets it.
 *
 * Owner 1 holds two members and owner 2 32,766 or 32,767, each inserted fresh, which the host draws; then one put moves
 * one or two of owner 1's members into owner 2's group, a re-placement the family's statement draws past owner 2's
 * stored members (write/family/additions.ts appendScan). Property: where owner 2's count stays within smallint's
 * 32,767, the put is accepted and each group's indexes are 0 to its count less one; past it, the put is `refused` on
 * the contract DrawnTall, the statement's guard raising its refusal before PostgreSQL would narrow the count into the
 * column (22003), and the tables hold what they held. No count is wrapped, and no call fails otherwise. Oracle: the
 * family's rule, a group's indexes 0 … n − 1 and its count n, against smallint's carrier.
 */
export const aPutThatMovesMembersIntoAGroupPastItsCarriersBoundIsRefusedOnTheDrawnContractNeverNarrowed =
	property.exhaust(finite(moveGen), {
		box: "owner 2's group of 32,766 or 32,767 members, one or two of owner 1's two members put into it",
		needs: { fixture: Substrate.fresh(drawnTemplate) },
		situations: moveSituations,
		check:
			({ fixture }, k: Case<MoveFeature>) =>
			(move) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const s = yield* Substrate
							const o = yield* openedIn(Drawn, {}, drawnInstall, taken)
							const names = o.installed.installation.names
							return yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								/** Each group's count, and each member's group and index, as PostgreSQL stores them. */
								const stored = Effect.gen(function* () {
									const owners = yield* s.admin.queryValues(
										`SELECT ${quoteIdent(names.column("MoveOwner", "g"))}::text, ${quoteIdent(names.column("MoveOwner", "n"))}::text FROM ${printObjectName(names.relation("MoveOwner"))}`,
										[]
									)
									const members = yield* s.admin.queryValues(
										`SELECT ${quoteIdent(names.column("MoveMember", "g"))}::text, ${quoteIdent(names.column("MoveMember", "at"))}::text FROM ${printObjectName(names.relation("MoveMember"))}`,
										[]
									)
									const pairs = (rows: ReadonlyArray<ReadonlyArray<unknown>>) =>
										Arr.map(
											rows,
											(row) => [BigInt(String(row[0])), BigInt(String(row[1]))] as const
										)
									const groupOf = (g: bigint) => ({
										count: Arr.flatMap(pairs(owners), ([o, n]) => (o === g ? [n] : [])),
										at: Arr.sort(
											Arr.flatMap(pairs(members), ([m, at]) => (m === g ? [at] : [])),
											Order.BigInt
										)
									})
									return { one: groupOf(1n), two: groupOf(2n) }
								})
								/** A group of `n` members as the family's rule holds it: its count n, its indexes 0 … n − 1. */
								const groupOf = (n: number) => ({
									count: [BigInt(n)],
									at: Array.from({ length: n }, (_, i) => BigInt(i))
								})
								const inserted = yield* writeAnswerOf(
									db.workload.moveOwners.once({
										params: {},
										facts: {
											insert: {
												MoveOwner: [
													{ g: 1, n: [{ id: 1 }, { id: 2 }] },
													{ g: 2, n: Array.from({ length: move.full }, (_, i) => ({ id: 3 + i })) }
												]
											}
										}
									})
								)
								assert.equal(inserted.kind, "accepted", "the two groups are inserted fresh")
								const before = yield* stored
								assert.deepEqual(
									before,
									{ one: groupOf(2), two: groupOf(move.full) },
									"each fresh group holds its members at 0 … n − 1"
								)
								const answer = yield* writeAnswerOf(
									db.workload.moveMembers.once({
										params: {},
										facts: {
											put: {
												MoveMember: Array.from({ length: move.moved }, (_, i) => ({
													id: 1 + i,
													g: 2
												}))
											}
										}
									})
								)
								const after = yield* stored
								const count = move.full + move.moved
								if (count > kinds.Tall.carrier) {
									k.note("a group drawn past its carrier's bound, refused")
									assert.equal(
										answer.kind,
										"refused",
										`a move into a group of ${move.full} past ${kinds.Tall.carrier} is refused, not ${Formatter.format(answer)}`
									)
									if (answer.kind === "refused") {
										assert.ok(
											Arr.some(
												refusedEntries(answer.refused),
												(l) => l.law.kind === "contract" && l.law.contract === contractOf.Tall
											),
											`the refusal names the contract ${contractOf.Tall}: ${Formatter.format(answer.refused)}`
										)
									}
									assert.deepEqual(after, before, "a refused move leaves both groups as they were")
									return
								}
								k.note("a group drawn to its carrier's bound")
								assert.equal(
									answer.kind,
									"accepted",
									`a move into a group of ${move.full} to ${count} is accepted, not ${Formatter.format(answer)}`
								)
								assert.deepEqual(
									after,
									{ one: groupOf(2 - move.moved), two: groupOf(count) },
									"each group holds its members at 0 … n − 1 after the move"
								)
							}).pipe(Effect.scoped, withLayer(o.served.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "the family's rule, a group's indexes 0 … n − 1 and its count n, against smallint's carrier: a count past it refused on the contract"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/family/additions.ts",
				original: "\t\t\t{ when: refuse, result: count }\n\t\t],",
				replacement: "\t\t],",
				why: "The family's statement narrows a count past its carrier unguarded: a move into a group of 32,767 fails with PostgreSQL's 22003 instead of the contract's refusal."
			}
		]
	})
