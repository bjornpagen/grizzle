/** What the properties of routing.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Data, Formatter, Option, Record as Rec } from "effect"
import { servedFile } from "#compiler/served/json.ts"
import { succeeded } from "#test/support/assert.ts"
import type { LiveInstallation } from "#test/support/live/harness.ts"
import {
	expectedRoutes,
	groupOf,
	type LiveBounds,
	type LiveSubscription,
	type ReadKind,
	readMember,
	relationName
} from "#test/support/live/world.ts"
import type { FrontendMessage, WireWindow } from "#test/support/wire-tap.ts"

export class Misrouted extends Data.TaggedError("Misrouted")<{ readonly report: string }> {}

export type Feature =
	| "a forged plaintext notification"
	| "a tampered sealed notification"
	| "a touched and an untouched subscription of one relation"
	| "a commit touching several subscriptions"
	| "an update moving a row between groups"
	| `a ${ReadKind} read`
	| "a direct writer's commit"
	| "a grizzle call's commit"
	| "a sealed copy of the last fence's notification"

export const bounds: LiveBounds = {
	groups: 3,
	orders: 4,
	values: 3,
	keys: 8,
	rows: 5,
	reads: 3,
	subscriptions: 5,
	commits: 4,
	writes: 3,
	window: 3
}

export const cases = 20

/** A Bind as a re-run sends it: the statement it names and the values it binds, as the wire carries them. */
const bindText = (message: FrontendMessage): string =>
	`${message.name}(${Arr.join(
		Arr.map(message.params, (p) => (p === null ? "NULL" : Formatter.format(p))),
		","
	)})`

/** Where every session of the tap stands: how many frontend messages each has sent, in session order. */
type Marks = ReadonlyArray<number>

/** The tap's marks now. */
export const marksOf = (sessions: ReadonlyArray<WireWindow>): Marks =>
	Arr.map(sessions, (session) => session.frontend.length)

/** Every Bind every session of the tap sent since `marks`, a session opened since counting from its start. */
export const bindsSince = (
	sessions: ReadonlyArray<WireWindow>,
	marks: Marks
): ReadonlyArray<string> =>
	Arr.flatMap(sessions, (session, i) =>
		Arr.flatMap(session.frontend.slice(marks[i] ?? 0), (m) => (m.type === "B" ? [bindText(m)] : []))
	)

/** How many of `seen` are `signature`'s Binds: a multiset count. */
export const countOf = (seen: ReadonlyArray<string>, signature: ReadonlyArray<string>): number =>
	Arr.filter(seen, (b) => signature.includes(b)).length

/** The served footprint each read records, against the routes its program states (world.ts expectedRoutes). */
export const footprintsHold = (live: LiveInstallation): void => {
	const file = succeeded(servedFile(live.json), "the served file")
	const app = defined(
		Option.getOrUndefined(Arr.findFirst(file.roles, (r) => r.name === "app")),
		"the served role app"
	)
	for (const [place, read] of live.c.reads.entries()) {
		const member = defined(
			Option.getOrUndefined(Arr.findFirst(app.members, (m) => m.name === readMember(place))),
			`the served member ${readMember(place)}`
		)
		if (member.kind !== "read" && member.kind !== "paged") {
			return assert.fail(`${readMember(place)} serves a read, not a ${member.kind}`)
		}
		const expected = Rec.fromEntries(
			Arr.map(expectedRoutes(read), (e) => {
				const table = defined(live.installed.plan.tables[relationName(e.relation)], "a table")
				return [
					table.name.name,
					Rec.fromEntries(
						Arr.map(e.routes, (field) => [
							defined(
								Option.getOrUndefined(Arr.findFirst(table.columns, (col) => col.field === field)),
								`${table.relation}.${field}`
							).column,
							field
						])
					)
				] as const
			})
		)
		assert.deepEqual(
			member.read.live,
			Rec.isEmptyRecord(expected) ? { kind: "constant" } : { kind: "routed", footprint: expected },
			`${readMember(place)} (${Formatter.format(read)}) routes as its program fixes its parameter`
		)
	}
}

/**
 * Notifications no holder of the live secret sealed, sent on the fan-out channel as any session may send them: for each
 * subscription that binds a group, the plaintext route key of its group in a relation it reads, as an unsealed fan-out
 * would spell it (live/notify.ts), and every payload the leader sealed so far, `genuine`, with one character of its text
 * changed, a tampering its seal must refuse. Only the leader's own payloads are tampered, each once from its original:
 * a payload the case sent itself, a forgery of an earlier step tampered again, can come back to the original, as `A`
 * turned `B` and back, which is a copy of a sealed payload, no forgery, and which the listener rightly opens (the Misrouted
 * reds of routing at 0b7b5f31 and 4c9ce8f7: such a copy of a commit's payload marked its subscriptions after the step,
 * and one of a fence's let a later fence pass early).
 */
export const forgeries = (
	live: LiveInstallation,
	registered: ReadonlyArray<{ readonly s: LiveSubscription }>,
	genuine: ReadonlyArray<string>
): { readonly payloads: ReadonlyArray<string>; readonly kinds: ReadonlyArray<Feature> } => {
	const plain = Arr.flatMap(registered, ({ s }) => {
		const group = groupOf(s)
		const read = Arr.getUnsafe(live.c.reads, s.read)
		if (group === undefined) {
			return []
		}
		const table = defined(live.installed.plan.tables[relationName(read.relation)], "a table")
		const column = defined(
			Option.getOrUndefined(Arr.findFirst(table.columns, (col) => col.field === "g")),
			`${table.relation}.g`
		)
		return [`${table.name.name}:${column.column}=${group}`]
	})
	const tampered = Arr.map(genuine, (payload) => {
		const characters = Arr.fromIterable(payload)
		const at = characters.length >> 1
		return Arr.join(
			Arr.map(characters, (character, i) => (i !== at ? character : character === "A" ? "B" : "A")),
			""
		)
	})
	return {
		payloads: [...plain, ...tampered],
		kinds: [
			...(Arr.isReadonlyArrayNonEmpty(plain) ? ["a forged plaintext notification" as const] : []),
			...(Arr.isReadonlyArrayNonEmpty(tampered) ? ["a tampered sealed notification" as const] : [])
		]
	}
}
