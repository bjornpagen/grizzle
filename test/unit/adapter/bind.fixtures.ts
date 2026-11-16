/** What the properties of bind.test.ts read: its spaces, models and helpers. */

import { Buffer } from "node:buffer"
import { Duplex } from "node:stream"
import { array, codePoint, element, type Gen, int, string, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { Connection } from "pg"
import { type BatchStatement, oneShotStatement, preparedStatement } from "#adapter/wire/batch.ts"
import { prepared } from "#compiler/core/prepared.ts"
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
 *
 * Features: refused at the first statement or a later one; admitted at exactly the limit or below it.
 */

/** The Bind message pg writes for one execution of `statement`, as the bytes it sends. */
export const pgBind = (statement: BatchStatement): Buffer => {
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
		{
			statement: statement._tag === "prepared" ? statement.text.name : "",
			values: [...textsOfParams(statement.params)]
		},
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

/** A statement of a flight with its parameters' texts: a served one, bound by its name, or a one-shot one, unnamed. */
const statementGen: Gen<BatchStatement> = (source) => {
	const params = Arr.map(source.draw(array(text, { min: 0, max: 6 })), paramText)
	const sql = testSql("SELECT $1::text")
	return source.draw(element(["prepared", "oneShot"] as const)) === "prepared"
		? preparedStatement(prepared(sql), params)
		: oneShotStatement(sql, params)
}

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

export const caseGen: Gen<BindCase> = (source) => {
	const first = source.draw(statementGen)
	return {
		statements: [first, ...source.draw(array(statementGen, { min: 0, max: 3 }))],
		at: source.draw(int(0, 3)),
		limit: source.draw(element<LimitAt>(["short of", "at", "past"])),
		past: source.draw(int(1, 64))
	}
}

export type BindFeature =
	| "refused at the first statement"
	| "refused at a later statement"
	| "admitted at exactly the limit"
	| "admitted below the limit"
