import { Buffer } from "node:buffer"
import { Duplex } from "node:stream"
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, codePoint, element, type Gen, int, string, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { Connection } from "pg"
import { bindLength, bindOverrun, type BatchStatement } from "#adapter/wire/batch.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { testSql } from "#test/support/sql.ts"
import { paramText, textsOfParams } from "#test/support/wire.ts"

/**
 * The one bound a flight's parameters meet before they are sent (wire/batch.ts bindOverrun): each statement's Bind
 * message as pg writes it, its length word counted as PostgreSQL counts it, against the longest message the server
 * reads. A row count bounds nothing.
 *
 * The oracle is pg itself: each statement's Bind message is written by pg's own Connection, and its length word is what
 * bindLength must say. Against a limit drawn about those lengths, the flight is refused exactly when some message is
 * longer than the limit, with InputTooLarge naming the first such statement by its position, its length and the limit;
 * a message exactly as long as the limit passes.
 */

/** The Bind message pg writes for one execution of `statement`, as the bytes it sends. */
const pgBind = (statement: BatchStatement): Buffer => {
	const written: Array<Buffer> = []
	const wire = new Duplex({
		read: () => undefined,
		write: (chunk: Buffer, _encoding, done) => {
			written.push(chunk)
			done()
		}
	})
	const connection = new Connection({ stream: () => wire })
	connection.bind({ values: [...textsOfParams(statement.params)] }, false)
	return Buffer.concat(written)
}

const text = string(
	weighted([
		[3, codePoint(0x20, 0x7e)],
		[1, codePoint(0xa0, 0xd7_ff)],
		[1, codePoint(0xe0_00, 0x10_ffff)]
	]),
	{ min: 0, max: 40 }
)

/** A statement of a flight, run unnamed, with its parameters' texts. */
const statementGen: Gen<BatchStatement> = (source) => ({
	sql: testSql("SELECT $1::text"),
	params: Arr.map(source.draw(array(text, { min: 0, max: 6 })), paramText)
})

/**
 * Where the limit falls: one byte short of a drawn statement's message, exactly at it, or a drawn distance past it, so
 * the refusal lands on every position and the limit is met exactly.
 */
type LimitAt = "short of" | "at" | "past"

interface BindCase {
	readonly statements: Arr.NonEmptyReadonlyArray<BatchStatement>
	readonly at: number
	readonly limit: LimitAt
	readonly past: number
}

const caseGen: Gen<BindCase> = (source) => {
	const first = source.draw(statementGen)
	return {
		statements: [first, ...source.draw(array(statementGen, { min: 0, max: 3 }))],
		at: source.draw(int(0, 3)),
		limit: source.draw(element<LimitAt>(["short of", "at", "past"])),
		past: source.draw(int(1, 64))
	}
}

type BindFeature =
	| "refused at the first statement"
	| "refused at a later statement"
	| "admitted at exactly the limit"
	| "admitted below the limit"

describe("a statement's Bind message", () => {
	it.effect(
		"is as long as pg writes it, and a flight is refused before it is sent exactly at its first message past the limit",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/adapter/bind-length",
						draw: drawn(caseGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "pg's own Connection writing each Bind message, its length word the length"
						},
						coverage: required<BindFeature>(
							[
								"refused at the first statement",
								"refused at a later statement",
								"admitted at exactly the limit",
								"admitted below the limit"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const lengths = Arr.map(c.statements, (statement) => {
								const sent = pgBind(statement)
								assert.equal(sent[0], 0x42, "a Bind message")
								const declared = sent.readInt32BE(1)
								assert.equal(
									sent.length,
									1 + declared,
									"its length word counts all but its type byte"
								)
								assert.equal(bindLength(statement), declared)
								return declared
							})
							const chosen = defined(
								lengths[c.at % lengths.length],
								"the statement the limit falls by"
							)
							const limit =
								c.limit === "short of" ? chosen - 1 : c.limit === "at" ? chosen : chosen + c.past
							const first = Arr.findFirstIndex(lengths, (bytes) => bytes > limit)
							const refused = bindOverrun(c.statements, limit)
							if (Option.isNone(first)) {
								assert.equal(refused, undefined, `no message is longer than ${limit}`)
								k.note(
									Arr.contains(lengths, limit)
										? "admitted at exactly the limit"
										: "admitted below the limit"
								)
								return
							}
							assert.deepEqual(refused?.bound, {
								kind: "message",
								statement: first.value,
								bytes: defined(lengths[first.value]),
								limit
							})
							k.note(
								first.value === 0
									? "refused at the first statement"
									: "refused at a later statement"
							)
						})
				)
			)
	)
})
