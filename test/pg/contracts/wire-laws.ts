/**
 * The plan contracts' laws over the wire of what a drawn shape's calls send (observed.ts): the texts each call parses
 * and binds (C5) and how many statements it executes (C6), each a list of the problems it finds, none where the
 * contract holds.
 */

import { Array as Arr, String as Str } from "effect"
import { lexemesOf } from "#compiler/sql/lexer.ts"
import type { Observed } from "#test/pg/contracts/observed.ts"
import { carriedWrite, strataWrite } from "#test/pg/contracts/shapes.ts"

/** The strata a write orders: the one-stratum writes' one, the two-strata and carried writes' two. */
const strataCount = (write: string): number =>
	write === strataWrite || write === carriedWrite ? 2 : 1

/** The bindings a write carries past its stratum: the carried write's `held`. */
const carriedCount = (write: string): number => (write === carriedWrite ? 1 : 0)

/** Whether a statement's text names a temporary object: `pg_temp`, or a session's own temporary schema, as a word or quoted. */
const namesTemporary = (text: string): boolean =>
	Arr.some(
		lexemesOf(text).lexemes,
		(l) =>
			(l.kind === "word" || l.kind === "quotedIdent") &&
			Str.startsWith("pg_temp")(Str.toLowerCase(l.text))
	)

/**
 * Whether a statement is a carrier's own step: it fills a temporary table (INSERT INTO), or empties one (TRUNCATE, or a
 * call of the session function that empties it, a SELECT of no FROM).
 */
const carrierStep = (text: string): boolean => {
	const words = Arr.flatMap(lexemesOf(text).lexemes, (l) => (l.kind === "word" ? [l.upper] : []))
	return (
		namesTemporary(text) &&
		((words[0] === "INSERT" && words[1] === "INTO") ||
			words[0] === "TRUNCATE" ||
			(words[0] === "SELECT" && !words.includes("FROM")))
	)
}

/**
 * C5, plan once: a call's statement text names no per-session object, so it is one statement on every session: one
 * text, one prepared name, one entry pg_stat_statements and a budget hold it by. A text that reads a temporary relation
 * or calls a temporary function resolves to another object on each session, so each session's statement is a new one,
 * planned anew. A carrier's own steps, its fill and its emptying, write the carrier and are the carrier; no other
 * statement may read it by its temporary name.
 */
export const planOnce = (o: Observed): ReadonlyArray<string> =>
	Arr.flatMap(o.calls, (call) =>
		Arr.flatMap(call.sent, (sent) =>
			namesTemporary(sent.text) && !carrierStep(sent.text)
				? [
						`${call.program}'s ${sent.name} names a per-session object: ${Str.slice(0, 160)(sent.text)}`
					]
				: []
		)
	)

/**
 * C6, statements per action: a call sends the statements its action's shape needs and no more: its Db's prologue (the
 * ledger's fence and the snapshot's guard), one statement per stratum its program orders, and one fill for each binding
 * it carries past its stratum, a read one statement in all. A stand-up is a session's, sent at its first call of a write
 * alone; a delta's bookkeeping and a judge run inside the statements and the COMMIT, never as statements of their own.
 */
export const statementsPerAction = (o: Observed): ReadonlyArray<string> =>
	Arr.flatMap(o.calls, (call) => {
		const bound =
			2 + (call.kind === "read" ? 1 : strataCount(call.program) + carriedCount(call.program))
		const sent = call.prologue + call.sent.length
		return [
			...(call.sent.length === call.stated
				? []
				: [
						`${call.program} sent ${call.sent.length} statements past its prologue, where its compiler states ${call.stated}`
					]),
			...(sent <= bound
				? []
				: [
						`${call.program} sent ${sent} statements, past its shape's ${bound}: ${Arr.join(
							Arr.map(call.sent, (x) => Str.slice(0, 80)(x.text)),
							" | "
						)}`
					])
		]
	})
