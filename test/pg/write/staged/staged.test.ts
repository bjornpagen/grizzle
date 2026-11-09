/**
 * A nested write whose rows are past one Bind message (write/program/staged.ts), on PostgreSQL 19rc1: its rows travel
 * through transaction carriers filled chunk by chunk in the call's one flight, and the statement that writes them runs
 * once over every row, so the write is the write its statement sends inline.
 *
 * The schema holds pantry's import shape, a fresh immutable Package whose ordered Entry family of bytes is nested in
 * its insert. Each entry is also a counted member twice over, as a sequence's member may be: of a Bin, an immutable owner
 * the write inserts beside it, and of a Shelf, a mutable owner stored before the write, each folding its entries' sizes
 * into its end, so the family statement draws their counts, indexes and ends in SQL and recounts the stored Shelf. A
 * CHECK on an entry's size is a law that statement judges. A case inserts packages with their entries nested, each
 * entry's bytes of a drawn length, and both bins, on a session whose message bound is planted (Session.messageMaxBytes,
 * the bound both the flight's builder and the cut read), with the database's TEMPORARY privilege revoked from PUBLIC
 * or held, and the session's flight bound in force or planted below any flight. An entry's length is boxed apart from
 * the bound: within it by more than the rest of its row's arrays, or past it.
 *
 * Oracle: PostgreSQL, the same write sent with the bounds in force, where every statement goes in one Bind message,
 * from the same stored shelves:
 *
 * - **A flight past one write** is InputTooLarge (flight), or (familyRow) where a row is past one fill too: nothing sent
 *   and nothing stored.
 * - **A row no fill carries even alone** is InputTooLarge (familyRow) of Entry, its fill's Bind message past the planted
 *   bound, before any SQL: nothing sent and nothing stored.
 * - **A write that stages its rows on a role without TEMPORARY** is InputTooLarge (carrier), naming Entry and the
 *   privilege, and stores nothing.
 * - **Any other write is the inline write**: it leaves the same rows of every table, every column of each row read as
 *   its row's text, each entry's indexes and its copies of its owners' counts and each owner's count and end among them,
 *   and answers the same outcome, its kind, its counts, and a refusal's laws and witness.
 *
 * Kept: pantry's import, a fresh immutable Package whose Entry bytes pass the bound in several fills.
 *
 * Planted: a program whose statements carry no staged form sends its rows inline past the planted bound, which the
 * flight's builder refuses as InputTooLarge (message) where the inline write commits, so the search fails on pantry's
 * kept case, which the second test requires.
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { array, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Result } from "effect"
import type { CompiledChange } from "#adapter/apply/compile.ts"
import { runApplication } from "#adapter/apply/index.ts"
import { openDbContext } from "#adapter/db/open.ts"
import { compiledWrite } from "#adapter/served/forms.ts"
import type { Session, SessionPool, WireQuery } from "#adapter/wire/session.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import {
	accumulated,
	bytes,
	drawn as drawnField,
	natural,
	pg,
	uuid
} from "#compiler/public/fields.ts"
import {
	check,
	counted,
	fin,
	fold,
	key,
	Monoid,
	mutable,
	on,
	ordered,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { uuidOf } from "#test/unit/write/changeset/fixtures.ts"

const EntryPath = str.regex("^.*$", "su")
const Package = relation("Package", { id: uuid, entries: drawnField(natural), name: pg.int4 }, [
	"id"
])
const Bin = relation(
	"Bin",
	{ id: uuid, n: drawnField(natural), total: accumulated(pg.bigint, 0n) },
	["id"]
)
const Shelf = relation(
	"Shelf",
	{ id: uuid, n: drawnField(natural), total: accumulated(pg.bigint, 0n) },
	["id"]
)
const Entry = relation(
	"Entry",
	{
		package: uuid,
		at: drawnField(natural),
		path: EntryPath,
		bin: uuid,
		shelf: uuid,
		size: pg.bigint,
		content: bytes
	},
	["package", "at"]
)
const entries = ordered(on(Entry, "package", "at"), fin(Package, "entries"))
const binned = counted(on(Entry, "bin"), fin(Bin, "n"))
const shelved = counted(on(Entry, "shelf"), fin(Shelf, "n"))
const Staged = schema("StagedRows", { Package, Bin, Shelf, Entry }, [
	entries,
	key(on(Entry, "package", "path")),
	binned,
	fold(binned, Monoid.sum, on(Entry, "bin", "size"), on(Bin, "id", "total")),
	mutable(Shelf),
	shelved,
	fold(shelved, Monoid.sum, on(Entry, "shelf", "size"), on(Shelf, "id", "total")),
	check("Small", Entry, (e) => e.le(e.size, 1_500n))
])

/** The message bound the staged arm's session holds. */
const limit = 4_000

/**
 * What one entry's row adds to a fill's Bind message beside its bytes, at most: its other columns' arrays (its
 * package's, bin's and shelf's uuids, its drawn index, its path and its size, with their arrays' headers) and their
 * placeholders' fields.
 */
const rowOverhead = 400

/** An entry's bytes: within the bound by more than its row's other arrays, or past it alone. */
type Member =
	| { readonly kind: "within"; readonly length: number; readonly bin: 0 | 1; readonly shelf: 0 | 1 }
	| { readonly kind: "past"; readonly bin: 0 | 1; readonly shelf: 0 | 1 }

const placeGen: Gen<0 | 1> = (source) => (source.draw(int(0, 1)) === 0 ? 0 : 1)

const memberGen: Gen<Member> = (source) => {
	const bin = source.draw(placeGen)
	const shelf = source.draw(placeGen)
	return source.draw(int(0, 15)) === 0
		? { kind: "past", bin, shelf }
		: { kind: "within", length: source.draw(int(0, (limit - rowOverhead) / 2)), bin, shelf }
}

/** The length of an entry's bytes, and its size: an entry past the bound holds as many as the bound. */
const lengthOf = (member: Member): number => (member.kind === "past" ? limit : member.length)

/** A case: each package's entries, whether the database holds TEMPORARY for PUBLIC, and the flight bound. */
interface Sketch {
	readonly packages: ReadonlyArray<ReadonlyArray<Member>>
	readonly temporary: boolean
	readonly flight: "in force" | "past any flight"
}

const sketchGen: Gen<Sketch> = (source) => ({
	packages: source.draw(array(array(memberGen, { min: 0, max: 8 }), { min: 0, max: 3 })),
	temporary: source.draw(int(0, 3)) > 0,
	flight: source.draw(int(0, 15)) === 0 ? "past any flight" : "in force"
})

/** Pantry's import: a fresh immutable Package whose Entry bytes pass the bound, in several fills. */
const pantry: Sketch = {
	packages: [
		Arr.makeBy(6, (i): Member => ({
			kind: "within",
			length: 1_800,
			bin: 0,
			shelf: i % 2 === 0 ? 0 : 1
		}))
	],
	temporary: true,
	flight: "in force"
}

type Feature =
	| "inline under the planted bound"
	| "staged in one fill"
	| "staged in several fills"
	| "a stored mutable shelf recounted"
	| "a refusal the staged statement judges"
	| "an owner of no member"
	| "a row past one fill alone"
	| "a flight past one write"
	| "a staged write without TEMPORARY"

const binId = (bin: 0 | 1) => uuidOf(2_000 + bin)
const shelfId = (shelf: 0 | 1) => uuidOf(3_000 + shelf)

/** An entry's bytes of `length`, from `seed`, so no two entries' bytes repeat by accident. */
const bytesOf = (length: number, seed: number): Uint8Array<ArrayBuffer> =>
	Uint8Array.from({ length }, (_, i) => (seed * 31 + i) % 251)

/** The case's ChangeSet: both bins, and every package with its entries nested. */
const changesOf = (sketch: Sketch) =>
	ChangeSet.empty(Staged)
		.insert(Bin, [{ id: binId(0) }, { id: binId(1) }])
		.insert(
			Package,
			Arr.map(sketch.packages, (members, p) => ({
				id: uuidOf(1_000 + p),
				name: p,
				entries: Arr.map(members, (member, e) => ({
					path: `p${e}`,
					bin: binId(member.bin),
					shelf: shelfId(member.shelf),
					size: BigInt(lengthOf(member)),
					content: bytesOf(lengthOf(member), 100 * p + e)
				}))
			}))
		)

/** The shelves every case's write meets stored, each of no entry. */
const shelves = ChangeSet.empty(Staged).insert(Shelf, [{ id: shelfId(0) }, { id: shelfId(1) }])

/**
 * A pool whose sessions hold the planted message bound, and a flight bound below any flight where the case plants one,
 * each recording every query it sends.
 */
const plantedPool = (pool: SessionPool, sketch: Sketch, sent: Array<WireQuery>): SessionPool => ({
	...pool,
	lease: Effect.map(pool.lease, (session): Session => ({
		...session,
		messageMaxBytes: limit,
		flightMaxBytes: sketch.flight === "past any flight" ? 1 : session.flightMaxBytes,
		send: (pipeline, onAnswer, onEnd, onCut) => {
			sent.push(...pipeline)
			session.send(pipeline, onAnswer, onEnd, onCut)
		}
	}))
})

/** An outcome or a failure as the comparison reads it: an outcome whole, a failure by its message. */
const printed = (result: Result.Result<unknown, { readonly message: string }>): unknown =>
	Result.isSuccess(result) ? result.success : `failed: ${result.failure.message}`

/** How the staged arm's program reaches the write: as it is compiled, or with its staged forms planted away. */
type Staging = (entry: CompiledChange) => CompiledChange

const asCompiled: Staging = (entry) => entry

/** The planted bug: a program whose statements carry no staged form, which sends its rows inline past any bound. */
const unstaged: Staging = (entry) => ({
	...entry,
	program: {
		...entry.program,
		artifact: {
			...entry.program.artifact,
			statements: Arr.map(entry.program.artifact.statements, (st) => ({
				...st,
				staged: { kind: "none" } as const
			}))
		}
	}
})

/** The search's options but its name, kept cases, coverage and budget. */
const search = {
	draw: drawn(sketchGen),
	literal: Formatter.format,
	oracle: {
		kind: "postgresql",
		name: "the same write sent inline: its rows, every column, and its outcome"
	},
	shrink: completeShrink,
	concurrency: 1,
	steerEvery: 8,
	caseHang
} as const

/**
 * The header's property over an installation of the schema: each case's write inline and, with its program as
 * `staging` hands it over, on the planted session.
 */
const searchOn = <A, E, R>(
	body: (
		property: (
			staging: Staging
		) => (sketch: Sketch, c: Case<Feature>) => Effect.Effect<void, unknown, Substrate>
	) => Effect.Effect<A, E, R>
) =>
	Effect.gen(function* () {
		const o = yield* installed(Staged, {}, { label: "stagedrows", extensions: [] })
		const s = yield* Substrate
		const names = namesOf(o.installed)
		return yield* Effect.gen(function* () {
			const { ctx: opened } = yield* openDbContext(o.server.roles.app, {})
			const tables = [Package, Bin, Shelf, Entry]
			const state = Effect.forEach(tables, (r) =>
				Effect.map(
					Effect.orDie(
						s.admin.queryValues(
							`SELECT t::pg_catalog.text FROM ${names.table(r)} AS t ORDER BY 1`,
							[]
						)
					),
					(rows) => Arr.map(rows, (row) => String(row[0]))
				)
			)
			const shelvesEntry = succeeded(
				compiledWrite(opened, shelves, opened.claims),
				"the shelves compile"
			)
			const fresh = Effect.gen(function* () {
				yield* Effect.orDie(replaceRows(s.admin, installationGroup(names), []))
				const stored = yield* runApplication(opened, shelvesEntry, {}, shelves.reads)
				assert.equal(stored.kind, "accepted", "the shelves are stored")
			})
			const shelved = yield* Effect.andThen(fresh, state)
			const database = (grant: boolean) =>
				Effect.orDie(
					s.admin.queryValues(
						grant
							? "DO $$BEGIN EXECUTE pg_catalog.format('GRANT TEMPORARY ON DATABASE %I TO PUBLIC', pg_catalog.current_database()); END$$"
							: "DO $$BEGIN EXECUTE pg_catalog.format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', pg_catalog.current_database()); END$$",
						[]
					)
				)
			const property = (staging: Staging) => (sketch: Sketch, c: Case<Feature>) =>
				Effect.gen(function* () {
					const label = Formatter.format(sketch)
					const changes = changesOf(sketch)
					const entry = succeeded(
						compiledWrite(opened, changes, opened.claims),
						"the ChangeSet compiles"
					)
					yield* fresh
					const inline = yield* Effect.result(runApplication(opened, entry, {}, changes.reads))
					const inlineRows = yield* state
					yield* fresh
					const sent: Array<WireQuery> = []
					if (!sketch.temporary) {
						yield* database(false)
					}
					const staged = yield* Effect.result(
						runApplication(
							{ ...opened, pool: plantedPool(opened.pool, sketch, sent) },
							staging(entry),
							{},
							changes.reads
						)
					).pipe(Effect.ensuring(sketch.temporary ? Effect.void : database(true)))
					const stagedRows = yield* state
					const texts = Arr.flatMap(sent, (q) => (q._tag === "statement" ? [q.sql] : []))
					const carriers = Arr.flatMap(entry.program.artifact.statements, (st) =>
						st.staged.kind === "carriers" ? st.staged.carriers : []
					)
					const created = Arr.filter(carriers, (k) => Arr.contains(texts, k.create))
					const past = Arr.some(Arr.flatten(sketch.packages), (m) => m.kind === "past")
					if (sketch.flight === "past any flight") {
						c.note("a flight past one write")
						assert.ok(
							Result.isFailure(staged) &&
								staged.failure._tag === "ExecutionFailure" &&
								staged.failure.reason._tag === "InputTooLarge" &&
								(staged.failure.reason.bound.kind === "flight" ||
									(past && staged.failure.reason.bound.kind === "familyRow")),
							`${label}: a flight past one write is InputTooLarge, not ${String(printed(staged))}`
						)
						assert.equal(texts.length, 0, `${label}: nothing is sent`)
						assert.deepEqual(stagedRows, shelved, `${label}: nothing is stored`)
						return
					}
					if (past) {
						c.note("a row past one fill alone")
						assert.ok(
							Result.isFailure(staged) &&
								staged.failure._tag === "ExecutionFailure" &&
								staged.failure.reason._tag === "InputTooLarge" &&
								staged.failure.reason.bound.kind === "familyRow" &&
								staged.failure.reason.bound.member === "Entry" &&
								staged.failure.reason.bound.row.kind === "message" &&
								staged.failure.reason.bound.row.limit === limit &&
								staged.failure.reason.bound.row.bytes > limit,
							`${label}: a row no fill carries is InputTooLarge (familyRow), not ${String(printed(staged))}`
						)
						assert.equal(texts.length, 0, `${label}: nothing is sent`)
						assert.deepEqual(stagedRows, shelved, `${label}: nothing is stored`)
						return
					}
					if (!sketch.temporary && Arr.isReadonlyArrayNonEmpty(created)) {
						c.note("a staged write without TEMPORARY")
						assert.ok(
							Result.isFailure(staged) &&
								staged.failure._tag === "ExecutionFailure" &&
								staged.failure.reason._tag === "InputTooLarge" &&
								staged.failure.reason.bound.kind === "carrier" &&
								staged.failure.reason.bound.input === "Entry" &&
								staged.failure.reason.bound.privilege === "TEMPORARY",
							`${label}: a carrier the role may not create is InputTooLarge (carrier), not ${String(printed(staged))}`
						)
						assert.deepEqual(stagedRows, shelved, `${label}: nothing is stored`)
						return
					}
					assert.deepEqual(stagedRows, inlineRows, `${label}: the inline write's rows`)
					assert.deepEqual(printed(staged), printed(inline), `${label}: the inline write's outcome`)
					if (!Arr.isReadonlyArrayNonEmpty(created)) {
						c.note("inline under the planted bound")
						return
					}
					for (const k of created) {
						const fills = Arr.filter(texts, (t) => t === k.fill).length
						c.note(fills <= 1 ? "staged in one fill" : "staged in several fills")
					}
					if (Result.isSuccess(inline) && inline.success.kind === "accepted") {
						c.note("a stored mutable shelf recounted")
					}
					if (Result.isSuccess(inline) && inline.success.kind === "invariant-rejected") {
						c.note("a refusal the staged statement judges")
					}
					if (
						Arr.some(sketch.packages, (members) => members.length === 0) ||
						Arr.some([0, 1] as const, (bin) =>
							Arr.every(Arr.flatten(sketch.packages), (m) => m.bin !== bin)
						)
					) {
						c.note("an owner of no member")
					}
				})
			return yield* body(property)
		}).pipe(
			(inner) =>
				Effect.flatMap(Layer.build(o.layer), (context) => Effect.provideContext(inner, context)),
			Effect.scoped
		)
	}).pipe(Effect.scoped)

const pantryKept = {
	note: "pantry's import: a fresh immutable Package whose Entry bytes pass one Bind message",
	sketch: pantry,
	draws: ""
} as const

layer(Substrate.layer, { excludeTestServices: true })(
	"a nested write whose rows are past one Bind message",
	(it) => {
		it.effect(
			"leaves through its carriers what it leaves inline, and refuses a row, a flight or a carrier no transport carries",
			(ctx) =>
				searched(
					ctx,
					searchOn((property) =>
						explore(
							{
								...search,
								suite: "pg/write/staged",
								coverage: required<Feature>(
									[
										"inline under the planted bound",
										"staged in one fill",
										"staged in several fills",
										"a stored mutable shelf recounted",
										"a refusal the staged statement judges",
										"an owner of no member",
										"a row past one fill alone",
										"a flight past one write",
										"a staged write without TEMPORARY"
									],
									{ cases: 96, sense: notesOnly }
								),
								kept: [
									{
										...pantryKept,
										reaches: ["staged in several fills", "a stored mutable shelf recounted"]
									}
								],
								runs: 64
							},
							property(asCompiled)
						)
					)
				)
		)

		it.effect("fails, planted with no staged form, on pantry's import past the bound", (ctx) =>
			Effect.gen(function* () {
				const failure = yield* Effect.flip(
					searched(
						ctx,
						searchOn((property) =>
							explore(
								{
									...search,
									suite: "pg/write/staged, planted",
									coverage: noCoverage,
									kept: [{ ...pantryKept, reaches: ["staged in several fills"] }],
									runs: 4
								},
								property(unstaged)
							)
						)
					)
				)
				assert.equal(failure._tag, "PropertyFalsified", "the search catches the planted bug")
			})
		)
	}
)
