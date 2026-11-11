/**
 * Liveness's one grammar: what a committed write changed, as the route keys a live program's runtime routes it by, the
 * payload text that spells a key on the fan-out channel, and that text read back into the key. The side that reads a
 * write's changes prints each key's payload, every side that waits parses it and keys its own subscriptions by the
 * same rule (`subscriptionKey`), so a key one sends and a key a subscription waits on are one value exactly when they
 * are one text.
 */
import { maxIdentifierBytes, admittedIdentifier } from "#compiler/core/identity.ts"
import type { Identifier } from "#compiler/core/ids.ts"
import { notifyPayloadMaxBytes } from "#compiler/core/limits.ts"
import * as Result from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"

/** The channel every live notification of an installation's database is sent on and listened to. */
export const liveChannel = "grizzle"

/** A stored relation's installed table, by its identifier, as a route key names it. */
export type RouteTable = Identifier<"table">

/** A stored relation's field's installed column, by its identifier, as a route key names it. */
export type RouteColumn = Identifier<"column">

/**
 * What a committed write changed of one table, as the runtime routes it:
 *
 * - `keyed`: the rows of `table` whose `column` holds `value`, PostgreSQL's output text of the column's value, among
 *   the rows the write touched, each by the image it had before the write and the one it left;
 * - `table`: rows of `table` that no route narrows: a TRUNCATE, a write of a table no program routes by a column, or
 *   rows whose keyed payload would reach notifyPayloadMaxBytes (`subscriptionKey`).
 *
 * A program fixing `column` of `table` to `value` hears its keyed key and its table's; a program that reads `table`
 * by no route hears every key of `table`.
 */
export type RouteKey =
	| { readonly kind: "table"; readonly table: RouteTable }
	| {
			readonly kind: "keyed"
			readonly table: RouteTable
			readonly column: RouteColumn
			readonly value: string
	  }

/** A payload of the channel that spells no route key: the payload, and what the grammar expected where it parted. */
export interface NotificationRefused {
	readonly payload: string
	readonly expected: string
}

/**
 * The payload of a route key: `<table>:` for a table's key, `<table>:<column>=<value>` for a keyed one. An installed
 * identifier holds neither `:` nor `=`, so the first of each in a payload ends the name before it, and the value is
 * the rest, whatever it holds.
 */
export const payloadOf = (key: RouteKey): string =>
	key.kind === "table" ? `${key.table}:` : `${key.table}:${key.column}=${key.value}`

/**
 * The route key of the rows of `table` whose `column` holds `value`: the keyed key, unless its payload's UTF-8 bytes
 * reach notifyPayloadMaxBytes, which PostgreSQL refuses to send, and then the table's key, which every program reading
 * the table hears. The side that reads the changes sends exactly this key for such rows, so a subscription keyed by it
 * hears them.
 */
export const subscriptionKey = (
	table: RouteTable,
	column: RouteColumn,
	value: string
): RouteKey => {
	const keyed: RouteKey = { kind: "keyed", table, column, value }
	return utf8Length(payloadOf(keyed)) < notifyPayloadMaxBytes.value
		? keyed
		: { kind: "table", table }
}

/**
 * Whether `text` spells an identifier grizzle installs: a readable one, a declared name's conversion, lowercase ASCII
 * letters, digits and underscores led by a letter, or a hashed one, led by `__`; within maxIdentifierBytes, each of its
 * characters one byte.
 */
const isInstalledIdentifier = (text: string): boolean => {
	if (
		text.length > maxIdentifierBytes.value ||
		!(isLetter(text.charCodeAt(0)) || text.startsWith("__"))
	) {
		return false
	}
	for (let at = 1; at < text.length; at += 1) {
		const unit = text.charCodeAt(at)
		if (!(isLetter(unit) || isDigit(unit) || unit === underscore)) {
			return false
		}
	}
	return true
}

const underscore = 0x5f

const isLetter = (unit: number): boolean => unit >= 0x61 && unit <= 0x7a

const isDigit = (unit: number): boolean => unit >= 0x30 && unit <= 0x39

const refused = (payload: string, expected: string): Result.Result<never, NotificationRefused> =>
	Result.err({ payload, expected })

/**
 * The route key a payload spells (`payloadOf`), or what it parts from the grammar at: a table's identifier and `:`,
 * then nothing for the table's key, or a column's identifier, `=` and the value.
 */
export const parseNotification = (
	payload: string
): Result.Result<RouteKey, NotificationRefused> => {
	const colon = payload.indexOf(":")
	const table = payload.slice(0, Math.max(0, colon))
	if (colon < 0 || !isInstalledIdentifier(table)) {
		return refused(payload, "an installed table's identifier, then ':'")
	}
	const route = payload.slice(colon + 1)
	if (route.length === 0) {
		return Result.ok({ kind: "table", table: admittedIdentifier<"table">(table) })
	}
	const equals = route.indexOf("=")
	const column = route.slice(0, Math.max(0, equals))
	if (equals < 0 || !isInstalledIdentifier(column)) {
		return refused(payload, "nothing after ':', or an installed column's identifier, then '='")
	}
	return Result.ok({
		kind: "keyed",
		table: admittedIdentifier<"table">(table),
		column: admittedIdentifier<"column">(column),
		value: route.slice(equals + 1)
	})
}

/**
 * A footprint table: a stored relation some served program reads, by its declared name, and the declared fields of it
 * some program fixes to a parameter and routes by, each once, in code point order; none where every change of it
 * routes by its table alone.
 */
export interface LiveTable {
	readonly relation: string
	readonly routes: ReadonlyArray<string>
}

/** Each footprint table of an installation's served programs once, by relation in code point order. */
export type LivePlan = ReadonlyArray<LiveTable>

/** The plan of an installation that serves no live program. */
export const noLive: LivePlan = []
