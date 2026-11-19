/** What the properties of params-argument.test.ts read: its spaces, models and helpers. */

import { Array as Arr, Effect } from "effect"
import type { CallError } from "#compiler/live/index.ts"

/**
 * A program's parameter argument at an opened Db, a read's and a ChangeSet's: the argument, its call input's `params`,
 * is a record, read by the program's declared names (adapter/reader/params.ts readParams). Any other value a JavaScript
 * caller passes, which ParamArg refuses (types/core/phantom.ts), is refused at encode as an `input` CallError, a read's
 * and a write's alike, whether or not the program declares a parameter: undefined, null, a number, a string, a boolean,
 * a bigint, a symbol, a function or an array, the last two even holding the parameters as properties. A record, plain
 * or frozen, answers. A record with a key naming no declared parameter, which ParamArg refuses too, is refused the same
 * way by every program, and answered by a key member, whose argument may be a whole fact.
 *
 * The calls cover each door to the shared boundary, each a served member's once on a served Db: a read and a window of
 * a query without parameters (reader/params.ts hostParams), a read of a query with one, a key member (its values read
 * through readKeyValues, which projects the key's fields), and a write of a ChangeSet without parameters and of one with
 * a read-back's parameter (apply/run.ts declaredParams), each as a JavaScript caller reaches it. Every call meets every
 * argument kind (exhaust), each kind built for that call: a record holds the program's live parameters, `{}` for one
 * without any.
 *
 * - Oracle: the specification turned into a checker, ParamArg's refusals restated over the argument kinds.
 */
export const calls = [
	"a read without parameters",
	"a window without parameters",
	"a read with a parameter",
	"a key member",
	"a write without parameters",
	"a write with a parameter"
] as const

export type Call = (typeof calls)[number]

const records = ["a record", "a frozen record"] as const

/** A record of the read's live parameters and one key no parameter is named. */
export const strayKey = "a record with a key naming no parameter"

export const nonRecords = [
	"undefined",
	"null",
	"a number",
	"a string",
	"a boolean",
	"a bigint",
	"a symbol",
	"a function holding the parameters",
	"an array holding the parameters"
] as const

type NonRecord = (typeof nonRecords)[number]

type ArgumentKind = (typeof records)[number] | typeof strayKey | NonRecord

export const argumentKinds: Arr.NonEmptyReadonlyArray<ArgumentKind> = [
	...records,
	strayKey,
	...nonRecords
]

export type ArgumentFeature =
	| `${Call}: ${"a record answered" | "no record refused"}`
	| `${NonRecord} refused`
	| "a stray key refused"
	| "a key member: a stray key answered"

/**
 * Whether `call` answers an argument of `kind`: every read answers a record of its live parameters; a stray key is
 * answered only by a key member, whose key is read off a fact by its fields; no other value is.
 */
export const answers = (call: Call, kind: ArgumentKind): boolean =>
	kind === "a record" ||
	kind === "a frozen record" ||
	(kind === strayKey && call === "a key member")

export const isNonRecord = (kind: ArgumentKind): kind is NonRecord =>
	Arr.some(nonRecords, (k) => k === kind)

/** The argument of `kind` for a read whose live parameters are `live`. */
export const argumentOf = (
	kind: ArgumentKind,
	live: Readonly<Record<string, unknown>>
): unknown => {
	switch (kind) {
		case "a record":
			return { ...live }
		case "a frozen record":
			return Object.freeze({ ...live })
		case strayKey:
			return { ...live, x: 1 }
		case "undefined":
			return undefined
		case "null":
			return null
		case "a number":
			return 42
		case "a string":
			return "account"
		case "a boolean":
			return true
		case "a bigint":
			return 1n
		case "a symbol":
			return Symbol("params")
		case "a function holding the parameters":
			return Object.assign(() => undefined, live)
		case "an array holding the parameters":
			return Object.assign([], live)
	}
}

/** A program, its live parameters, and the call that passes it an argument. */
export interface Read {
	readonly live: Readonly<Record<string, unknown>>
	readonly call: (argument: unknown) => Effect.Effect<unknown, CallError>
}
