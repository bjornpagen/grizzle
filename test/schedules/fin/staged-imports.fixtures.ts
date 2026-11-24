/** What the property of staged-imports.test.ts reads: the imports' schema, its rig and the exploration of their race. */
import { assert, defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Formatter, Record as Rec, Result, String as Str } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import { openServed } from "#adapter/db/served.ts"
import { type LoadedMember } from "#adapter/served/load.ts"
import { type Session, type SessionPool } from "#adapter/wire/session.ts"
import { type CallError } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { bytes, drawn, natural, pg } from "#compiler/public/fields.ts"
import { fin, key, login, on, ordered, relation, role, schema } from "#compiler/public/schema.ts"
import { keyTextBytes, str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"
import { writeAnswerOf, writeOnce } from "#test/support/calls.ts"
import { Id, type IdValue } from "#test/support/ids.ts"
import { type Generated } from "#test/support/install-migrate.ts"
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
	type Txn
} from "#test/support/schedules/interleave.ts"
import { rigIn, rigTemplate } from "#test/support/schedules/rig.ts"
import { beginSerializableAction } from "#test/support/schedules/types.ts"
import { textBound } from "#test/support/staged.ts"
import { Substrate, type SubstrateCase } from "#test/support/substrate/substrate.ts"
/** An entry's path: any text its key beside the package's uuid holds, as pantry's EntryPath is bounded. */
const EntryPath = str.bytes(keyTextBytes([Id]), str.regex("^.*$", "su"))
const Package = relation("Package", { id: Id, entries: drawn(natural), name: pg.integer }, ["id"])
const Entry = relation(
	"Entry",
	{ package: Id, at: drawn(natural), path: EntryPath, content: bytes },
	["package", "at"]
)

/**
 * Pantry's import shape under a schema name, with a role `app` the imports open, whose login's workload holds the empty
 * ChangeSet a writer's first call applies and the insert of the packages, their entries nested, each call gives; and a
 * role `direct` the gate's.
 */
const imports = (name: string) => {
	const relations = { Package, Entry }
	const base = schema(name, Rec.values(relations), [
		ordered(on(Entry, "package", "at"), fin(Package, "entries")),
		key(on(Entry, "package", "path"))
	])
	const app = role(base, "app", relations, { insert: ["Package", "Entry"] })
	const direct = role(base, "direct", relations, { insert: ["Package", "Entry"] })
	return {
		schema: base,
		app,
		direct,
		server: login(base, "server", [app], {
			workload: [
				workload(app, {
					noop: ChangeSet.empty(base),
					importPackage: ChangeSet.empty(base).insert(Package, [])
				})
			]
		}),
		psql: login(base, "psql", [direct])
	}
}

/** The stored packages beside the imports, each with one entry, keyed across the uuid range. */
const stored = 3_000

/** The uuid of the `n`-th of `of` keys spread evenly across the uuid range. */
const uuidAt = (n: number, of: number): IdValue => {
	const hex = Str.padStart(8, "0")(Math.floor((n / of) * 0xffff_ffff).toString(16))
	return Id(`${hex}-0000-4000-8000-${Str.padStart(12, "0")(n.toString(16))}`)
}

/** The two imports' packages, keyed at either end of the uuid range, past every stored one. */
const first: IdValue = Id("00000000-0000-4000-8000-ffffffffffff")
const second: IdValue = Id("ffffffff-ffff-4fff-bfff-ffffffffffff")

/**
 * One import's facts under the message bound `limit`: its package with three entries of three fifths of the bound each,
 * which a fill carries alone and which pass the bound together, so every import stages.
 */
const importOf = (id: IdValue, name: number, limit: number) => ({
	insert: {
		Package: [
			{
				id,
				name,
				entries: Arr.makeBy(3, (e) => ({
					path: `entry-${e}`,
					content: Uint8Array.from(
						{ length: Math.floor((limit * 3) / 5) },
						(_, i) => (name * 7 + e * 31 + i) % 251
					)
				}))
			}
		]
	}
})

/**
 * The planted message bound of a change member of one variant: the longest Parse message of any statement it sends
 * (test/support/staged.ts textBound), so only its rows' arrays meet the bound; none for another member.
 */
const textBoundOf = (member: LoadedMember): number | undefined =>
	member.kind === "change" && member.variants.kind === "change"
		? textBound(member.variants.change.entry.program)
		: undefined

/** A pool whose sessions hold the planted message bound `limit`. */
const plantedPool = (pool: SessionPool, limit: number): SessionPool => ({
	...pool,
	lease: Effect.map(pool.lease, (session): Session => ({ ...session, messageMaxBytes: limit }))
})

/** The schedule's installation made once per member (support/schedules/rig.ts rigTemplate), which each case's seat holds. */
export const importsRig = rigTemplate(import.meta, "fin staged imports", imports)

/** The exploration of every interleaving of the gate and the two imports over the case's clone of the rig (`taken`). */
export const explored = (taken: SubstrateCase<Generated>) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const rig = yield* rigIn(taken, imports)
		const names = namesOf(rig.installed)
		/** The role's loaded `importPackage` member, as the first writer's layer loaded it from the served file. */
		const loaded: Array<LoadedMember> = []
		const open = (name: string) =>
			rig.servedWriter(
				name,
				(context) =>
					Effect.gen(function* () {
						const opened = yield* openServed(rig.served.roles.app, {})
						for (const member of opened.role.members) {
							if (member.name === "importPackage") {
								loaded.push(member)
							}
						}
						return opened
					}).pipe(Effect.provideContext(context)),
				(db) => writeAnswerOf(db.workload.noop.once({ params: {}, facts: {} }))
			)
		const a = yield* open("a")
		const b = yield* open("b")
		const loader = yield* open("loader")
		const member = defined(loaded[0], "the loaded importPackage member")
		const limit = defined(textBoundOf(member), "importPackage is a change member of one variant")
		/** An import on `writer`'s Db context, its pool's sessions holding the planted message bound. */
		const imported = (writer: typeof a, facts: ReturnType<typeof importOf>) =>
			writeAnswerOf(
				writeOnce(
					memberCalls({ ...writer.ctx, pool: plantedPool(writer.ctx.pool, limit) }, member)
				)({
					params: {},
					facts
				})
			)
		const direct = yield* openActors(s, { gate: { kind: "raw", as: rig.direct } })
		const preload = {
			insert: {
				Package: Arr.makeBy(stored, (n) => ({
					id: uuidAt(n + 1, stored + 2),
					name: n,
					entries: [{ path: "stored", content: Uint8Array.of(n % 251) }]
				}))
			}
		}
		/** Each import's answer in the current run, set by its move. */
		const ran = new Map<string, string>()
		const answer =
			(session: string) => (outcome: Result.Result<{ readonly kind: string }, CallError>) =>
				Effect.sync(() => {
					ran.set(
						session,
						Result.isSuccess(outcome)
							? outcome.success.kind
							: `${outcome.failure.kind}: ${outcome.failure.message}`
					)
				})
		const txns: ReadonlyArray<Txn> = [
			{
				kind: "direct",
				begin: beginSerializableAction,
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
						Effect.tap(Effect.result(imported(a, importOf(first, 1, limit))), answer("a")),
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
						Effect.tap(Effect.result(imported(b, importOf(second, 2, limit))), answer("b")),
						everyRelation
					)
				],
				after: undefined
			}
		]
		const reset = Effect.gen(function* () {
			ran.clear()
			yield* rig.replace([])
			const preloaded = yield* writeAnswerOf(
				loader.db.workload.importPackage.once({ params: {}, facts: preload })
			)
			assert.equal(preloaded.kind, "accepted", "the stored packages are stored")
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
				model: (run) => Effect.sync(() => judge(run))
			},
			every
		)
	})
