/** What the properties of source.test.ts read: its spaces, models and helpers. */

import { Array as Arr, Data, Effect, Formatter, Option, Result, String as Str } from "effect"
import { admittedIdentifier } from "#compiler/core/identity.ts"
import { type LiveTable, parseWalPosition } from "#compiler/live/notify.ts"
import {
	type Notification,
	notificationText,
	parseLiveSecret,
	type RouteColumn,
	type RouteTable
} from "#compiler/plan/runtime.ts"
import type { ServedLive } from "#compiler/served/forms.ts"
import type { LiveInstallation } from "#test/support/live/harness.ts"
import {
	type LiveBounds,
	type LiveCommit,
	type LiveFact,
	type LiveWrite,
	relationName,
	writesOf
} from "#test/support/live/world.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

export type Feature =
	| "an insert"
	| "a delete"
	| "an update of an open relation"
	| "a write of a routed table"
	| "a write of a table read whole"
	| "a direct writer's commit"
	| "a grizzle call's commit"
	| "a rolled-back transaction that wrote"
	| "the live source opens"
	| "a login's read of the secret refused"

/** The decoded transactions of a history differ from its commits' route keys: the report says where. */
export class Undecoded extends Data.TaggedError("Undecoded")<{ readonly report: string }> {}

/** A statement of the source's opening refused under the installation's roles, or a login read the secret. */
export class Unopened extends Data.TaggedError("Unopened")<{ readonly report: string }> {}

/** The served live source of an installation that holds one. */
type OpenSource = Extract<ServedLive, { readonly kind: "source" }>

/** Whether a cell the slot check answered is a WAL position's text: a slot that stands has one, its absence none. */
const isWalPosition = (cell: unknown): boolean =>
	typeof cell === "string" && parseWalPosition(cell).ok

/** `sent`, the statement `what` of the opening, its refusal reported by the statement and the server's answer. */
const opening = <A>(what: string, sent: Effect.Effect<A, SqlError>): Effect.Effect<A, Unopened> =>
	Effect.mapError(sent, (e) => new Unopened({ report: `${what}: ${Formatter.format(e.reason)}` }))

/**
 * The source opened as its listener and its leader open it, by each statement they send on an ordinary session of the
 * decoder login, `decoder`, as `served` holds it: the secret's read, which answers one key; the LISTEN; the slot
 * check, which answers of `slot`, a slot the decoder login holds, the WAL position it stands at and the server's
 * (live/notify.ts parseWalPosition), one row; the advisory lock; and the snapshot read and the fan-out, of no
 * payload, whose functions PostgreSQL checks EXECUTE on as it plans them.
 */
export const opens = (
	decoder: RawSession,
	served: OpenSource,
	slot: string
): Effect.Effect<void, Unopened> =>
	Effect.gen(function* () {
		const secret = yield* opening("the secret's read", decoder.values(served.secret.sql, []))
		const [cell, ...rest] = Arr.flatten(secret)
		if (typeof cell !== "string" || rest.length > 0 || !parseLiveSecret(cell).ok) {
			return yield* new Unopened({
				report: `the secret's read answered ${Formatter.format(secret)}`
			})
		}
		yield* opening("the LISTEN", decoder.query(served.listen.sql, []))
		const checked = yield* opening("the slot check", decoder.values(served.check.sql, [slot]))
		const [at, now, ...others] = Arr.flatten(checked)
		if (!isWalPosition(at) || !isWalPosition(now) || others.length > 0) {
			return yield* new Unopened({
				report: `the slot check of ${slot} answered ${Formatter.format(checked)}`
			})
		}
		yield* opening("the advisory lock", decoder.query(served.lock, []))
		yield* opening("the snapshot read", decoder.query(served.snapshot.sql, []))
		yield* opening("the fan-out", decoder.query(served.fanout.sql, [[]]))
	})

/** The secret's read as the login `login`, which PostgreSQL refuses with 42501: what it answered otherwise. */
export const loginRefused = (
	login: RawSession,
	served: OpenSource
): Effect.Effect<void, Unopened> =>
	Effect.flatMap(Effect.result(login.values(served.secret.sql, [])), (read) =>
		Result.isFailure(read) &&
		read.failure.reason._tag === "ServerError" &&
		read.failure.reason.fields.code === "42501"
			? Effect.void
			: Effect.fail(
					new Unopened({
						report: `the login ${login.role}'s read of the secret answered ${Formatter.format(read)}`
					})
				)
	)

export const bounds: LiveBounds = {
	groups: 3,
	orders: 3,
	values: 3,
	keys: 8,
	rows: 4,
	reads: 3,
	subscriptions: 1,
	commits: 6,
	writes: 3,
	window: 2
}

/** The fields of a live fact, each the integer its column holds. */
const factFields = ["id", "g", "o", "val"] as const

/** A table's route keys of one image of a row: its routed columns' keys, or the table's own where none routes it. */
const keysOfImage = (
	table: RouteTable,
	routed: ReadonlyArray<{
		readonly column: RouteColumn
		readonly field: (typeof factFields)[number]
	}>,
	image: LiveFact
): ReadonlyArray<Notification> =>
	Arr.isReadonlyArrayNonEmpty(routed)
		? Arr.map(routed, ({ column, field }) => ({
				kind: "keyed",
				table,
				column,
				value: String(image[field])
			}))
		: [{ kind: "table", table }]

/** The images a write leaves its relation's rows with: an insert's new row, a delete's old one, an update's both. */
const imagesOf = (write: LiveWrite): ReadonlyArray<LiveFact> => {
	switch (write.kind) {
		case "insert":
		case "delete":
			return [write.fact]
		case "update":
			return [write.from, write.to]
	}
}

/** The footprint tables and the views of the installation's live plan, none for a plan of no read. */
const planOf = (
	live: LiveInstallation
): { readonly tables: ReadonlyArray<LiveTable>; readonly views: ReadonlyArray<string> } => {
	const plan = live.installed.installation.live
	return plan.kind === "none" ? { tables: [], views: [] } : plan
}

/**
 * The route keys a commit's writes decode to, by the installation's plan (its live tables and their routes), each text
 * once: none for a commit that wrote no footprint table.
 */
export const expectedKeys = (live: LiveInstallation, commit: LiveCommit): ReadonlySet<string> => {
	const { names } = live.installed
	const { tables } = planOf(live)
	return new Set(
		Arr.flatMap(writesOf(commit), (write) => {
			const relation = relationName(write.relation)
			const planned = Arr.findFirst(tables, (t) => t.relation === relation)
			if (Option.isNone(planned)) {
				return []
			}
			const table = admittedIdentifier<"table">(names.relation(relation).name)
			const routed = Arr.flatMap(factFields, (field) =>
				planned.value.routes.includes(field)
					? [{ column: admittedIdentifier<"column">(names.column(relation, field)), field }]
					: []
			)
			return Arr.flatMap(imagesOf(write), (image) =>
				Arr.map(keysOfImage(table, routed, image), notificationText)
			)
		})
	)
}

/** The installed views of the plan, the only table keys the leader takes from an announcement. */
export const liveViews = (live: LiveInstallation): ReadonlySet<string> => {
	const { names } = live.installed
	return new Set(Arr.map(planOf(live).views, (view) => names.relation(view).name))
}

/** The installed tables of the plan with their routed columns, as the leader keys a decoded row by them. */
export const liveTables = (live: LiveInstallation): ReadonlyMap<string, ReadonlyArray<string>> => {
	const { names } = live.installed
	return new Map(
		Arr.map(planOf(live).tables, (t) => [
			names.relation(t.relation).name,
			Arr.map(t.routes, (field) => names.column(t.relation, field))
		])
	)
}

/** The bytes a lowercase hex text spells, two digits a byte. */
export const bytesOfHex = (hex: string): Uint8Array =>
	Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
		Number.parseInt(Str.slice(i * 2, i * 2 + 2)(hex), 16)
	)
