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
 * or held, and the session's flight bound in force or planted below any flight. The planted bound is the longest Parse
 * message of the write's statements (test/support/staged.ts textBound), so every statement's text fits it and only the
 * entries' bytes pass it. An entry's length is boxed apart from the bound: within it by more than the rest of its row's
 * arrays, a drawn share of the most such an entry holds, or past it; its size is its share, which the CHECK bounds.
 *
 * Each write is a member of the full role's served workload, applied with its call's facts on the opened Db's context, or
 * on that context with its pool's sessions planted.
 *
 * Oracle: PostgreSQL, the same write sent with the bounds in force, where every statement goes in one Bind message,
 * from the same stored shelves:
 *
 * - **A flight past one write** is InputTooLarge (flight), or (familyRow) where a row is past one fill too: nothing sent
 *   and nothing stored.
 * - **A row no fill carries even alone** is InputTooLarge (familyRow) of Entry, its fill's Bind message past the planted
 *   bound, before any SQL: nothing sent and nothing stored.
 * - **A write that creates a temporary table on a role without TEMPORARY**, a staged carrier or a carrier of the
 *   program's own, which a put of a Tag read back by its delta joined with Tag's state needs, is TemporaryRefused,
 *   naming the privilege, with the server's 42501, and stores nothing. The read-back reads Tag's state, which the put
 *   writes, so it cannot ride the put's statement (write/schedule/plan.ts placeReadBacks), and its delta is carried
 *   to it.
 * - **Any other write is the inline write**: it leaves the same rows of every table, every column of each row read as
 *   its row's text, each entry's indexes and its copies of its owners' counts and each owner's count and end among them,
 *   and answers the same outcome, its kind, its counts, and a refusal's laws and witness.
 *
 * The staged statement keeps no value beside its rows, so its rows pass the bound exactly when one fill of them would:
 * a staged write here fills its carrier more than once, and the unit search of the cut reaches a carrier of one fill
 * (test/unit/write/staged.test.ts).
 *
 * Kept: pantry's import, a fresh immutable Package whose Entry bytes pass the bound in several fills.
 *
 * Features: inline under the planted bound, staged in several fills, a stored mutable shelf recounted, a refusal the
 * staged statement judges, an owner of no member, a row past one fill alone, a flight past one write, a staged write
 * and a carrier of the program's own without TEMPORARY, and a carrier of the program's own.
 *
 * Plant: ~/.cache/grizzle-release/BR08/plants/staged-no-staged-form.patch, a served program whose statements carry no
 * staged form, sends its rows inline past the planted bound, which the flight's builder refuses as InputTooLarge
 * (message) where the inline write commits, so the search fails on pantry's kept case.
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Result, String as Str } from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { memberOps } from "#adapter/db/handles.ts"
import type { LoadedChange, LoadedMember } from "#adapter/served/load.ts"
import type { Session, SessionPool, WireQuery } from "#adapter/wire/session.ts"
import { sqlstates } from "#compiler/plan/common.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import {
	accumulated,
	bytes,
	drawn as drawnField,
	natural,
	pg,
	uuid
} from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
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
import { keyTextBytes, str } from "#compiler/public/text.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert } from "#test/support/assert.ts"
import { sentSql } from "#test/support/flight/scripted.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { textBound } from "#test/support/staged.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/** An entry's path: any text its key beside the package's uuid holds, as pantry's EntryPath is bounded. */
const EntryPath = str.bytes(keyTextBytes([uuid]), str.regex("^.*$", "su"))

/** An entry's share of the most bytes an entry within the bound holds, in thousandths, of `whole` at most. */
const whole = 1_000

/** The largest size the CHECK Small admits: four fifths of a whole share. */
const small = 800n
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
const Tag = relation("Tag", { id: pg.int4, v: pg.int4 }, ["id"])
const Staged = schema("StagedRows", { Package, Bin, Shelf, Entry, Tag }, [
	mutable(Tag),
	entries,
	key(on(Entry, "package", "path")),
	binned,
	fold(binned, Monoid.sum, on(Entry, "bin", "size"), on(Bin, "id", "total")),
	mutable(Shelf),
	shelved,
	fold(shelved, Monoid.sum, on(Entry, "shelf", "size"), on(Shelf, "id", "total")),
	check("Small", Entry, (e) => e.le(e.size, small))
])

/**
 * What one entry's row adds to a fill's Bind message beside its bytes, at most: its other columns' arrays (its
 * package's, bin's and shelf's uuids, its drawn index, its path and its size, with their arrays' headers) and their
 * placeholders' fields.
 */
const rowOverhead = 400

/**
 * An entry's bytes: within the bound by more than its row's other arrays, `share` thousandths of the most such an entry
 * holds, or past it alone.
 */
type Member =
	| { readonly kind: "within"; readonly share: number; readonly bin: 0 | 1; readonly shelf: 0 | 1 }
	| { readonly kind: "past"; readonly bin: 0 | 1; readonly shelf: 0 | 1 }

const placeGen: Gen<0 | 1> = (source) => (source.draw(int(0, 1)) === 0 ? 0 : 1)

const memberGen: Gen<Member> = (source) => {
	const bin = source.draw(placeGen)
	const shelf = source.draw(placeGen)
	return source.draw(int(0, 15)) === 0
		? { kind: "past", bin, shelf }
		: { kind: "within", share: source.draw(int(0, whole)), bin, shelf }
}

/**
 * The length of an entry's bytes under the message bound `limit`: its share of half of what the bound holds beside the
 * rest of its row, or, past the bound, as many as the bound.
 */
const lengthOf = (member: Member, limit: number): number =>
	member.kind === "past" ? limit : Math.floor((member.share * (limit - rowOverhead)) / 2 / whole)

/** An entry's size, which Small bounds: its share, and a whole share past the bound. */
const sizeOf = (member: Member): bigint => BigInt(member.kind === "past" ? whole : member.share)

/** A case: each package's entries, whether the database holds TEMPORARY for PUBLIC, and the flight bound. */
interface Sketch {
	readonly packages: ReadonlyArray<ReadonlyArray<Member>>
	readonly temporary: boolean
	/** A put of a Tag read back by its delta joined with Tag's state beside the packages, which the program carries to
	 * the read-back through carriers of its own. */
	readonly tag: "none" | number
	readonly flight: "in force" | "past any flight"
}

const sketchGen: Gen<Sketch> = (source) => ({
	packages: source.draw(array(array(memberGen, { min: 0, max: 8 }), { min: 0, max: 3 })),
	temporary: source.draw(int(0, 3)) > 0,
	tag: source.draw(int(0, 3)) === 0 ? source.draw(int(0, 9)) : "none",
	flight: source.draw(int(0, 15)) === 0 ? "past any flight" : "in force"
})

/** Pantry's import: a fresh immutable Package whose Entry bytes pass the bound, in several fills. */
const pantry: Sketch = {
	packages: [
		Arr.makeBy(6, (i): Member => ({
			kind: "within",
			share: 750,
			bin: 0,
			shelf: i % 2 === 0 ? 0 : 1
		}))
	],
	temporary: true,
	tag: "none",
	flight: "in force"
}

type Feature =
	| "inline under the planted bound"
	| "staged in several fills"
	| "a stored mutable shelf recounted"
	| "a refusal the staged statement judges"
	| "an owner of no member"
	| "a row past one fill alone"
	| "a flight past one write"
	| "a staged write without TEMPORARY"
	| "a carrier of the program's own without TEMPORARY"
	| "a carrier of the program's own"

const binId = (bin: 0 | 1) => uuidOf(2_000 + bin)
const shelfId = (shelf: 0 | 1) => uuidOf(3_000 + shelf)

/** An entry's bytes of `length`, from `seed`, so no two entries' bytes repeat by accident. */
const bytesOf = (length: number, seed: number): Uint8Array<ArrayBuffer> =>
	Uint8Array.from({ length }, (_, i) => (seed * 31 + i) % 251)

/** The case's write's facts under the message bound `limit`: both bins, and every package with its entries nested. */
const nestedFacts = (sketch: Sketch, limit: number) => ({
	insert: {
		Bin: [{ id: binId(0) }, { id: binId(1) }],
		Package: Arr.map(sketch.packages, (members, p) => ({
			id: uuidOf(1_000 + p),
			name: p,
			entries: Arr.map(members, (member, e) => ({
				path: `p${e}`,
				bin: binId(member.bin),
				shelf: shelfId(member.shelf),
				size: sizeOf(member),
				content: bytesOf(lengthOf(member, limit), 100 * p + e)
			}))
		}))
	}
})

/** The shelves every case's write meets stored, each of no entry. */
const shelfFacts = { insert: { Shelf: [{ id: shelfId(0) }, { id: shelfId(1) }] } }

/**
 * The role's workload: the stored shelves' insert; and the case's write, both bins and its packages with their entries
 * nested, alone or with a put of a Tag beside it, read back by its delta. Each takes its call's facts.
 */
const programs = {
	shelves: ChangeSet.empty(Staged).insert(Shelf, []),
	nested: ChangeSet.empty(Staged).insert(Bin, []).insert(Package, []),
	tagged: ChangeSet.empty(Staged)
		.insert(Bin, [])
		.insert(Package, [])
		.put(Tag, [])
		.read("tags", (d) =>
			query(Staged).rule((r) => {
				const { id, v: value } = v(Tag, "added")
				return r
					.match(d.added(Tag), { id, v: value })
					.match(Tag, { id, v: value })
					.find({ id, v: value })
			})
		)
}

/** A change member's one variant: a member of another kind, or of variants by its fill contexts, is a defect of the test. */
const changeOf = (loaded: LoadedMember): LoadedChange => {
	if (loaded.kind !== "change" || loaded.variants.kind !== "change") {
		throw new Error(`${loaded.name} is a change member of one variant`)
	}
	return loaded.variants.change
}

/** A change member applied on `ctx` with its call's facts. */
const appliedOn = (ctx: ServedDbContext, loaded: LoadedMember, facts: unknown) => {
	const ops = memberOps(ctx, loaded)
	return ops.kind === "facts"
		? ops.ops.apply(facts, {})
		: Effect.die(new Error(`${loaded.name} applies with each call's facts`))
}

/**
 * A pool whose sessions hold the planted message bound `limit`, and a flight bound below any flight where the case plants
 * one, each recording every query it sends.
 */
const plantedPool = (
	pool: SessionPool,
	sketch: Sketch,
	sent: Array<WireQuery>,
	limit: number
): SessionPool => ({
	...pool,
	lease: Effect.map(pool.lease, (session): Session => ({
		...session,
		messageMaxBytes: limit,
		flightMaxBytes: sketch.flight === "past any flight" ? 1 : session.flightMaxBytes,
		send: (pipeline, onAnswer, onEnd, onCut) => {
			for (const one of pipeline) {
				sent.push(one)
			}
			session.send(pipeline, onAnswer, onEnd, onCut)
		}
	}))
})

/**
 * An outcome or a failure as the comparison reads it: an outcome whole, its kind, counts, refused laws and witness; a
 * failure by its tag, the class of failure the contract names, never its message's wording.
 */
const printed = <E extends { readonly _tag: string }>(result: Result.Result<unknown, E>): unknown =>
	Result.isSuccess(result) ? result.success : { failed: result.failure._tag }

/** An outcome or a failure as a report shows it: the outcome, or the failure's message. */
const shown = (result: Result.Result<unknown, { readonly message: string }>): string =>
	Result.isSuccess(result) ? Formatter.format(result.success) : result.failure.message

/** The header's property over an installation of the schema: each case's write inline and on the planted session. */
const searchOn = <A, E, R>(
	body: (
		property: (sketch: Sketch, c: Case<Feature>) => Effect.Effect<void, unknown, Substrate>
	) => Effect.Effect<A, E, R>
) =>
	Effect.gen(function* () {
		const o = yield* installed(Staged, {}, { label: "stagedrows", extensions: [], programs: {} })
		const s = yield* Substrate
		const names = namesOf(o.installed)
		return yield* withServedDb(o.installed, o.server.roles.app, {}, ({ ctx, load }) =>
			Effect.gen(function* () {
				const loaded = yield* load(programs)
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
				const nested = member(loaded, "nested")
				const tagged = member(loaded, "tagged")
				/**
				 * The planted message bound: the longest Parse message of any statement a case's write sends, with or without
				 * its Tag, whose texts its rows' values do not change.
				 */
				const limit = Math.max(
					textBound(changeOf(nested).entry.program.flight),
					textBound(changeOf(tagged).entry.program.flight)
				)
				const fresh = Effect.gen(function* () {
					yield* Effect.orDie(replaceRows(s.admin, installationGroup(names), []))
					const stored = yield* appliedOn(ctx, member(loaded, "shelves"), shelfFacts)
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
				/** One write sent inline and on the planted session. */
				const arms = (written: LoadedMember, facts: unknown, sketch: Sketch) =>
					Effect.gen(function* () {
						yield* fresh
						const inlineResult = yield* Effect.result(appliedOn(ctx, written, facts))
						const inline = printed(inlineResult)
						const inlineRows = yield* state
						yield* fresh
						const sent: Array<WireQuery> = []
						if (!sketch.temporary) {
							yield* database(false)
						}
						const staged = yield* Effect.result(
							appliedOn(
								{ ...ctx, pool: plantedPool(ctx.pool, sketch, sent, limit) },
								written,
								facts
							)
						).pipe(Effect.ensuring(sketch.temporary ? Effect.void : database(true)))
						const stagedRows = yield* state
						return {
							statements: changeOf(written).entry.program.flight.statements,
							inline,
							inlineRows,
							staged,
							stagedRows,
							sent
						}
					})
				const property = (sketch: Sketch, c: Case<Feature>) =>
					Effect.gen(function* () {
						const label = Formatter.format(sketch)
						const facts = nestedFacts(sketch, limit)
						const { statements, inline, inlineRows, staged, stagedRows, sent } =
							sketch.tag === "none"
								? yield* arms(nested, facts, sketch)
								: yield* arms(
										tagged,
										{ ...facts, put: { Tag: [{ id: 1, v: sketch.tag }] } },
										sketch
									)
						const texts = Arr.flatMap(sent, (q) => (q._tag === "control" ? [] : [sentSql(q)]))
						const carriers = Arr.flatMap(statements, (st) =>
							st.staged.kind === "carriers" ? st.staged.carriers : []
						)
						const created = Arr.filter(carriers, (k) => Arr.contains(texts, k.create.sql))
						const temporary = Arr.some(texts, (t) => Str.startsWith("CREATE TEMPORARY TABLE")(t))
						const own = Arr.some(
							statements,
							(st) => st.step.kind === "carrier" && st.step.step === "create"
						)
						const past = Arr.some(Arr.flatten(sketch.packages), (m) => m.kind === "past")
						if (sketch.flight === "past any flight") {
							c.note("a flight past one write")
							assert.ok(
								Result.isFailure(staged) &&
									staged.failure._tag === "ExecutionFailure" &&
									staged.failure.reason._tag === "InputTooLarge" &&
									(staged.failure.reason.bound.kind === "flight" ||
										(past && staged.failure.reason.bound.kind === "familyRow")),
								`${label}: a flight past one write is InputTooLarge, not ${shown(staged)}`
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
								`${label}: a row no fill carries is InputTooLarge (familyRow), not ${shown(staged)}`
							)
							assert.equal(texts.length, 0, `${label}: nothing is sent`)
							assert.deepEqual(stagedRows, shelved, `${label}: nothing is stored`)
							return
						}
						if (!sketch.temporary && temporary) {
							c.note(
								Arr.isReadonlyArrayNonEmpty(created)
									? "a staged write without TEMPORARY"
									: "a carrier of the program's own without TEMPORARY"
							)
							assert.ok(
								Result.isFailure(staged) &&
									staged.failure._tag === "ExecutionFailure" &&
									staged.failure.reason._tag === "TemporaryRefused" &&
									staged.failure.reason.error.sqlstate === sqlstates.insufficientPrivilege,
								`${label}: a temporary table the role may not create is TemporaryRefused, not ${shown(staged)}`
							)
							assert.deepEqual(stagedRows, shelved, `${label}: nothing is stored`)
							return
						}
						assert.deepEqual(stagedRows, inlineRows, `${label}: the inline write's rows`)
						assert.deepEqual(printed(staged), inline, `${label}: the inline write's outcome`)
						if (own) {
							c.note("a carrier of the program's own")
						}
						if (!Arr.isReadonlyArrayNonEmpty(created)) {
							c.note("inline under the planted bound")
							return
						}
						if (Arr.some(created, (k) => Arr.filter(texts, (t) => t === k.fill.sql).length > 1)) {
							c.note("staged in several fills")
						}
						if (Result.isSuccess(staged) && staged.success.kind === "accepted") {
							c.note("a stored mutable shelf recounted")
						}
						if (Result.isSuccess(staged) && staged.success.kind === "invariant-rejected") {
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
			})
		)
	}).pipe(Effect.scoped)

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
								suite: "pg/write/staged",
								draw: drawn(sketchGen),
								literal: Formatter.format,
								oracle: {
									kind: "postgresql",
									name: "the same write sent inline: its rows, every column, and its outcome"
								},
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 8,
								caseHang,
								coverage: required<Feature>(
									[
										"inline under the planted bound",
										"staged in several fills",
										"a stored mutable shelf recounted",
										"a refusal the staged statement judges",
										"an owner of no member",
										"a row past one fill alone",
										"a flight past one write",
										"a staged write without TEMPORARY",
										"a carrier of the program's own without TEMPORARY",
										"a carrier of the program's own"
									],
									{ cases: 96, sense: notesOnly }
								),
								kept: [
									{
										note: "pantry's import: a fresh immutable Package whose Entry bytes pass one Bind message",
										sketch: pantry,
										draws: "",
										reaches: ["staged in several fills", "a stored mutable shelf recounted"]
									}
								],
								runs: 64
							},
							property
						)
					)
				)
		)
	}
)
