import { Buffer } from "node:buffer"
import { Duplex } from "node:stream"
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { array, codePoint, element, string, weighted } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Formatter, String as Str } from "effect"
import { Connection } from "pg"
import { bindLength, bindOverrun, type FlightStatement } from "#adapter/wire/batch.ts"
import { serverStatement } from "#adapter/wire/session.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { testSql } from "#test/support/sql.ts"

/**
 * The one bound a flight's parameters meet before they are sent (wire/batch.ts bindOverrun): each statement's Bind
 * message as pg writes it, its length word counted as PostgreSQL counts it, against the longest message the server
 * reads. A row count bounds nothing.
 */

/** The Bind message pg writes for one execution of `statement`, as the bytes it sends. */
const pgBind = (statement: FlightStatement): Buffer => {
	const written: Array<Buffer> = []
	const wire = new Duplex({
		read: () => undefined,
		write: (chunk: Buffer, _encoding, done) => {
			written.push(chunk)
			done()
		}
	})
	const connection = new Connection({ stream: () => wire })
	connection.bind(
		"server" in statement
			? { statement: statement.server.name, values: [...statement.params] }
			: { values: [...statement.params] },
		false
	)
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

describe("a statement's Bind message", () => {
	it.effect(
		"is as long as bindLength says: the length word pg writes, for unnamed and named statements",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/adapter/bind-length",
						draw: drawn(
							(source) =>
								[
									source.draw(element([false, true])),
									source.draw(array(text, { min: 0, max: 6 }))
								] as const
						),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([named, params]) =>
						Effect.sync(() => {
							const sql = testSql("SELECT $1::text")
							const statement: FlightStatement = named
								? { server: serverStatement(sql), params }
								: { sql, params }
							const sent = pgBind(statement)
							assert.equal(sent[0], 0x42, "a Bind message")
							assert.equal(sent.readInt32BE(1), bindLength(statement))
							assert.equal(sent.length, 1 + bindLength(statement))
						})
				)
			)
	)

	it("past the limit fails the call with InputTooLarge naming its statement and length, at the limit passes", () => {
		const fits: FlightStatement = { sql: testSql("SELECT $1::text"), params: ["short"] }
		const large: FlightStatement = {
			sql: testSql("SELECT $1::text"),
			params: [Str.repeat(1_000)("x")]
		}
		const length = bindLength(large)
		assert.equal(bindOverrun([fits, large], length), undefined)
		const refused = bindOverrun([fits, large], length - 1)
		assert.ok(refused !== undefined, "a Bind message one byte past the limit is refused")
		assert.equal(refused._tag, "InputTooLarge")
		assert.deepEqual(refused.bound, {
			kind: "message",
			statement: 1,
			bytes: length,
			limit: length - 1
		})
	})
})
