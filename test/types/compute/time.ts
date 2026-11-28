import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, String as Str } from "effect"
import type { Refused } from "#compiler/core/refusals.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The Time program: every operand Time.wall, Time.epochDay and Time.dateOfEpochDay take or refuse, each a query over
 * Probe, which holds a bigint, an integer, a date, a closed id of Zone, a zone roster (closed.zones), one of Mood, an
 * ordered roster, and an instant, under the directive the type-test batch disarms exactly where the rule refuses it;
 * and what each delivers, read off its query's rows. The rule, the oracle: Time.wall reads a bigint term, never an
 * instant, and a closed id of a zone roster alone, and delivers a bigint; Time.epochDay reads a date term and delivers
 * a number; Time.dateOfEpochDay reads an integer or a bigint term and delivers a CalendarDate; a literal stands first in
 * none. Each statement is a cell of the box.
 */

/** A cell: what it writes, its statement, and the rule's verdict, a refusal its types name or one they name none of. */
interface TimeCase {
	readonly what: string
	readonly statement: string
	readonly verdict:
		| { readonly kind: "admitted" }
		| { readonly kind: "refusal"; readonly refusal: Refused }
		| { readonly kind: "refused"; readonly why: string }
}

const admitted = { kind: "admitted" } as const

/** A query over Probe finding `head`, its variables Probe's fields. */
const over = (head: string): string =>
	`query(S).rule((r) => { const { id, at, n, day, zone, mood, stamp } = v(Probe, "p"); return r.match(Probe, { id, at, n, day, zone, mood, stamp }).find({ id, ${head} }) })`

const boxCases: ReadonlyArray<TimeCase> = [
	{
		what: "a zone's wall clock at a bigint",
		statement: over("w: Time.wall(at, zone)"),
		verdict: admitted
	},
	{
		what: "a wall clock is a bigint",
		statement: `(row: HeadOf<typeof walls>): bigint => row.w`,
		verdict: admitted
	},
	{
		what: "a wall clock is no number",
		statement: `(row: HeadOf<typeof walls>): number => row.w`,
		verdict: { kind: "refused", why: "a wall clock is a bigint" }
	},
	{
		what: "a wall clock at a closed id of an ordered roster",
		statement: over("w: Time.wall(at, mood)"),
		verdict: { kind: "refused", why: "a closed id of no zone roster is no zone" }
	},
	{
		what: "a wall clock at an integer",
		statement: over("w: Time.wall(n, zone)"),
		verdict: { kind: "refused", why: "Time.wall reads a bigint" }
	},
	{
		what: "a wall clock at an instant",
		statement: over("w: Time.wall(stamp, zone)"),
		verdict: {
			kind: "refusal",
			refusal:
				"an instant is the database's clock's alone: no parameter, literal, constant, cast, contract or span is of its type"
		}
	},
	{
		what: "a wall clock at a bigint literal",
		statement: over("w: Time.wall(5n, zone)"),
		verdict: {
			kind: "refusal",
			refusal: "a term first: a literal takes its place opposite a term, never first"
		}
	},
	{ what: "a date's epoch day", statement: over("e: Time.epochDay(day)"), verdict: admitted },
	{
		what: "an epoch day is a number",
		statement: `(row: HeadOf<typeof epochs>): number => row.e`,
		verdict: admitted
	},
	{
		what: "an epoch day of a bigint",
		statement: over("e: Time.epochDay(at)"),
		verdict: { kind: "refused", why: "Time.epochDay reads a date" }
	},
	{
		what: "the date of an integer epoch day",
		statement: over("d: Time.dateOfEpochDay(n)"),
		verdict: admitted
	},
	{
		what: "the date of a bigint epoch day",
		statement: over("d: Time.dateOfEpochDay(at)"),
		verdict: admitted
	},
	{
		what: "an epoch day's date is a CalendarDate",
		statement: `(row: HeadOf<typeof dates>): CalendarDate => row.d`,
		verdict: admitted
	},
	{
		what: "the date of a date",
		statement: over("d: Time.dateOfEpochDay(day)"),
		verdict: { kind: "refused", why: "Time.dateOfEpochDay reads an integer or a bigint" }
	}
]

/** The cells of timeBox, minted as a dictionary in its door (test/types/compute/time.dictionary.ts). */
export const timeBoxItems: Arr.NonEmptyReadonlyArray<TimeCase> = [
	defined(boxCases[0], "a case of the Time box"),
	...Arr.drop(boxCases, 1)
]

/** A cell's directive, where the rule refuses it. */
const directiveOf = (c: TimeCase): ReadonlyArray<string> => {
	switch (c.verdict.kind) {
		case "admitted":
			return []
		case "refusal":
			return [`// @ts-expect-error -- refusal: ${c.verdict.refusal}`]
		case "refused":
			return [`// @ts-expect-error -- refused: ${c.verdict.why}`]
	}
}

const caseBlock = (c: TimeCase, index: number): ReadonlyArray<string> => [
	`// ${c.what}`,
	...directiveOf(c),
	`export const c${index} = ${c.statement}`,
	""
]

/** The program's prelude (test/support/programs/time.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/time.ts"))

/** Zone, a zone roster, Mood, an ordered one, Probe over both, and the three queries whose rows the cells read. */
const timeHeader = `export const Zone = closed.zones("Zone", ["America/Chicago", "Asia/Kolkata"])
export const Mood = closed.ordered("Mood", ["sad", "happy"])
export const Probe = relation("Probe", { id: pg.integer, at: pg.bigint, n: pg.integer, day: date, zone: closedId(Zone), mood: closedId(Mood), stamp: instant }, ["id", "stamp"])
export const S = schema("S", [Zone, Mood, Probe], [])
export const walls = ${over("w: Time.wall(at, zone)")}
export const epochs = ${over("e: Time.epochDay(day)")}
export const dates = ${over("d: Time.dateOfEpochDay(n)")}
`

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const timeProgram = (cells: Arr.NonEmptyReadonlyArray<TimeCase>, entry: Entry): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/compute/time.ts: every operand Time's members take or refuse, and what they deliver.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: Str.split(timeHeader, "\n") },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: caseBlock(c, at) }))
		]
	)
]
