/**
 * The live source decodes exactly what a commit changed: over generated live worlds and their histories
 * (test/support/live/world.ts), each transaction a decoder reads off the installation's publication is one commit of the
 * history that wrote a footprint table, in commit order, and its notifications are exactly the route keys of the rows
 * that commit touched, each row by the image it had before the commit and the one it left; a transaction rolled back
 * decodes to nothing.
 *
 * Each case installs a drawn world as generate drafts it, its live source among its objects (the secret, each footprint
 * table's replica identity, the publication, the decoder login), opens a temporary pgoutput slot as the decoder login,
 * opens the source as its listener and its leader do, under the installation's own roles: as the decoder login, each
 * statement they send on an ordinary session, as the served file holds it, where the secret's read answers a key, the
 * slot check answers the WAL position the decoder's own slot stands at, and the LISTEN, the advisory lock, the visibility read and the
 * fan-out run; as the login, the secret's read refused (42501), since a login that held the key could seal a payload
 * every listener takes for its leader's. Then it runs the history, each commit a grizzle call of one write member or a
 * SERIALIZABLE transaction of a direct SQL writer, then one direct writer's transaction it rolls back, and reads every
 * change the slot holds through the leader's own reader (adapter/live/pgoutput.ts decodeMessage,
 * adapter/live/changes.ts transactionReader).
 *
 * The oracle is computed on the host from the history alone: each write's images (an insert's new row, a delete's old
 * one, an update's both, an immutable relation's update a delete and an insert), and for each image of a table the
 * plan routes by columns, the keyed key of each routed column at the image's value, the decimal text of its integer, or
 * the table's key for a table the plan reads by no route; a table no live program reads is published by no publication,
 * and decodes to nothing.
 *
 * Plants (~/.cache/grizzle-release/LIVE-TRIGGERS/plants): identity-key.patch (physical/ddl/live.ts identityOf answers
 * the key's identity whatever the routes, so an update of a routed column outside the key decodes no old value of it);
 * publication-short.patch (publishedTables leaves its last footprint table out, whose writes then decode to nothing);
 * usage-dropped.patch (the decoder login's privileges leave out USAGE on the root's schema, so its secret's read is
 * refused and the source does not open); ledger-unpublished.patch (deploy/ledger/ledger.ts publishingLedger leaves the
 * migrations ledger out of the publication, which the installation's posture check refuses as ledgerUnpublished).
 *
 * Features: an insert, a delete, an update of a mutable relation, an update of an immutable one, a write of a routed
 * table, a write of a table read whole, a direct writer's commit, a grizzle call's commit, a rolled-back transaction
 * that wrote, the live source opens, a login's read of the secret refused.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Data, Effect, Formatter, Option, Result, String as Str } from "effect"
import { transactionReader } from "#adapter/live/changes.ts"
import { decodeMessage } from "#adapter/live/pgoutput.ts"
import { admittedIdentifier, identifierOf, identity } from "#compiler/core/identity.ts"
import { type LiveTable, parseWalPosition } from "#compiler/live/notify.ts"
import {
	type Notification,
	notificationText,
	parseLiveSecret,
	type RouteColumn,
	type RouteTable
} from "#compiler/plan/runtime.ts"
import type { ServedLive } from "#compiler/served/forms.ts"
import { caseHang } from "#test/support/limits.ts"
import { commitLive, worldSurfaces } from "#test/support/live/calls.ts"
import { commitStatements } from "#test/support/live/direct.ts"
import { installLive, type LiveInstallation } from "#test/support/live/harness.ts"
import {
	type LiveBounds,
	type LiveCase,
	type LiveCommit,
	type LiveFact,
	type LiveWrite,
	liveCaseGen,
	relationName,
	statesOf,
	writesOf
} from "#test/support/live/world.ts"
import { clusterPool, type SqlError } from "#test/support/pg.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { roleSession, Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

type Feature =
	| "an insert"
	| "a delete"
	| "an update of a mutable relation"
	| "an update of an immutable relation"
	| "a write of a routed table"
	| "a write of a table read whole"
	| "a direct writer's commit"
	| "a grizzle call's commit"
	| "a rolled-back transaction that wrote"
	| "the live source opens"
	| "a login's read of the secret refused"

/** The decoded transactions of a history differ from its commits' route keys: the report says where. */
class Undecoded extends Data.TaggedError("Undecoded")<{ readonly report: string }> {}

/** A statement of the source's opening refused under the installation's roles, or a login read the secret. */
class Unopened extends Data.TaggedError("Unopened")<{ readonly report: string }> {}

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
 * (live/notify.ts parseWalPosition), one row; the advisory lock; and the visibility read and
 * the fan-out, of no transaction and no payload, whose functions PostgreSQL checks EXECUTE on as it plans them.
 */
const opens = (
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
		yield* opening("the visibility read", decoder.query(served.visible.sql, [[]]))
		yield* opening("the fan-out", decoder.query(served.fanout.sql, [[]]))
	})

/** The secret's read as the login `login`, which PostgreSQL refuses with 42501: what it answered otherwise. */
const loginRefused = (login: RawSession, served: OpenSource): Effect.Effect<void, Unopened> =>
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

const bounds: LiveBounds = {
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

const cases = 24

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
const expectedKeys = (live: LiveInstallation, commit: LiveCommit): ReadonlySet<string> => {
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
const liveViews = (live: LiveInstallation): ReadonlySet<string> => {
	const { names } = live.installed
	return new Set(Arr.map(planOf(live).views, (view) => names.relation(view).name))
}

/** The installed tables of the plan with their routed columns, as the leader keys a decoded row by them. */
const liveTables = (live: LiveInstallation): ReadonlyMap<string, ReadonlyArray<string>> => {
	const { names } = live.installed
	return new Map(
		Arr.map(planOf(live).tables, (t) => [
			names.relation(t.relation).name,
			Arr.map(t.routes, (field) => names.column(t.relation, field))
		])
	)
}

/** The bytes a lowercase hex text spells, two digits a byte. */
const bytesOfHex = (hex: string): Uint8Array =>
	Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
		Number.parseInt(Str.slice(i * 2, i * 2 + 2)(hex), 16)
	)

layer(Substrate.layer)("the live source", (it) => {
	it.effect(
		`decodes each commit's transaction to exactly its rows' route keys, and a rollback to nothing, over ${cases} generated histories`,
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "each commit's writes' images keyed by the plan's routes, on the host"
						},
						suite: "pg/live/source",
						draw: drawn(liveCaseGen(bounds)),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"an insert",
								"a delete",
								"an update of a mutable relation",
								"an update of an immutable relation",
								"a write of a routed table",
								"a write of a table read whole",
								"a direct writer's commit",
								"a grizzle call's commit",
								"a rolled-back transaction that wrote",
								"the live source opens",
								"a login's read of the secret refused"
							],
							{ cases: 48, sense: notesOnly }
						),
						kept: [],
						runs: cases,
						shrink: { kind: "bounded", candidates: 60 },
						concurrency: 1,
						steerEvery: 8,
						caseHang
					},
					(c: LiveCase, notes) =>
						Effect.gen(function* () {
							const substrate = yield* Substrate
							const live = yield* installLive(c, "live_source", clusterPool)
							const { installed } = live
							const publication = identifierOf(identity.liveSource(installed.schema))
							const slot = `${installed.schema}_decoded`
							const decoder = yield* substrate.session(roleSession(installed.decoder()))
							yield* decoder.query(
								"SELECT pg_catalog.pg_create_logical_replication_slot($1::name, 'pgoutput', true)",
								[slot]
							)
							const served = live.file.file.live
							if (served.kind === "none") {
								return yield* new Unopened({
									report: `the served file of a world that reads holds no live source\n${Formatter.format(c)}`
								})
							}
							yield* opens(decoder, served, slot)
							notes.note("the live source opens")
							const login = yield* substrate.session(roleSession(installed.as(live.world.server)))
							yield* loginRefused(login, served)
							notes.note("a login's read of the secret refused")
							yield* Effect.gen(function* () {
								const surfaces = yield* worldSurfaces(live)
								for (const commit of c.history) {
									notes.note(
										commit.writer === "psql"
											? "a direct writer's commit"
											: "a grizzle call's commit"
									)
									for (const write of writesOf(commit)) {
										notes.note(
											write.kind === "update"
												? c.mutable[write.relation]
													? "an update of a mutable relation"
													: "an update of an immutable relation"
												: write.kind === "insert"
													? "an insert"
													: "a delete"
										)
									}
									yield* commitLive(live, surfaces.inProcess, commit)
								}
							}).pipe(withLayer(live.layer))
							const last = Arr.lastNonEmpty(statesOf(c))
							const held = Arr.findFirst([0, 1] as const, (place) =>
								Arr.isReadonlyArrayNonEmpty(last[place])
							)
							if (Option.isSome(held)) {
								const [fact] = last[held.value]
								if (fact !== undefined) {
									notes.note("a rolled-back transaction that wrote")
									yield* live.writer.begin
									for (const sql of commitStatements(installed.plan, c, {
										writer: "psql",
										writes: [{ kind: "delete", relation: held.value, fact }]
									})) {
										yield* live.writer.query(sql, [])
									}
									yield* live.writer.rollback
								}
							}
							const rows = yield* decoder.values(
								"SELECT pg_catalog.encode(data, 'hex') FROM pg_catalog.pg_logical_slot_get_binary_changes($1::name, NULL, NULL, 'proto_version', '1', 'publication_names', $2::text, 'messages', 'true')",
								[slot, `"${publication}"`]
							)
							const reader = transactionReader(
								liveTables(live),
								liveViews(live),
								publication,
								identifierOf(identity.ledger())
							)
							const decoded: Array<ReadonlySet<string>> = []
							for (const [hex] of rows) {
								const message = decodeMessage(bytesOfHex(String(hex)))
								if (Result.isFailure(message)) {
									return yield* new Undecoded({ report: Formatter.format(message.failure) })
								}
								const read = reader.read(message.success)
								if (Result.isFailure(read)) {
									return yield* new Undecoded({ report: read.failure.message })
								}
								if (read.success !== undefined) {
									decoded.push(new Set(Arr.map(read.success.notifications, notificationText)))
								}
							}
							const expected = Arr.filter(
								Arr.map(c.history, (commit) => expectedKeys(live, commit)),
								(keys) => keys.size > 0
							)
							for (const keys of expected) {
								for (const text of keys) {
									notes.note(
										Str.endsWith(":")(text)
											? "a write of a table read whole"
											: "a write of a routed table"
									)
								}
							}
							const same =
								decoded.length === expected.length &&
								Arr.every(decoded, (keys, i) => {
									const want = Arr.getUnsafe(expected, i)
									return keys.size === want.size && Arr.every([...keys], (k) => want.has(k))
								})
							if (!same) {
								return yield* new Undecoded({
									report: `decoded ${Formatter.format(Arr.map(decoded, (s) => [...s]))}\nexpected ${Formatter.format(Arr.map(expected, (s) => [...s]))}\n${Formatter.format(c)}`
								})
							}
						}).pipe(Effect.scoped)
				)
			)
	)
})
