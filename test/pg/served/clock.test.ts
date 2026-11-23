import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result, Stream } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import { isRecord } from "#compiler/core/record.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import {
	bigintOf,
	caseGen,
	Clock,
	clockInstall,
	clockPrograms,
	clockTemplates,
	type Feature,
	onlyReading,
	perHour
} from "#test/pg/served/clock.fixtures.ts"
import { readOnce, writeOnce } from "#test/support/calls.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A member bound to the database's clock reads the instant its call's transaction began once per call, in its unit, and answers at that instant alone. */
export const aMemberBoundToTheDatabasesClockReadsTheInstantItsCallsTransactionBeganOncePerCallInItsUnitAndAnswersAtThatInstantAlone =
	property.explore(caseGen, {
		needs: Substrate.oneOf(clockTemplates, Substrate.fresh),
		situations: [
			"micros",
			"millis",
			"a row due exactly at the first reading",
			"a row due an hour on",
			"no row due",
			"a contract that admits the reading",
			"a contract that refuses the reading"
		] satisfies ReadonlyArray<Reached<Feature>>,
		/** Its pre-conversion budget: runs 16, coverage cases 16 (clock.test.ts at bf4f43bb). */
		budget: { runs: 16, steered: 16 },
		check: (clocks, notes: Case<Feature>) => (c) =>
			Effect.scoped(
				Effect.gen(function* () {
					notes.note(c.unit)
					const programs = clockPrograms(c.unit)
					const taken = yield* clocks[c.unit]
					const opened = yield* openedIn(
						Clock,
						{ Wanted: [], Stamp: [], Mark: [], Bounds: [] },
						clockInstall(c.unit),
						taken
					)
					yield* withServedDb(opened.installed, opened.server.roles.app, {}, ({ ctx: db, load }) =>
						Effect.gen(function* () {
							const loaded = yield* load(programs)
							const calls = (name: string) => memberCalls(db, member(loaded, name))
							const call = { params: {}, facts: {} }

							const firstRows = yield* readOnce(calls("reading"))(call)
							const first = onlyReading(firstRows, "now")

							const both = yield* readOnce(calls("both"))(call)
							const us = onlyReading(both, "us")
							const ms = onlyReading(both, "ms")
							assert.equal(ms, us / 1_000n, "one call's milliseconds are its microseconds floored")

							const wanted = Arr.map(c.wants, (w, i) => ({
								key: i + 1,
								due: w.past ? first - w.offset : first + perHour[c.unit] + w.offset
							}))
							if (Arr.some(c.wants, (w) => w.past && w.offset === 0n)) {
								notes.note("a row due exactly at the first reading")
							}
							if (Arr.some(c.wants, (w) => !w.past)) {
								notes.note("a row due an hour on")
							}
							if (Arr.every(c.wants, (w) => !w.past)) {
								notes.note("no row due")
							}
							yield* writeOnce(calls("want"))({
								params: {},
								facts: { insert: { Wanted: wanted } }
							})

							const dueCalls = memberCalls(db, member(loaded, "due"))
							if (dueCalls.shape !== "answeredSet") {
								return assert.fail("a clocked set read is served at its call's instant")
							}
							const answer = yield* Stream.runCollect(dueCalls.answer(call))
							const kinds: ReadonlyArray<string> = Arr.map(answer, (e) => e.kind)
							const expectedKinds: ReadonlyArray<string> = [
								"reset",
								...Arr.map(
									Arr.filter(c.wants, (w) => w.past),
									() => "upsert"
								),
								"ready",
								"end"
							]
							assert.deepEqual(
								kinds,
								expectedKinds,
								"a clocked read's answer is reset, an upsert per due row, ready, then end"
							)
							const dueKeys = Arr.flatMap(c.wants, (w, i) => (w.past ? [i + 1] : []))
							const dueRows = yield* readOnce(dueCalls)(call)
							unorderedEqual(
								Arr.map(dueRows, (row) => (isRecord(row) ? row["key"] : undefined)),
								dueKeys,
								"a clocked read answers exactly the rows due before the first reading"
							)

							const stamped = yield* writeOnce(calls("stamp"))(call)
							const reads =
								stamped.kind === "accepted" || stamped.kind === "unchanged"
									? stamped.reads
									: undefined
							const nowRows = isRecord(reads) ? reads["now"] : undefined
							const reading = onlyReading(Arr.isArray(nowRows) ? nowRows : [], "now")
							const stampRows = yield* readOnce(calls("stamps"))(call)
							const markRows = yield* readOnce(calls("marks"))(call)
							const stampedAt = [...stampRows, ...markRows]
							assert.equal(stampedAt.length, 2 * wanted.length, "every wanted key stamped twice")
							assert.ok(
								Arr.every(stampedAt, (row) => bigintOf(row, "at") === reading),
								`every stamp of the call, in either stratum, is its one reading ${reading}`
							)

							const admitted = yield* Effect.result(readOnce(calls("before"))(call))
							notes.note("a contract that admits the reading")
							assert.ok(
								Result.isSuccess(admitted),
								`a reading before 2100 answers: ${Formatter.format(admitted)}`
							)
							const refused = yield* Effect.result(readOnce(calls("after"))(call))
							notes.note("a contract that refuses the reading")
							assert.ok(
								Result.isFailure(refused) && refused.failure.kind === "refused",
								`a reading before 2100 is refused by a contract of instants after it: ${Formatter.format(refused)}`
							)
						})
					)
				})
			),
		oracle: {
			kind: "specification",
			name: "the readings each call delivers, and the rows due before the first reading"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: `\t\t\treturn \`\${inCatalog("transaction_timestamp")}()\``,
				replacement: `\t\t\treturn \`\${inCatalog("statement_timestamp")}()\``,
				why: "The clock reads statement_timestamp(); caught by Mark's stamps against Stamp's."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original: `			return \`\${inCatalog("floor")}(\${counted})\``,
				replacement: `			return \`\${inCatalog("round")}(\${counted})\``,
				why: "Milliseconds read rounded, not floored; caught by ms = floor(us / 1000) wherever the reading's microseconds pass 500."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original: "\tmicros: microsPerSecond,\n\tmillis: millisPerSecond",
				replacement: "\tmicros: millisPerSecond,\n\tmillis: microsPerSecond",
				why: "The clock's units swapped, microseconds counted as milliseconds; caught by ms = floor(us / 1000) at every reading."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original: `\t\t\treturn \`\${inCatalog("transaction_timestamp")}()\``,
				replacement: `\t\t\treturn \`\${inCatalog("clock_timestamp")}()\``,
				why: "The clock reads clock_timestamp(); caught by stamps of one statement apart."
			},
			{
				file: "packages/grizzle/src/adapter/db/handles.ts",
				original: "\t\tanswer: (input) => Stream.concat(events(input), Stream.make(answer.end)),",
				replacement: "\t\tanswer: (input) => events(input),",
				why: "A clocked read answered with no `end` after its ready, its stream ending at the ready; caught by the answer's events."
			}
		]
	})
