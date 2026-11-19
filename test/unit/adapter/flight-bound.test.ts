/**
 * The flight bound (flightMaxBytes, wire/batch.ts send): a flight whose bytes, as pg writes them in its
 * one corked write, pass what one write of the session carries is refused as InputTooLarge before any byte of it is
 * written, and leaves the session as it was; every other flight is written whole.
 *
 * Each case runs its call twice, on two fresh sessions of the adapter's own wire. The first session writes the call
 * under the production bound, and its server reads the bytes of every message: that is the oracle, the wire
 * itself, independent of grizzle's accounting. A flight's bytes are as pg writes it on a new connection, the most it
 * writes on any, so a refusal never depends on the connection (wire/batch.ts accountFlight): the flight's own messages,
 * and the Parse the wire carried in an earlier flight of each name it binds without parsing, which its connection had
 * already parsed. The second session writes the call under a test-sized bound drawn about one of those flights' bytes,
 * short of it, at it or past it, and must be refused exactly when the flight is longer than its bound, with the
 * flight's bytes and the bound, its server reading none of the flight; an admitted flight's server reads exactly what
 * the first one read. A refused call then runs again under the production bound and writes
 * exactly what the first session wrote, so the refusal changed nothing of the session, and sent nothing at all.
 *
 * A flight whose write fails before its last byte left the process (session.ts flightEnd) never carried its last
 * message, COMMIT where it ends a transaction, to the server: the call is ConnectionLost, never CommitLost. Each case
 * breaks the call's connection one way: the client's write side shut, so its write fails at once; the server's reset
 * right before the call, which may reach the client before its write or after; or the server's reset once it read the
 * call's COMMIT whole and ran it, so the call, whose COMMIT is never answered, is CommitLost. The fate is unknown only
 * where COMMIT could have run, as far as the client can tell.
 *
 * Every server is a TCP server on the loopback behind the SSLRequest and verify-full TLS every connection makes, whose
 * certificate authority is the test's own (test/support/memory-tls.ts tlsMaterial), and answers every query as
 * PostgreSQL answers one that returns no rows.
 *
 * Features: a bound short of, at and past a flight, and one byte short of it; each runner's call, admitted and refused;
 * each way the connection breaks; and each message the parse reads.
 */

import { Buffer } from "node:buffer"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { InputTooLarge } from "#adapter/errors/failures.ts"
import type { Session } from "#adapter/wire/session.ts"
import { assert } from "#test/support/assert.ts"
import {
	boundCallOf,
	boundFlightOf,
	caseGen,
	typedFailureOf,
	features,
	type BoundFeature,
	historied,
	lengthOf,
	newConnectionBytesOf,
	type Outcome,
	outcomes,
	parseCaseGen,
	parseFeatures,
	type ParseFeature,
	resetFeatures,
	type ResetFeature,
	resetGen
} from "#test/unit/adapter/flight-bound.fixtures.ts"

/**
 * The flight bound refuses a flight longer than one write carries before any byte of it is written, and writes every
 * other whole.
 *
 * Budget: its suite's count before the conversion (unit/adapter/flight-bound: 160 independent cases and 16 steered,
 * Vitest at grizzle 4ca3036a). At those counts its required situations went unreached at TEST_SEED=1 (refused one byte
 * past the bound; toolchain-test run of 2026-11-16 08:21Z), so its steered phase keeps the runner's cap of 200, which
 * it stops short of once every situation is reached.
 */
export const theFlightBoundRefusesAFlightLongerThanOneWriteCarriesBeforeAnyByteOfItIsWrittenAndWritesEveryOtherWhole =
	property.explore(caseGen, {
		needs: {},
		situations: features satisfies ReadonlyArray<Reached<BoundFeature>>,
		check: (_, k: Case<BoundFeature>) => (c) =>
			Effect.scoped(
				Effect.gen(function* () {
					const twin = yield* historied
					yield* boundCallOf(c, twin.session)
					const wire = twin.server.read.slice(twin.mark)
					const measured = newConnectionBytesOf(boundFlightOf(c, wire), wire)
					const limit =
						c.at === "short of"
							? Math.max(0, measured - c.distance)
							: c.at === "at"
								? measured
								: measured + c.distance
					const subject = yield* historied
					const bounded: Session = { ...subject.session, flightMaxBytes: limit }
					const exit = yield* Effect.exit(boundCallOf(c, bounded))
					const failure = typedFailureOf(exit)
					const read = subject.server.read.slice(subject.mark)
					if (measured <= limit) {
						assert.ok(Option.isNone(failure), `a call whose flight fits ${limit} bytes is admitted`)
						assert.deepEqual(read, wire, "an admitted call is written whole, as the twin's")
						k.note(`${c.runner}: admitted`)
						if (measured === limit) {
							k.note("admitted at exactly the bound")
						}
						return
					}
					assert.ok(
						Option.isSome(failure) && failure.value instanceof InputTooLarge,
						"a flight past its bound is refused as InputTooLarge"
					)
					if (Option.isSome(failure) && failure.value instanceof InputTooLarge) {
						assert.deepEqual(failure.value.bound, { kind: "flight", bytes: measured, limit })
					}
					k.note(`${c.runner}: refused`)
					if (measured === limit + 1) {
						k.note("refused one byte past the bound")
					}
					assert.deepEqual(read, [], "a refused flight writes nothing, and no ROLLBACK follows it")
					yield* boundCallOf(c, subject.session)
					assert.deepEqual(
						subject.server.read.slice(subject.mark),
						wire,
						"the refusal left the session's statements as they were"
					)
				})
			),
		oracle: {
			kind: "second-implementation",
			name: "the wire: every message a twin session's server reads of the same call under the production bound"
		},
		budget: { runs: 160, steered: 200 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original: "\tif (bytes > session.flightMaxBytes) {",
				replacement: "\tif (bytes > session.flightMaxBytes + 1) {",
				why: "A flight one byte past its bound is written; the flight bound's property fails."
			},
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original: "\t\t\tif (named.has(query.text.name)) {\n\t\t\t\tcontinue\n\t\t\t}\n",
				replacement: "",
				why: "A flight's bytes count the Parse of a name at every statement under it, not once; the flight bound's property fails."
			},
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original:
					"const accountFlight = (\n\tpipeline: ReadonlyArray<WireQuery>,\n\tmessageLimit: number,\n\tcontrols: ControlTexts\n): Result.Result<number, InputTooLarge> => {\n\tlet bytes = 0\n\tconst named = new Set<StatementName>()",
				replacement:
					"const everNamed = new Set<StatementName>()\n\nconst accountFlight = (\n\tpipeline: ReadonlyArray<WireQuery>,\n\tmessageLimit: number,\n\tcontrols: ControlTexts\n): Result.Result<number, InputTooLarge> => {\n\tlet bytes = 0\n\tconst named = everNamed",
				why: "A name's Parse is counted once per process, not once per flight; the flight bound's property fails."
			}
		]
	})

/**
 * A flight whose connection is reset is a lost connection when its write failed before its last byte left, and a
 * commit of unknown fate only once COMMIT could have run.
 *
 * Budget: its suite's count before the conversion (unit/adapter/flight-reset: 120 independent cases and 32 steered,
 * Vitest at grizzle 4ca3036a). Its steered phase keeps the runner's cap of 200, which it stops short of once every
 * situation is reached.
 */
export const aFlightWhoseConnectionIsResetIsALostConnectionWhenItsWriteFailedBeforeItsLastByteLeftAndACommitOfUnknownFateOnlyOnceCOMMITCouldHaveRun =
	property.explore(resetGen, {
		needs: {},
		situations: resetFeatures satisfies ReadonlyArray<Reached<ResetFeature>>,
		check:
			(_, k: Case<ResetFeature>) =>
			({ flight: c, reset }) =>
				Effect.scoped(
					Effect.gen(function* () {
						const subject = yield* historied
						const committed = subject.server.committed
						const exit = yield* Effect.exit(
							Effect.suspend(() => {
								switch (reset) {
									case "write side shut":
										subject.server.shutClients()
										break
									case "reset before the flight":
										subject.server.resetNow()
										break
									case "reset after COMMIT ran":
										subject.server.resetAt = "commit"
										break
								}
								return boundCallOf(c, subject.session)
							})
						)
						const failure = typedFailureOf(exit)
						const outcome: Outcome = Option.match(failure, {
							onNone: (): Outcome => "answered",
							onSome: (f): Outcome => {
								assert.ok(
									f._tag === "ConnectionLost" || f._tag === "CommitLost",
									`a broken connection is lost, or a commit of unknown fate: ${f._tag}`
								)
								return f._tag
							}
						})
						const ran = subject.server.committed - committed
						const read = subject.server.read.slice(subject.mark)
						k.note(`${c.runner}: ${reset}`)
						assert.ok(
							Arr.contains(outcomes[reset][c.runner], outcome),
							`${reset}, ${c.runner} may end ${Arr.join(outcomes[reset][c.runner], " or ")}, not ${outcome}`
						)
						switch (reset) {
							case "write side shut":
							case "reset before the flight":
								assert.deepEqual(read, [], "the server read nothing of the call")
								assert.equal(ran, 0, "nothing of the call ran")
								return
							case "reset after COMMIT ran":
								assert.equal(
									ran,
									outcome === "answered" ? 0 : 1,
									"the server read the call's COMMIT whole and ran it"
								)
								return
						}
					})
				),
		oracle: {
			kind: "second-implementation",
			name: "the wire: whether the server read the call's COMMIT whole and ran it"
		},
		budget: { runs: 120, steered: 200 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/wire/session.ts",
				original:
					"\t\t\tconnection.stream.write(flightEnd(), (error) => {\n\t\t\t\tif (Predicate.isError(error) && !connection.stream.destroyed) {\n\t\t\t\t\tonCut()\n\t\t\t\t}\n\t\t\t})",
				replacement: "\t\t\tconnection.stream.write(flightEnd())",
				why: "A write that fails before its last byte is not seen as the cut it is (the flight's last chunk's callback is dropped), so the call reads as CommitLost; the broken connection's property fails."
			}
		]
	})

/**
 * A statement's Parse message is refused before any byte of its flight is written exactly when it is longer than the
 * server reads, its text with its name and fields.
 *
 * Budget: its suite's count before the conversion (unit/adapter/flight-parse: 160 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const aStatementsParseMessageIsRefusedBeforeAnyByteOfItsFlightIsWrittenExactlyWhenItIsLongerThanTheServerReadsItsTextWithItsNameAndFields =
	property.explore(parseCaseGen, {
		needs: {},
		situations: parseFeatures satisfies ReadonlyArray<Reached<ParseFeature>>,
		check: (_, k: Case<ParseFeature>) => (c) =>
			Effect.scoped(
				Effect.gen(function* () {
					const twin = yield* historied
					yield* boundCallOf(c, twin.session)
					const wire = twin.server.read.slice(twin.mark)
					const parses = Arr.filter(wire, (m) => m.type === "P")
					const longest = Arr.reduce(parses, 0, (most, m) => Math.max(most, lengthOf(m)))
					const limit =
						c.at === "short of"
							? longest - c.distance
							: c.at === "at"
								? longest
								: longest + c.distance
					const subject = yield* historied
					const bounded: Session = { ...subject.session, messageMaxBytes: limit }
					const exit = yield* Effect.exit(boundCallOf(c, bounded))
					const failure = typedFailureOf(exit)
					const read = subject.server.read.slice(subject.mark)
					const refused = Arr.findFirst(parses, (m) => lengthOf(m) > limit)
					if (Option.isNone(refused)) {
						assert.ok(
							Option.isNone(failure),
							`a call whose every Parse fits ${limit} bytes is admitted`
						)
						assert.deepEqual(read, wire, "an admitted call is written whole, as the twin's")
						k.note(`${c.runner}: Parse admitted`)
						if (Arr.some(parses, (m) => lengthOf(m) === limit)) {
							k.note("admitted at exactly the bound")
						}
						return
					}
					assert.ok(
						Option.isSome(failure) && failure.value instanceof InputTooLarge,
						"a Parse past the bound is refused as InputTooLarge"
					)
					if (Option.isSome(failure) && failure.value instanceof InputTooLarge) {
						assert.deepEqual(failure.value.bound, {
							kind: "parse",
							bytes: lengthOf(refused.value),
							limit
						})
					}
					k.note(`${c.runner}: Parse refused`)
					if (Buffer.byteLength(refused.value.text, "utf8") <= limit) {
						k.note("refused within the Parse's fields")
					}
					assert.deepEqual(read, [], "a refused flight writes nothing, and no ROLLBACK follows it")
				})
			),
		oracle: {
			kind: "second-implementation",
			name: "the wire: each Parse's length word a twin session's server reads of the same call"
		},
		budget: { runs: 160, steered: 0 },
		kept: [],
		kills: []
	})
