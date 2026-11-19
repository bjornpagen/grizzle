/** What the properties of endpoints.test.ts read: its spaces, models and helpers. */

import { Array as Arr, Formatter, Record as Rec, String as Str } from "effect"
import { prepared } from "#compiler/core/prepared.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import type { ServedLive } from "#compiler/served/forms.ts"
import type { LiveBounds, ReadKind } from "#test/support/live/world.ts"
import type { WireWindow } from "#test/support/wire-tap.ts"

export type Feature =
	| `a ${ReadKind} read`
	| "the probe read"
	| "an insert"
	| "a delete"
	| "a put"
	| "a path no route serves"
	| "a method no route serves"
	| "the leader's replication session"
	| "a write naming a family member"
	| "a read of closed relations alone"

export const bounds: LiveBounds = {
	groups: 3,
	orders: 4,
	values: 3,
	keys: 8,
	rows: 5,
	reads: 4,
	subscriptions: 4,
	commits: 0,
	writes: 1,
	window: 3
}

export const cases = 16

/** Every string a JSON value holds, at any depth, keys included. */
export const stringsOf = (value: unknown, into: Set<string>): Set<string> => {
	if (typeof value === "string") {
		into.add(value)
	} else if (isList(value)) {
		for (const item of value) {
			stringsOf(item, into)
		}
	} else if (isRecord(value)) {
		for (const [key, item] of Rec.toEntries(value)) {
			into.add(key)
			stringsOf(item, into)
		}
	}
	return into
}

/** What a session sent that no served file holds, or that runs no named statement, one line each. */
export const strayOf = (session: WireWindow, served: ReadonlySet<string>): ReadonlyArray<string> =>
	Arr.flatMap(session.frontend, (m): ReadonlyArray<string> => {
		if (m.type === "P") {
			return m.name === "" || m.name !== prepared(m.text).name || !served.has(m.text)
				? [`Parse ${Formatter.format(m.name)} of ${Formatter.format(m.text)}`]
				: []
		}
		if (m.type === "B") {
			return m.name === "" ? ["a Bind of the unnamed statement"] : []
		}
		if (m.type === "Q") {
			return served.has(m.text) ? [] : [`Query ${Formatter.format(m.text)}`]
		}
		return m.type === "C" && m.name !== "" ? [`a Close of ${Formatter.format(m.name)}`] : []
	})

/** `slot` quoted as an identifier, as a replication command names it: in double quotes, each double quote doubled. */
const quotedSlot = (slot: string): string => `"${Str.replaceAll('"', '""')(slot)}"`

/** A served file's live source, where it has one. */
type LiveSourceForm = Extract<ServedLive, { readonly kind: "source" }>

/**
 * The texts the leader may send on its replication connection, the served file's live source's own: its lock, its
 * sender-timeout read, and each slot command filled with the one slot the installation's decoder login names, its
 * role (test/support/install-migrate.ts Installed.decoder), as the command's text quotes it.
 */
export const liveTextsOf = (source: LiveSourceForm, slot: string): ReadonlySet<string> =>
	new Set([
		source.lock,
		source.senderTimeout,
		`${source.createSlot.before}${quotedSlot(slot)}${source.createSlot.after}`,
		`${source.start.before}${quotedSlot(slot)}${source.start.after}`
	])

/**
 * The messages a walsender of a database is sent besides simple queries: its startup and authentication, the stream's
 * CopyData (each Standby Status Update) and CopyDone, and its Terminate.
 */
const replicationProtocol: ReadonlySet<string> = new Set(["startup", "p", "d", "c", "X"])

/**
 * What the decoder's replication session sent beyond the protocol's one exception, one line each: a walsender of a
 * database takes simple queries alone, so each of its Queries is exactly one of the served file's live texts
 * (`liveText`), and it sends nothing else but its protocol's own messages (replicationProtocol).
 */
export const replicationStrayOf = (
	session: WireWindow,
	liveText: (text: string) => boolean
): ReadonlyArray<string> =>
	Arr.flatMap(session.frontend, (m): ReadonlyArray<string> => {
		if (m.type === "Q") {
			return liveText(m.text) ? [] : [`Query ${Formatter.format(m.text)}`]
		}
		return replicationProtocol.has(m.type) ? [] : [`a ${Formatter.format(m.type)} message`]
	})
