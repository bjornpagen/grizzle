import { assert } from "@bjornpagen/testing/assert"
import { aimed, array, type Gen, int, recorded } from "@bjornpagen/testing/gen"
import { type Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result, String as Str } from "effect"
import { type ServedDbContext } from "#adapter/db/context.ts"
import { memberCalls } from "#adapter/db/handles.ts"
import { type LoadedChange, type LoadedMember } from "#adapter/served/load.ts"
import { type Session, type SessionPool, type WireQuery } from "#adapter/wire/session.ts"
import { type CallError } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, bytes, drawn as drawnField, natural, pg } from "#compiler/public/fields.ts"
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
	schema,
	unit
} from "#compiler/public/schema.ts"
import { keyTextBytes, str } from "#compiler/public/text.ts"
import { type ParamMap } from "#compiler/types/core/phantom.ts"
import { fixtureTemplate, openedIn } from "#test/pg/reads/support.ts"
import { writeAnswerOf, writeOnce } from "#test/support/calls.ts"
import { sentSql } from "#test/support/flight/scripted.ts"
import { Id } from "#test/support/ids.ts"
import { type Generated } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { textBound } from "#test/support/staged.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate, type SubstrateCase } from "#test/support/substrate/substrate.ts"
import { uuidOf } from "#test/unit/write/changeset/fixtures.ts"
/** An entry's path: any text its key beside the package's uuid holds, as pantry's EntryPath is bounded. */
const EntryPath = str.bytes(keyTextBytes([Id]), str.regex("^.*$", "su"))

/** An entry's share of the most bytes an entry within the bound holds, in thousandths, of `whole` at most. */
const whole = 1_000

/** The largest size the CHECK Small admits: four fifths of a whole share. */
const small = 800n
const Package = relation("Package", { id: Id, entries: drawnField(natural), name: pg.integer }, [
	"id"
])
const Bin = relation("Bin", { id: Id, n: drawnField(natural), total: accumulated(pg.bigint, 0n) }, [
	"id"
])
const Shelf = relation(
	"Shelf",
	{ id: Id, n: drawnField(natural), total: accumulated(pg.bigint, 0n) },
	["id"]
)
const Entry = relation(
	"Entry",
	{
		package: Id,
		at: drawnField(natural),
		path: EntryPath,
		bin: Id,
		shelf: Id,
		size: pg.bigint,
		content: bytes
	},
	["package", "at"]
)
const entries = ordered(on(Entry, "package", "at"), fin(Package, "entries"))
const binned = counted(on(Entry, "bin"), fin(Bin, "n"))
const shelved = counted(on(Entry, "shelf"), fin(Shelf, "n"))
const Tag = relation("Tag", { id: pg.integer, v: pg.integer }, ["id"])
const Staged = schema(
	"StagedRows",
	[Package, Bin, Shelf, Entry, Tag],
	[
		mutable(Tag),
		entries,
		key(on(Entry, "package", "path")),
		binned,
		fold(binned, Monoid.sum, on(Entry, "bin", "size"), on(Bin, "id", "total")),
		mutable(Shelf),
		shelved,
		fold(shelved, Monoid.sum, on(Entry, "shelf", "size"), on(Shelf, "id", "total")),
		check("Small", Entry, (e) => e.le(e.size, small)),
		unit("Tagged", { id: pg.integer }),
		unit("Stock", { id: Id })
	]
)

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
	/** A put of a Tag from a query over the call's relation parameter beside the packages, whose rows the program
	 * carries from the put's deletion to its insert in a carrier of its own. */
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

export type Feature =
	| "inline under the planted bound"
	| "staged in several fills"
	| "a stored mutable shelf recounted"
	| "a refusal the staged statement judges"
	| "an owner of no member"
	| "a row past one fill alone"
	| "a flight past one write"
	| "a write without TEMPORARY"
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
const shelfFacts = Object.freeze({ insert: { Shelf: [{ id: shelfId(0) }, { id: shelfId(1) }] } })

/**
 * The role's workload: the stored shelves' insert; and the case's write, both bins and its packages with their entries
 * nested, alone or with a put of Tags from a query over the relation parameter `tags` beside it. Each takes its call's
 * facts, and the put its parameter.
 */
const programs = Object.freeze({
	shelves: ChangeSet.empty(Staged).insert(Shelf, []),
	nested: ChangeSet.empty(Staged).insert(Bin, []).insert(Package, []),
	tagged: ChangeSet.empty(Staged)
		.insert(Bin, [])
		.insert(Package, [])
		.put(
			Tag,
			query(Staged).rule((r) => {
				const rows = r.relation("tags", { id: Tag.fields.id, v: Tag.fields.v })
				const { id, v: value } = v(Tag, "tag")
				return r.match(rows, { id, v: value }).find({ id, v: value })
			})
		)
})

/** A change member's one variant: a member of another kind, or of variants by its fill contexts, is a defect of the test. */
const changeOf = (loaded: LoadedMember): LoadedChange => {
	if (loaded.kind !== "change" || loaded.variants.kind !== "change") {
		throw new Error(`${loaded.name} is a change member of one variant`)
	}
	return loaded.variants.change
}

/** A change member's once on `ctx` with its call's facts and parameters. */
const appliedOn = (ctx: ServedDbContext, loaded: LoadedMember, facts: unknown, params: ParamMap) =>
	writeAnswerOf(writeOnce(memberCalls(ctx, loaded))({ params, facts }))

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
 * failure by its kind, the class of failure the contract names, never its message's wording.
 */
const printed = (result: Result.Result<unknown, CallError>): unknown =>
	Result.isSuccess(result) ? result.success : { failed: result.failure.kind }

/** An outcome or a failure as a report shows it: the outcome, or the failure's message. */
const shown = (result: Result.Result<unknown, { readonly message: string }>): string =>
	Result.isSuccess(result) ? Formatter.format(result.success) : result.failure.message

/** The installation of Staged, with no member of its own: each case loads the programs it writes through. */
const stagedInstall = { label: "stagedrows", programs: {} } as const

/**
 * Staged installed once per member (reads/support.ts fixtureTemplate), where its search installed it before its cases;
 * a case takes a clone of its own (Substrate.fresh), since a case may revoke TEMPORARY on the database and grant it
 * back, which leaves its ACL unlike the template's.
 */
export const stagedTemplate = fixtureTemplate(import.meta, Staged, stagedInstall)

/**
 * The header's property over a case's clone of the installation (`taken`): its write inline and on the planted session,
 * the case's Db opened and its programs loaded over the clone.
 */
export const stagedOn = (taken: SubstrateCase<Generated>) =>
	Effect.gen(function* () {
		const o = yield* openedIn(Staged, {}, stagedInstall, taken)
		const s = yield* Substrate
		const names = namesOf(o.installed)
		const { ctx, load } = yield* openServedDb(o.installed, o.server.roles.app, {})
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
			textBound(changeOf(nested).entry.program),
			textBound(changeOf(tagged).entry.program)
		)
		const fresh = Effect.gen(function* () {
			yield* Effect.orDie(replaceRows(s.admin, installationGroup(names), []))
			const stored = yield* appliedOn(ctx, member(loaded, "shelves"), shelfFacts, {})
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
		const arms = (written: LoadedMember, facts: unknown, params: ParamMap, sketch: Sketch) =>
			Effect.gen(function* () {
				yield* fresh
				const inlineResult = yield* Effect.result(appliedOn(ctx, written, facts, params))
				const inline = printed(inlineResult)
				const inlineRows = yield* state
				yield* fresh
				const sent: Array<WireQuery> = []
				if (!sketch.temporary) {
					yield* database(false)
				}
				/**
				 * Without TEMPORARY, the staged arm runs on a served Db of its own, opened for it: a carrier is the
				 * session's, made by the session's stand-up of the write and kept by every COMMIT (sql/ast.ts
				 * CreateCarrier), so on the inline arm's session the write would find the carriers that arm stood up and
				 * create none, and TEMPORARY, which only a CREATE asks, would never be read.
				 */
				const staged = yield* Effect.scoped(
					Effect.gen(function* () {
						const on = sketch.temporary
							? ctx
							: (yield* openServedDb(o.installed, o.server.roles.app, {})).ctx
						return yield* Effect.result(
							appliedOn(
								{ ...on, pool: plantedPool(on.pool, sketch, sent, limit) },
								written,
								facts,
								params
							)
						)
					})
				).pipe(Effect.ensuring(sketch.temporary ? Effect.void : database(true)))
				const stagedRows = yield* state
				return {
					statements: changeOf(written).entry.program.statements,
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
						? yield* arms(nested, facts, {}, sketch)
						: yield* arms(tagged, facts, { tags: [{ id: 1, v: sketch.tag }] }, sketch)
				const texts = Arr.flatMap(sent, (q) => (q._tag === "control" ? [] : [sentSql(q)]))
				const carriers = Arr.flatMap(statements, (st) =>
					st.kind === "whole" && st.staged.kind === "carriers" ? st.staged.carriers : []
				)
				const created = Arr.filter(carriers, (k) => Arr.contains(texts, k.empty.sql))
				const temporary = Arr.some(texts, Str.includes("CREATE TEMPORARY TABLE "))
				const own = Arr.some(
					statements,
					(st) => st.step.kind === "carrier" && st.step.step === "empty"
				)
				const past = Arr.some(Arr.flatten(sketch.packages), (m) => m.kind === "past")
				if (sketch.flight === "past any flight") {
					c.note("a flight past one write")
					assert.ok(
						Result.isFailure(staged) && staged.failure.kind === "input",
						`${label}: a flight past one write is refused as input, not ${shown(staged)}`
					)
					assert.equal(texts.length, 0, `${label}: nothing is sent`)
					assert.deepEqual(stagedRows, shelved, `${label}: nothing is stored`)
					return
				}
				if (past) {
					c.note("a row past one fill alone")
					assert.ok(
						Result.isFailure(staged) && staged.failure.kind === "input",
						`${label}: a row no fill carries is refused as input, not ${shown(staged)}`
					)
					assert.equal(texts.length, 0, `${label}: nothing is sent`)
					assert.deepEqual(stagedRows, shelved, `${label}: nothing is stored`)
					return
				}
				if (!sketch.temporary && temporary) {
					c.note("a write without TEMPORARY")
					assert.ok(
						Result.isFailure(staged) && staged.failure.kind === "failed",
						`${label}: a temporary table the role may not create fails the write, not ${shown(staged)}`
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
				if (Result.isSuccess(staged) && staged.success.kind === "refused") {
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
		return property
	})

/** A sketch drawn, beside pantry's import (gen.ts recorded), which no draw is. */
/**
 * A sketch aimed at a stored mutable shelf recounted: one package of four to eight entries within the bound at shares
 * the CHECK Small admits and that together pass one Bind message, so its write is staged in several fills and accepted,
 * recounting each stored Shelf its entries land on (pantry's shape, its shares and places drawn); the database holding
 * TEMPORARY and the flight bound in force. A drawn sketch reaches it seldom: passing the bound takes entries of large
 * shares, and Small refuses a write any of whose entries passes four fifths of a whole one.
 */
const recountedGen: Gen<Sketch> = (source) => ({
	packages: [
		source.draw(
			array(
				(s): Member => ({
					kind: "within",
					share: s.draw(int(700, Number(small))),
					bin: s.draw(placeGen),
					shelf: s.draw(placeGen)
				}),
				{ min: 4, max: 8 }
			)
		)
	],
	temporary: true,
	tag: "none",
	flight: "in force"
})

/**
 * The cases the property runs: drawn sketches beside pantry's import, recorded (gen.ts recorded), and, for a witness
 * whose turn aims at it, a sketch that recounts a stored mutable shelf (recountedGen).
 */
export const stagedCases = aimed(recorded(sketchGen, [pantry]), [
	["a stored mutable shelf recounted", recountedGen]
])
