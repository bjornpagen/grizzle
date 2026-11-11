/**
 * The live source decodes exactly what a commit changed: over generated live worlds and their histories
 * (test/support/live/world.ts), each transaction a decoder reads off the installation's publication is one commit of the
 * history that wrote a footprint table, in commit order, and its notifications are exactly the route keys of the rows
 * that commit touched, each row by the image it had before the commit and the one it left; a transaction rolled back
 * decodes to nothing.
 *
 * Each case installs a drawn world as generate drafts it, its live source among its objects (the secret, each footprint
 * table's replica identity, the publication, the decoder login), opens a temporary pgoutput slot as the decoder login,
 * runs the history, each commit a grizzle call of one write member or a SERIALIZABLE transaction of a direct SQL writer,
 * then one direct writer's transaction it rolls back, and reads every change the slot holds through the leader's own
 * reader (adapter/live/pgoutput.ts decodeMessage, adapter/live/changes.ts transactionReader).
 *
 * The oracle is computed on the host from the history alone: each write's images (an insert's new row, a delete's old
 * one, an update's both, an immutable relation's update a delete and an insert), and for each image of a table the
 * plan routes by columns, the keyed key of each routed column at the image's value, the decimal text of its integer, or
 * the table's key for a table the plan reads by no route; a table no live program reads is published by no publication,
 * and decodes to nothing.
 *
 * Plants (~/.cache/grizzle-release/LIVE-TRIGGERS/plants): identity-key.patch (physical/ddl/live.ts identityOf answers
 * the key's identity whatever the routes, so an update of a routed column outside the key decodes no old value of it);
 * publication-short.patch (publishedTables leaves its last footprint table out, whose writes then decode to nothing).
 *
 * Features: an insert, a delete, an update of a mutable relation, an update of an immutable one, a write of a routed
 * table, a write of a table read whole, a direct writer's commit, a grizzle call's commit, a rolled-back transaction
 * that wrote.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, Option, Result, String as Str } from "effect"
import { transactionReader } from "#adapter/live/changes.ts"
import { decodeMessage } from "#adapter/live/pgoutput.ts"
import { admittedIdentifier, identifierOf, identity } from "#compiler/core/identity.ts"
import {
	type Notification,
	notificationText,
	parseLiveSecret,
	type RouteColumn,
	type RouteTable
} from "#compiler/plan/runtime.ts"
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
import { clusterPool } from "#test/support/pg.ts"
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

/** The decoded transactions of a history differ from its commits' route keys: the report says where. */
class Undecoded extends Data.TaggedError("Undecoded")<{ readonly report: string }> {}

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

/**
 * The route keys a commit's writes decode to, by the installation's plan (its live tables and their routes), each text
 * once: none for a commit that wrote no footprint table.
 */
const expectedKeys = (live: LiveInstallation, commit: LiveCommit): ReadonlySet<string> => {
	const { installation, names } = live.installed
	return new Set(
		Arr.flatMap(writesOf(commit), (write) => {
			const relation = relationName(write.relation)
			const planned = Arr.findFirst(installation.live.tables, (t) => t.relation === relation)
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

/** The installed tables of the plan with their routed columns, as the leader keys a decoded row by them. */
const liveTables = (live: LiveInstallation): ReadonlyMap<string, ReadonlyArray<string>> => {
	const { installation, names } = live.installed
	return new Map(
		Arr.map(installation.live.tables, (t) => [
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
								"a rolled-back transaction that wrote"
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
							const live = yield* installLive(c, "live source", clusterPool)
							const { installed } = live
							const publication = identifierOf(identity.liveSource(installed.schema))
							const slot = `${installed.schema}_decoded`
							const decoder = yield* substrate.session(roleSession(installed.decoder()))
							yield* decoder.query(
								"SELECT pg_catalog.pg_create_logical_replication_slot($1::name, 'pgoutput', true)",
								[slot]
							)
							const [[secretCell] = []] = yield* decoder.values(
								`SELECT pg_catalog.encode(s.secret, 'hex') FROM "${installed.schema}"."__live_secret" AS s`,
								[]
							)
							const secret = parseLiveSecret(String(secretCell))
							if (!secret.ok) {
								return yield* new Undecoded({ report: `the secret reads ${secret.error.text}` })
							}
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
							const reader = transactionReader(liveTables(live), publication, secret.value)
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
