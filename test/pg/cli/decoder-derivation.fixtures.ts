/** What the properties of decoder-derivation.test.ts read: its spaces, models and helpers. */

import { maxIdentifierBytes } from "@bjornpagen/grizzle-engine/core/identity"
import type { Case } from "@bjornpagen/testing/explore"
import { awaitFact } from "@bjornpagen/testing/fact"
import { array, boolean, element, type Gen, string } from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Formatter,
	Option,
	Order,
	Queue,
	Record as Rec,
	String as Str,
	Stream
} from "effect"
import { decodeMeta } from "#adapter/boundary/meta.ts"
import { CredentialError } from "#adapter/errors/failures.ts"
import { Db } from "#adapter/public/db.ts"
import { roleNameOf } from "#adapter/served/served.ts"
import { decode, noRevivers } from "#compiler/core/canonical.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { metaFileName, type MigrationMeta, writeMeta } from "#compiler/deploy/render/folder.ts"
import { joinedSnapshot, snapshotFingerprint } from "#compiler/deploy/snapshot/build.ts"
import { manifestFileName, snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { fold, opening, type SetEvent } from "#compiler/live/index.ts"
import { defineConfig } from "#index.ts"
import { shopV1, type ShopWorkload } from "#test/pg/cli/fixture.ts"
import {
	cliClock,
	cliOver,
	type CliRun,
	configName,
	connectionOf,
	ownerOn,
	servedAt,
	workspace
} from "#test/pg/cli/support.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { answered, oneOf } from "#test/support/calls.ts"
import { type DecoderCredential, servedSourcedLayer } from "#test/support/live-layer.ts"
import { standing } from "#test/support/live/standing.ts"
import {
	clusterConnection,
	clusterPool,
	freshDatabase,
	type PgConnection
} from "#test/support/pg.ts"
import { uniqueSchemaName } from "#test/support/substrate/names.ts"
import { connect, ownerCredentials } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify } from "#test/support/worlds.ts"

/** The clock the in-process command lines of this file read, so a case's two drafts sort in drafting order. */
const nextNow = cliClock()

/** What the next migration changes besides the decoder login's name: nothing, or the workload, by one program. */
type Beside = "alone" | "schemaChange"

interface Earlier {
	/** The segments the earlier naming door spelled between `__live_` and the digest. */
	readonly segments: ReadonlyArray<string>
	/** Whether the earlier leader made its replication slot. */
	readonly slot: boolean
	readonly beside: Beside
}

export type EarlierFeature =
	| "a slot the earlier leader made"
	| "no slot"
	| "the rename alone"
	| "the rename beside a schema change"

/** A segment the earlier naming door spelled: lowercase letters and digits, a letter first. */
const segmentGen: Gen<string> = (source) =>
	`${source.draw(element(["a", "k", "q", "z"]))}${source.draw(string(element(["a", "b", "x", "z", "0", "1", "8", "9"]), { min: 0, max: 3 }))}`

export const earlierGen: Gen<Earlier> = (source) => ({
	segments: source.draw(array(segmentGen, { min: 1, max: 3 })),
	slot: source.draw(boolean),
	beside: source.draw(element<Beside>(["alone", "schemaChange"]))
})

const notesOf = (e: Earlier): ReadonlyArray<EarlierFeature> => [
	e.slot ? "a slot the earlier leader made" : "no slot",
	e.beside === "alone" ? "the rename alone" : "the rename beside a schema change"
]

/** The workload of the shop's login at each migration. */
const workloads: { readonly [B in Beside]: readonly [ShopWorkload, ShopWorkload] } = {
	alone: ["none", "none"],
	schemaChange: ["none", "full"]
}

/** The lines a command printed on stdout, sorted. */
const lines = (ran: CliRun): ReadonlyArray<string> =>
	Arr.sort(
		Arr.filter(Str.split("\n")(ran.stdout), (line) => line.length > 0),
		Order.String
	)

/** The digest characters that end a hashed name. */
const digestChars = 10

/** The live source's name `now` as the earlier naming door spelled it: `segments` between its lead and its digest. */
const spelledEarlier = (now: string, segments: ReadonlyArray<string>): string =>
	`${Str.slice(0, -digestChars)(now)}${Arr.join(segments, "_")}_${Str.slice(-digestChars)(now)}`

/**
 * The fingerprint of the snapshot whose two files' texts are `runtime` and `migration`, read as the command line reads
 * them (boundary/snapshot.ts readSnapshot): each decoded with its canonical tags, the two joined, the content digested.
 */
const fingerprintOf = (runtime: string, migration: string): string =>
	succeeded(
		snapshotFingerprint(
			succeeded(
				joinedSnapshot(
					succeeded(decode(runtime, noRevivers), "snapshot.json decodes"),
					succeeded(decode(migration, noRevivers), "manifest.json decodes")
				),
				"the snapshot's files join"
			).content
		),
		"the snapshot's fingerprint"
	)

/**
 * The committed output at `root`, the live source `now` spelled `earlier` in every file, as a grizzle that minted
 * `earlier` drafted it: the snapshot's fingerprint made again over the respelled content, written wherever the old one
 * was, and meta.json sealed again over its respelled meta.
 */
const respell = (root: string, now: string, earlier: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const runtime = yield* fs.readFileString(`${root}/${snapshotFileName}`)
		const migration = yield* fs.readFileString(`${root}/${manifestFileName}`)
		const before = fingerprintOf(runtime, migration)
		assert.ok(
			Str.includes(`"${before}"`)(runtime),
			"snapshot.json records the fingerprint its files' content digests to"
		)
		const after = fingerprintOf(
			Str.replaceAll(now, earlier)(runtime),
			Str.replaceAll(now, earlier)(migration)
		)
		const spelled = (text: string): string =>
			Str.replaceAll(before, after)(Str.replaceAll(now, earlier)(text))
		const files = yield* fs.readDirectory(root, { recursive: true })
		for (const file of files) {
			const path = `${root}/${file}`
			if ((yield* fs.stat(path)).type !== "File") {
				continue
			}
			const text = yield* fs.readFileString(path)
			if (Str.endsWith(`/${metaFileName}`)(path)) {
				succeeded(decodeMeta(text), `${file} is sealed as generate wrote it`)
				const meta = trusted<{ readonly meta: MigrationMeta }>(
					succeeded(decode(spelled(text), noRevivers), `${file} decodes respelled`)
				).meta
				yield* fs.writeFileString(path, succeeded(writeMeta(meta), "the respelled meta"))
			} else {
				yield* fs.writeFileString(path, spelled(text))
			}
		}
	})

/** The OID of the cluster role `role`, none where it stands no longer. */
const oidOf = (admin: PgConnection, role: string) =>
	Effect.map(
		admin.queryValues("SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname = $1::text", [role]),
		(rows) => Option.map(Arr.head(rows), ([oid]) => String(oid))
	)

/** The in-process events of a read up to and including their next `ready`, taken from `events`. */
const untilReady = (
	events: Queue.Queue<SetEvent<object>>
): Effect.Effect<ReadonlyArray<SetEvent<object>>> =>
	Effect.gen(function* () {
		const batch: Array<SetEvent<object>> = []
		for (;;) {
			const event = yield* Queue.take(events)
			if (event.kind === "error" || event.kind === "end") {
				return yield* Effect.die(
					`a live read's events end before their next ready: ${Formatter.format(event)}`
				)
			}
			batch.push(event)
			if (event.kind === "ready") {
				return batch
			}
		}
	})

const idOf = (n: number): `${string}-${string}-${string}-${string}-${string}` =>
	`00000000-0000-4000-8000-00000000000${n}`

export const earlierCase = (e: Earlier, c: Case<EarlierFeature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			c.noteAll(notesOf(e))
			const substrate = yield* Substrate
			const schema = yield* substrate.schema({ create: false, label: "dd" })
			const rolePrefix = uniqueSchemaName("rd", 0)
			const database = yield* freshDatabase(substrate.cluster)
			const installation = { database, rolePrefix }
			const dir = yield* workspace("derivation")
			const configOf = (programs: ShopWorkload) => {
				const shop = shopV1(schema, programs)
				return {
					shop,
					config: defineConfig({
						schemas: [shop.schema],
						logins: [shop.server],
						migrations: "migrations",
						connection: () => ({
							...connectionOf(substrate.cluster, ownerOn(substrate.cluster, database)),
							rolePrefix
						})
					})
				}
			}
			const [before, after] = workloads[e.beside]
			const first = configOf(before)
			const next = configOf(after)
			const run = (config: unknown, command: string) =>
				cliOver(dir, config, [command, configName], nextNow())
			const root = `${dir}/migrations/${schema}`
			const generated = yield* run(first.config, "generate")
			assert.equal(generated.code, 0, `grizzle generate: ${generated.stderr}`)
			const servedNow = yield* servedAt(root, first.shop.server)
			const now = servedNow.decoder.stem
			const earlier = spelledEarlier(now, e.segments)
			const earlierDecoder = `${rolePrefix}__${earlier}`
			assert.ok(
				utf8Length(earlierDecoder) <= maxIdentifierBytes,
				`${earlierDecoder} fits PostgreSQL's identifier: the drawn segments are short enough`
			)
			yield* respell(root, now, earlier)
			const servedEarlier = yield* servedAt(root, first.shop.server)
			assert.equal(
				roleNameOf(servedEarlier.decoder, installation),
				earlierDecoder,
				"the respelled served file names the decoder login as the earlier naming door did"
			)
			const installed = yield* run(first.config, "migrate")
			assert.equal(installed.code, 0, `grizzle migrate of the earlier output: ${installed.stderr}`)
			const decoder = yield* substrate.login(earlierDecoder)
			const oidBefore = yield* oidOf(substrate.admin, earlierDecoder)
			assert.ok(Option.isSome(oidBefore), `the earlier output created ${earlierDecoder}`)
			const owner = yield* connect(substrate.cluster, {
				database,
				credentials: ownerCredentials(substrate.cluster),
				label: "earlier leader"
			})
			if (e.slot) {
				yield* owner.query(
					"SELECT pg_catalog.pg_create_logical_replication_slot($1::name, 'pgoutput')",
					[earlierDecoder]
				)
			}
			const server = yield* substrate.login(roleNameOf(servedEarlier, installation))
			const layerOf = (served: typeof servedNow, decoderPassword: DecoderCredential) =>
				servedSourcedLayer(decoderPassword, {
					...clusterConnection(substrate.cluster, database, server.password),
					rolePrefix,
					pool: clusterPool,
					login: served,
					verify: testVerify
				})
			const refusedDecoder: DecoderCredential = (role) =>
				Effect.fail(
					new CredentialError({ cause: `no live source is read here, not even ${role}'s` })
				)
			const write = (served: typeof servedNow, n: number) =>
				Effect.scoped(
					Effect.flatMap(Db.open(served.roles.writer, {}), (db) =>
						answered(
							db.workload.addCustomer.once({
								params: {},
								facts: { insert: { Customer: [{ id: idOf(n), name: "ada" }] } }
							})
						)
					)
				).pipe(withLayer(layerOf(served, refusedDecoder)))
			const wroteBefore = yield* write(servedEarlier, 1)
			assert.equal(wroteBefore.kind, "accepted", "the earlier installation's writer writes")
			const drafted = yield* run(next.config, "generate")
			assert.equal(drafted.code, 0, `grizzle generate across the derivation: ${drafted.stderr}`)
			const served = yield* servedAt(root, next.shop.server)
			const decoderNow = roleNameOf(served.decoder, installation)
			const migrated = yield* run(next.config, "migrate")
			assert.equal(migrated.code, 0, `grizzle migrate across the derivation: ${migrated.stderr}`)
			const listed = yield* run(next.config, "roles")
			assert.deepEqual(
				lines(listed),
				Arr.sort(
					[
						roleNameOf(served, installation),
						...Arr.map(Rec.values(next.shop.server.roles), (r) => roleNameOf(r.role, installation)),
						decoderNow
					],
					Order.String
				),
				"the installed roles are exactly the roles the naming door derives now"
			)
			const oidAfter = yield* oidOf(substrate.admin, decoderNow)
			assert.deepEqual(
				oidAfter,
				oidBefore,
				`${decoderNow} is the decoder login the earlier output created, renamed in place`
			)
			const slots = yield* owner.queryValues(
				"SELECT slot_name::text FROM pg_catalog.pg_replication_slots WHERE database = current_database()",
				[]
			)
			const publications = yield* owner.queryValues(
				"SELECT pubname::text FROM pg_catalog.pg_publication",
				[]
			)
			assert.deepEqual(
				{
					slots: Arr.map(slots, ([s]) => String(s)),
					publications: Arr.map(publications, ([p]) => String(p))
				},
				{ slots: [], publications: [served.decoder.stem] },
				"no slot of the earlier name is left, and the one publication is the one today's served file names"
			)
			const drift = yield* run(next.config, "drift")
			assert.equal(
				drift.code,
				0,
				`the migrated installation stands as its snapshot says: ${drift.stderr}`
			)
			const keptPassword: DecoderCredential = (role) =>
				role === decoderNow
					? Effect.succeed(decoder.password)
					: Effect.fail(
							new CredentialError({ cause: `${role} is no decoder login of the installation` })
						)
			yield* Effect.scoped(
				Effect.gen(function* () {
					const reader = yield* Db.open(served.roles.reader, {})
					const read = reader.workload.customer
					const old = yield* oneOf(read.once({ params: { id: idOf(1) }, facts: {} }))
					assert.ok(Option.isSome(old), "the customer written before the migration is read")
					const input = { params: { id: idOf(2) }, facts: {} }
					yield* standing(() => read.watch(input))
					const events = yield* Queue.unbounded<SetEvent<object>>()
					yield* Effect.forkScoped(
						Stream.runForEach(read.watch(input), (ev) => Queue.offer(events, ev))
					)
					const firstBatch = yield* untilReady(events)
					const first = fold(opening<"set", object>("set"), firstBatch)
					assert.ok(
						first.kind === "ready" && [...first.value].length === 0,
						"the live read of a customer not yet written holds none"
					)
					const wrote = yield* write(served, 2)
					assert.equal(wrote.kind, "accepted", "the writer writes after the migration")
					const nextBatch = yield* untilReady(events)
					const streamed = fold(first, nextBatch)
					assert.ok(
						streamed.kind === "ready" && [...streamed.value].length === 1,
						"the live source streams the customer written after the migration"
					)
				})
			).pipe(withLayer(layerOf(served, keptPassword)))
			yield* awaitFact(
				Effect.map(
					owner.queryValues(
						"SELECT slot_name::text FROM pg_catalog.pg_replication_slots WHERE database = current_database() AND active_pid IS NOT NULL",
						[]
					),
					(active) => (active.length === 0 ? Option.some(undefined) : Option.none())
				)
			)
			const uninstalled = yield* run(next.config, "uninstall")
			assert.equal(uninstalled.code, 0, `grizzle uninstall: ${uninstalled.stderr}`)
			const leftUnder = yield* substrate.admin.queryValues(
				"SELECT rolname::text FROM pg_catalog.pg_roles WHERE starts_with(rolname::text, $1::text)",
				[`${rolePrefix}__`]
			)
			const slotsLeft = yield* owner.queryValues(
				"SELECT slot_name::text FROM pg_catalog.pg_replication_slots WHERE database = current_database()",
				[]
			)
			const publicationsLeft = yield* owner.queryValues(
				"SELECT pubname::text FROM pg_catalog.pg_publication",
				[]
			)
			assert.deepEqual(
				{
					roles: Arr.map(leftUnder, ([r]) => String(r)),
					slots: Arr.map(slotsLeft, ([s]) => String(s)),
					publications: Arr.map(publicationsLeft, ([p]) => String(p))
				},
				{ roles: [], slots: [], publications: [] },
				"uninstall leaves no role of the installation, no slot and no publication"
			)
		})
	)
