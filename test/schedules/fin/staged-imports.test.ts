/**
 * Two imports of unrelated packages whose Entry bytes pass one Bind message (write/program/staged.ts), in overlapping
 * SERIALIZABLE transactions, every interleaving: each is pantry's import shape, a fresh immutable Package with its
 * ordered Entry family of bytes nested in its insert, its rows staged through a carrier under a planted message bound
 * (Session.messageMaxBytes, which both the flight's builder and the cut read). A direct gate inserts the first import's
 * package key and rolls back, so in an interleaving where the gate's insert precedes the first import, that import waits
 * on the key inside its transaction while the second runs and commits, and both transactions overlap.
 *
 * Stored beside them are enough packages, each with one entry, keyed across the uuid range, that the two imports' keys
 * fall on index pages of their own at either end of it, so neither import's reads, made by key, meet the other's writes.
 *
 * - **The model:** both imports answer accepted in every interleaving, neither refused by a serialization failure:
 *   their rows hold no conflict, and the staged carriers' ANALYZE has the staged statements probe the stored packages
 *   and entries by key, locking only the index pages and rows they read. Some interleaving overlaps them (the first
 *   import waits on the gate's key while the second commits).
 *
 * Planted: the staged carriers' ANALYZE dropped (its text replaced by an empty SELECT), the planner reads a carrier of
 * one heap page as ten pages of rows, scans the stored relations whole, and the relation-level SIRead locks of those
 * scans make the overlapping imports a serialization conflict: one of them fails with 40001, so the exploration fails,
 * which the second test requires. If it does not, the ANALYZE is not what keeps the imports apart.
 */
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Result, String as Str } from "effect"
import type { CompiledChange } from "#adapter/apply/compile.ts"
import { runApplication } from "#adapter/apply/index.ts"
import { openDbContext } from "#adapter/db/open.ts"
import type { ApplyError } from "#adapter/errors/execution.ts"
import { compiledWrite } from "#adapter/served/forms.ts"
import type { Session, SessionPool } from "#adapter/wire/session.ts"
import type { TransientTag } from "#compiler/core/errors.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { bytes, drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
import { fin, key, login, on, ordered, relation, role, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { runnableWrite } from "#compiler/write/program/bind.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import {
	allowed,
	every,
	everyRelation,
	exploreInterleavings,
	type Interleaving,
	interleaveStep,
	type Judgment,
	opStep,
	refusedJudgment,
	runawayInterleavings,
	type Txn
} from "#test/support/schedules/interleave.ts"
import { openRig } from "#test/support/schedules/rig.ts"
import { testSql } from "#test/support/sql.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const EntryPath = str.regex("^.*$", "su")
const Package = relation("Package", { id: uuid, entries: drawn(natural), name: pg.int4 }, ["id"])
const Entry = relation(
	"Entry",
	{ package: uuid, at: drawn(natural), path: EntryPath, content: bytes },
	["package", "at"]
)

/** Pantry's import shape under a schema name, with a role `app` the imports open and a role `direct` the gate's. */
const imports = (name: string) => {
	const relations = { Package, Entry }
	const base = schema(name, relations, [
		ordered(on(Entry, "package", "at"), fin(Package, "entries")),
		key(on(Entry, "package", "path"))
	])
	const app = role(base, "app", relations, { write: ["Package", "Entry"] })
	const direct = role(base, "direct", relations, { write: ["Package", "Entry"] })
	return {
		schema: base,
		app,
		direct,
		server: login(base, "server", [app]),
		psql: login(base, "psql", [direct])
	}
}

/** The one refusal the planted bug may meet: a serialization failure of one import. */
const serializationFailure: TransientTag = "SerializationFailure"

/** The message bound both imports' sessions hold: three entries of 1,800 bytes pass it, so every import stages. */
const limit = 4_000

/** The stored packages beside the imports, each with one entry, keyed across the uuid range. */
const stored = 3_000

/** A package's key: a uuid's text. */
type Key = `${string}-${string}-${string}-${string}-${string}`

/** The uuid of the `n`-th of `of` keys spread evenly across the uuid range. */
const uuidAt = (n: number, of: number): Key => {
	const hex = Str.padStart(8, "0")(Math.floor((n / of) * 0xffff_ffff).toString(16))
	return `${hex}-0000-4000-8000-${Str.padStart(12, "0")(n.toString(16))}`
}

/** The two imports' packages, keyed at either end of the uuid range, past every stored one. */
const first: Key = "00000000-0000-4000-8000-ffffffffffff"
const second: Key = "ffffffff-ffff-4fff-bfff-ffffffffffff"

/** One import: its package with three entries of 1,800 bytes, which pass the bound together. */
const importOf = (rig: { readonly worlds: ReturnType<typeof imports> }, id: Key, name: number) =>
	ChangeSet.empty(rig.worlds.schema).insert(Package, [
		{
			id,
			name,
			entries: Arr.makeBy(3, (e) => ({
				path: `entry-${e}`,
				content: Uint8Array.from({ length: 1_800 }, (_, i) => (name * 7 + e * 31 + i) % 251)
			}))
		}
	])

/** How an import's program reaches its write: as it is compiled, or with its carriers' ANALYZE planted away. */
type Staging = (entry: CompiledChange) => CompiledChange

const asCompiled: Staging = (entry) => entry

/** The planted bug: every staged form's ANALYZE replaced by an empty SELECT, so the carriers are never counted. */
const unanalyzed: Staging = (entry) => {
	const compiled = {
		...entry.compiled,
		artifact: {
			...entry.compiled.artifact,
			statements: Arr.map(entry.compiled.artifact.statements, (st) => ({
				...st,
				staged:
					st.staged.kind === "carriers" ? { ...st.staged, analyze: testSql("SELECT") } : st.staged
			}))
		}
	}
	return { ...entry, compiled, program: runnableWrite(compiled, entry.program.flight.codes) }
}

/** A pool whose sessions hold the planted message bound. */
const plantedPool = (pool: SessionPool): SessionPool => ({
	...pool,
	lease: Effect.map(pool.lease, (session): Session => ({ ...session, messageMaxBytes: limit }))
})

/** The exploration of every interleaving of the gate and the two imports, their programs as `staging` hands them over. */
const explored = (staging: Staging) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const rig = yield* openRig("StagedImports", imports)
		const names = namesOf(rig.installed)
		const open = (name: string) =>
			rig.writer(name, (context) =>
				openDbContext(rig.worlds.server.roles.app, {}).pipe(Effect.provideContext(context))
			)
		const a = yield* open("a")
		const b = yield* open("b")
		const loader = yield* open("loader")
		const direct = yield* openActors(s, { gate: { kind: "raw", as: rig.direct } })
		const preload = ChangeSet.empty(rig.worlds.schema).insert(
			Package,
			Arr.makeBy(stored, (n) => ({
				id: uuidAt(n + 1, stored + 2),
				name: n,
				entries: [{ path: "stored", content: Uint8Array.of(n % 251) }]
			}))
		)
		const preloadEntry = succeeded(
			compiledWrite(loader.ctx, preload, loader.ctx.claims),
			"the stored packages compile"
		)
		const firstImport = importOf(rig, first, 1)
		const secondImport = importOf(rig, second, 2)
		const firstEntry = succeeded(
			compiledWrite(a.ctx, firstImport, a.ctx.claims),
			"an import compiles"
		)
		const secondEntry = succeeded(
			compiledWrite(b.ctx, secondImport, b.ctx.claims),
			"an import compiles"
		)
		/** Each import's answer in the current run, set by its move. */
		const ran = new Map<string, string>()
		const answer =
			(session: string) => (outcome: Result.Result<{ readonly kind: string }, ApplyError>) =>
				Effect.sync(() => {
					ran.set(
						session,
						Result.isSuccess(outcome)
							? outcome.success.kind
							: outcome.failure._tag === "TransientFailure"
								? `TransientFailure: ${outcome.failure.reason._tag}`
								: `${outcome.failure._tag}: ${outcome.failure.message}`
					)
				})
		const txns: ReadonlyArray<Txn> = [
			{
				kind: "direct",
				session: "gate",
				steps: [
					interleaveStep(
						`INSERT INTO ${names.table(Package)} (${names.column(Package, "id")}, ${names.column(Package, "entries")}, ${names.column(Package, "name")}) VALUES ('${first}', 0, 0)`,
						everyRelation
					)
				],
				end: "rollback",
				after: undefined
			},
			{
				kind: "grizzle",
				session: "a",
				steps: [
					opStep(
						"the first import",
						Effect.tap(
							Effect.result(
								runApplication(
									{ ...a.ctx, pool: plantedPool(a.ctx.pool) },
									staging(firstEntry),
									{},
									firstImport.reads
								)
							),
							answer("a")
						),
						everyRelation
					)
				],
				after: undefined
			},
			{
				kind: "grizzle",
				session: "b",
				steps: [
					opStep(
						"the second import",
						Effect.tap(
							Effect.result(
								runApplication(
									{ ...b.ctx, pool: plantedPool(b.ctx.pool) },
									staging(secondEntry),
									{},
									secondImport.reads
								)
							),
							answer("b")
						),
						everyRelation
					)
				],
				after: undefined
			}
		]
		const reset = Effect.gen(function* () {
			ran.clear()
			yield* rig.replace([])
			const loaded = yield* runApplication(loader.ctx, preloadEntry, {}, preload.reads)
			assert.equal(loaded.kind, "accepted", "the stored packages are stored")
		}).pipe(Effect.orDie)
		const judge = (run: Interleaving): Judgment => {
			for (const session of ["a", "b"]) {
				const answered = ran.get(session)
				if (answered !== "accepted") {
					return refusedJudgment(
						`the ${session === "a" ? "first" : "second"} import answered ${String(answered)} in ${Formatter.format(run.order)}, where the two imports' rows hold no conflict`
					)
				}
			}
			return allowed
		}
		return yield* exploreInterleavings(
			rig.env,
			{ direct, grizzle: { a: a.actor, b: b.actor } },
			{
				name: "two staged imports of unrelated packages",
				txns,
				reset,
				state: { _tag: "Unread" },
				model: (run) => Effect.sync(() => judge(run)),
				maxInterleavings: runawayInterleavings
			},
			every
		)
	})

layer(Substrate.layer, { excludeTestServices: true })(
	"two staged imports of unrelated packages in overlapping transactions",
	(it) => {
		it.effect("both commit in every interleaving, one waiting on the other's commit in some", () =>
			Effect.gen(function* () {
				const report = yield* explored(asCompiled)
				assert.ok(
					report.blocked > 0,
					`of ${report.interleavings} interleavings none had the first import wait on the gate while the second ran`
				)
			})
		)

		it.effect("fail, planted with no ANALYZE of their carriers, by a serialization failure", () =>
			Effect.gen(function* () {
				const failure = yield* Effect.flip(explored(unanalyzed))
				assert.ok(
					failure._tag === "InterleavingFailed" &&
						Str.includes(serializationFailure)(failure.message),
					`the planted bug is a serialization failure of one import, not ${failure.message}`
				)
			})
		)
	}
)
