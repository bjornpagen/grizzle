/**
 * A member that binds a parameter to the database's clock (workload clocked) is its program served with that one input
 * read by the server: generated logins over the clock box, each drawn program served twice, once with the call's `now`
 * and once with the clock's, compiled by the one draft `grizzle generate` and `grizzle check` run (draftSchema, then
 * servedFiles).
 *
 * Properties, each against the plain compile of the same programs:
 *
 * - Certificates: each role's certificate, its level and every reason's condition, member and relation, is the plain
 *   compile's. The certifier reads a reading as the parameter it stands for (program/isolation/extract.ts), so LEASE's
 *   reclaim, a positive whole-key read of an insert-only Claim filtered by `at + ttl < now`, certifies READ COMMITTED
 *   clocked exactly as with the host's `now`, and a range read of what is due stays SERIALIZABLE.
 * - Statements: the clocked file reads the clock by transaction_timestamp() alone, never statement_timestamp() or
 *   clock_timestamp(), and the plain file reads none.
 * - Liveness: a clocked read is served as an instant read, with no footprint, and the snapshot's live plan holds a
 *   relation exactly where a read served live reads it.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Effect, Record as Rec, String as Str } from "effect"
import { joined } from "#test/support/chunked.ts"
import {
	caseGen,
	compiled,
	type Feature,
	membersOf
} from "#test/unit/cli/served-clocked.fixtures.ts"

/**
 * A member bound to the database's clock certifies as its program with the call's now, reads the clock by
 * transaction_timestamp() alone, and a clocked read is served at its call's instant, never live.
 *
 * Budget: its suite's count before the conversion (unit/cli/served-clocked: 24 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const aMemberBoundToTheDatabasesClockCertifiesAsItsProgramWithTheCallsNowReadsTheClockByTransactionTimestampAloneAndAClockedReadIsServedAtItsCallsInstantNeverLive =
	property.explore(caseGen, {
		needs: {},
		situations: [
			"a role certified READ COMMITTED",
			"a role certified SERIALIZABLE for its own statements",
			"the reclaim, clocked",
			"a key bound to the reading",
			"a range read of what is due",
			"a whole key read by the reading",
			"a clocked read of a relation no live read reads",
			"a clocked read beside a live read of its relation"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, notes: CaseOf<Feature>) => (c) =>
			Effect.gen(function* () {
				const plain = yield* compiled(c, false)
				const clocked = yield* compiled(c, true)
				if (c.changes.includes("reclaim")) {
					notes.note("the reclaim, clocked")
				}
				if (c.changes.includes("stamp")) {
					notes.note("a key bound to the reading")
				}
				if (c.changes.includes("due")) {
					notes.note("a range read of what is due")
				}
				if (c.changes.includes("fromStamp")) {
					notes.note("a whole key read by the reading")
				}
				for (const [name, certificate] of Rec.toEntries(plain.certificates)) {
					notes.note(
						certificate === "readCommitted"
							? "a role certified READ COMMITTED"
							: "a role certified SERIALIZABLE for its own statements"
					)
					assert.equal(
						clocked.certificates[name],
						certificate,
						`role ${name}: its certificate clocked is its certificate with the call's now`
					)
				}
				assert.ok(
					Str.includes("transaction_timestamp")(joined(clocked.text)) &&
						!Str.includes("statement_timestamp")(joined(clocked.text)) &&
						!Str.includes("clock_timestamp")(joined(clocked.text)),
					"the clocked file reads the clock by transaction_timestamp() alone"
				)
				assert.ok(
					!Str.includes("transaction_timestamp")(joined(plain.text)),

					"the plain file reads no clock"
				)
				const members = membersOf(clocked.file)
				for (const name of c.reads) {
					const member = defined(members.get(name), `the served member ${name}`)
					assert.equal(
						member.kind === "read" && member.read.live.kind === "answered"
							? "answered"
							: member.kind,
						name === "dueNow" ? "answered" : "read",
						`member ${name}: a clocked read is answered at its call's instant, any other read live`
					)
				}
				const liveWanted = c.reads.includes("wanted")
				if (c.reads.includes("dueNow")) {
					notes.note(
						liveWanted
							? "a clocked read beside a live read of its relation"
							: "a clocked read of a relation no live read reads"
					)
					assert.ok(plain.live.has("Wanted"), "a plain read of what is due is live")
				}
				assert.equal(
					clocked.live.has("Wanted"),
					liveWanted,
					"the live plan holds Wanted exactly where a live read reads it"
				)
				assert.equal(
					clocked.live.has("Stamp"),
					c.reads.includes("stamps"),
					"the live plan holds Stamp exactly where a live read reads it"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the same programs compiled with the call's now: their certificates, statements and live plan"
		},
		budget: { runs: 24, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/isolation/extract.ts",
				original: `\treturn e.kind === "clock" && e.of.kind === "param"\n\t\t? { kind: "param", name: e.of.param }\n\t\t: undefined`,
				replacement: "\treturn undefined",
				why: "The certifier reads a clock reading as an expression no parameter carries, so a key bound to it is bound by no value; the certificates' property fails."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original: `\t\t\treturn \`\${inCatalog("transaction_timestamp")}()\``,
				replacement: `\t\t\treturn \`\${inCatalog("statement_timestamp")}()\``,
				why: "The clock is read by statement_timestamp(); the statements' property fails."
			},
			{
				file: "packages/engine/src/program/workload/compile.ts",
				original: '\t\t\t\t\tcase "query":',
				replacement: '\t\t\t\t\tcase "query":\n\t\t\t\t\t\treturn plan',
				why: "A clocked read is served live, with its footprint; the liveness property fails."
			}
		]
	})
