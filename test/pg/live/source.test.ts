/**
 * The live source decodes exactly what a commit changed: over generated live worlds and their histories
 * (test/support/live/world.ts), each transaction a decoder reads off the installation's publication is one commit of the
 * history that wrote a footprint table, in commit order, and its notifications are exactly the route keys of the rows
 * that commit touched, each row by the image it had before the commit and the one it left; a transaction rolled back
 * decodes to nothing.
 *
 * Each case installs a drawn world as generate drafts it, its live source among its objects (the secret, each footprint
 * table's replica identity, the publication, the decoder login), through migrate's survey on a member at PostgreSQL
 * 19's default wal_level, replica, which the case reads first; opens a temporary pgoutput slot as the decoder login,
 * which turns logical decoding on by itself at that level; and opens the source as its listener and its leader do, under the installation's own roles: as the decoder login, each
 * statement they send on an ordinary session, as the served file holds it, where the secret's read answers a key, the
 * slot check answers the WAL position the decoder's own slot stands at, and the LISTEN, the advisory lock, the snapshot read and the
 * fan-out run; as the login, the secret's read refused (42501), since a login that held the key could seal a payload
 * every listener takes for its leader's. Then it runs the history, each commit a grizzle call of one write member or a
 * SERIALIZABLE transaction of a direct SQL writer, then one direct writer's transaction it rolls back, and reads every
 * change the slot holds through the leader's own reader (adapter/live/pgoutput.ts decodeMessage,
 * adapter/live/changes.ts transactionReader).
 *
 * The oracle is computed on the host from the history alone: each write's images (an insert's new row, a delete's old
 * one, an update's both), and for each image of a table the
 * plan routes by columns, the keyed key of each routed column at the image's value, the decimal text of its integer, or
 * the table's key for a table the plan reads by no route; a table no live program reads is published by no publication,
 * and decodes to nothing.
 *
 * Features: an insert, a delete, an update of an open relation, a write of a routed
 * table, a write of a table read whole, a direct writer's commit, a grizzle call's commit, a rolled-back transaction
 * that wrote, the live source opens, a login's read of the secret refused.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import { transactionReader } from "#adapter/live/changes.ts"
import { decodeMessage } from "#adapter/live/pgoutput.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { notificationText } from "#compiler/plan/runtime.ts"
import {
	bounds,
	bytesOfHex,
	expectedKeys,
	type Feature,
	liveTables,
	loginRefused,
	opens,
	Undecoded,
	Unopened
} from "#test/pg/live/source.fixtures.ts"
import { commitLive, worldSurfaces } from "#test/support/live/calls.ts"
import { commitStatements } from "#test/support/live/direct.ts"
import { installLive } from "#test/support/live/harness.ts"
import { type LiveCase, liveCaseGen, statesOf, writesOf } from "#test/support/live/world.ts"
import { clusterPool } from "#test/support/pg.ts"
import { roleSession, Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * The live source decodes each commit's transaction to exactly its rows' route keys, and a rollback to nothing, over generated histories.
 */
export const theLiveSourceDecodesEachCommitsTransactionToExactlyItsRowsRouteKeysAndARollbackToNothingOverCasesGeneratedHistories =
	property.explore(liveCaseGen(bounds), {
		needs: { substrate2: Substrate.fresh(baseSubstrate) },
		situations: [
			"an insert",
			"a delete",
			"an update of an open relation",
			"a write of a routed table",
			"a write of a table read whole",
			"a direct writer's commit",
			"a grizzle call's commit",
			"a rolled-back transaction that wrote",
			"the live source opens",
			"a login's read of the secret refused"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate2 }, notes: Case<Feature>) =>
			(c: LiveCase) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						const live = yield* installLive(c, "live_source", clusterPool)
						const { installed } = live
						const publication = identifierOf(identity.liveSource(installed.schema))
						const slot = `${installed.schema}_decoded`
						const decoder = yield* substrate.session(roleSession(installed.decoder()))
						const walLevel = yield* decoder.values(
							"SELECT pg_catalog.current_setting('wal_level')",
							[]
						)
						assert.deepEqual(
							walLevel,
							[["replica"]],
							"the member runs PostgreSQL 19's default wal_level, replica, where the slot turns logical decoding on by itself"
						)
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
									commit.writer === "psql" ? "a direct writer's commit" : "a grizzle call's commit"
								)
								for (const write of writesOf(commit)) {
									notes.note(
										write.kind === "update"
											? "an update of an open relation"
											: write.kind === "insert"
												? "an insert"
												: "a delete"
									)
								}
								yield* commitLive(live, surfaces.inProcess, commit)
							}
						}).pipe(withLayer(live.layer))
						const last = Arr.lastNonEmpty(statesOf(c))
						const held = Arr.findFirst(
							[0, 1] as const,
							(place) => c.mutable[place] && Arr.isReadonlyArrayNonEmpty(last[place])
						)
						if (Option.isSome(held)) {
							const [fact] = last[held.value]
							if (fact !== undefined) {
								notes.note("a rolled-back transaction that wrote")
								yield* live.writer.begin
								for (const sql of commitStatements(installed.plan, {
									writer: "psql",
									writes: [{ kind: "delete", relation: held.value, fact }]
								})) {
									yield* live.writer.query(sql, [])
								}
								yield* live.writer.rollback
							}
						}
						const rows = yield* decoder.values(
							"SELECT pg_catalog.encode(data, 'hex') FROM pg_catalog.pg_logical_slot_get_binary_changes($1::name, NULL, NULL, 'proto_version', '1', 'publication_names', $2::text)",
							[slot, `"${publication}"`]
						)
						const reader = transactionReader(liveTables(live), identifierOf(identity.ledger()))
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
					}).pipe(Effect.scoped),
					Substrate,
					Effect.map(substrate2, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "each commit's writes' images keyed by the plan's routes, on the host"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/migrate/live.ts",
				original:
					'\tlevel === "minimal" ? Option.some(new WalLevelMinimal({ schema })) : Option.none()',
				replacement:
					'\tlevel !== "logical" ? Option.some(new WalLevelMinimal({ schema })) : Option.none()',
				why: "migrate refuses a live source below wal_level = logical, as before PostgreSQL 19's automatic activation, so no world installs on the member at replica and every case fails at its install."
			}
		]
	})
