/** What the property of borrows.test.ts reads: its box of borrows, its races, and the run of a race against its model. */

import { defined } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	oneOf,
	shuffled,
	type Steered,
	weighted
} from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Effect,
	Exit,
	Fiber,
	Option,
	Order,
	Record as Rec,
	String as Str
} from "effect"
import type { BorrowLock } from "#compiler/core/certificate.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { anyNumeric, wildcardText } from "#compiler/scalar/compute/types.ts"
import type { Expr, TypeRef } from "#compiler/sql/ast.ts"
import { cast, lit, provedSelect, targetAs, types } from "#compiler/sql/build.ts"
import { emitText, costChosen } from "#compiler/sql/emit.ts"
import { NameSupply } from "#compiler/sql/naming.ts"
import { type LockKey, lockId } from "#compiler/write/borrow/lock.ts"
import { type BorrowArm, borrowQuery } from "#compiler/write/borrow/statement.ts"
import { ownStatement } from "#compiler/write/insert/statement.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed } from "#test/support/install-migrate.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"
import { float8 } from "#test/support/oracle/gen/domain.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { type DirectActor, openActors, textOfValue } from "#test/support/schedules/actors.ts"
import { exploreEnv } from "#test/support/schedules/interleave.ts"
import type { ScheduleOutcome } from "#test/support/schedules/types.ts"
import { lockWaitOf } from "#test/support/substrate/barrier.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { fullWorld } from "#test/support/worlds.ts"

/** A relation for the installation to hold, whose role's sessions borrow; no case reads or writes it. */
const Mark = relation("Mark", { id: pg.integer }, ["id"])

const Borrows = schema("Borrows", [Mark], [])

/** Borrows' full world, whose role every session of a race takes on. */
const world = fullWorld(Borrows, {}, [])

/** Borrows installed once per member with its full world's login: the installation and its borrow function. */
export const borrowsTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "borrows",
	fixture: Borrows,
	programs: {},
	contexts: [],
	label: "borrows",
	ambient: ordinarySession
})

/**
 * A key field of the box: its type, the SQL type its value's text is cast to, none for a text, and the model's reading
 * of a value's text under the type's equality.
 */
interface BoxField {
	readonly type: ScalarType
	readonly sqlType: TypeRef | undefined
	readonly value: (text: string) => string
}

/** A text field: every text its own value. */
const textField: BoxField = { type: wildcardText, sqlType: undefined, value: (t) => t }

/** A decimal's digits with no trailing zero after its point, nor the point where none is left after it. */
const unscaled = (t: string): string =>
	Str.endsWith("0")(t)
		? unscaled(Str.slice(0, -1)(t))
		: Str.endsWith(".")(t)
			? Str.slice(0, -1)(t)
			: t

/** A numeric field: a value's digits with no trailing zero after its point, so 1.0 and 1.00 are 1. */
const numericField: BoxField = {
	type: anyNumeric,
	sqlType: types.numeric,
	value: (t) => (Str.includes(".")(t) ? unscaled(t) : t)
}

/** A float field: its zero `0` whatever its sign, so -0 and 0 are one value. */
const floatField: BoxField = {
	type: float8,
	sqlType: types.double,
	value: (t) => (Number(t) === 0 ? "0" : t)
}

/**
 * The lock kinds of the box, each its key fields and its keys, as the texts of their values: three units and the series
 * lock of no key. `pair`'s keys hold two texts, so the two whose texts run together alike ("a" "bc" and "ab" "c") must
 * take two locks; `amount`'s a numeric, whose 1.0 and 1.00 are one value, as 2.5 and 2.50 are; `level`'s a float, whose
 * -0 and 0 are one value.
 */
const box = {
	pair: {
		fields: [textField, textField],
		keys: [
			["a", "bc"],
			["ab", "c"],
			["a", "b"]
		]
	},
	amount: { fields: [numericField], keys: [["1.0"], ["1.00"], ["2.5"], ["2.50"]] },
	level: { fields: [floatField], keys: [["0"], ["-0"], ["1.5"]] },
	series: { fields: [], keys: [[]] }
} as const satisfies Readonly<
	Record<
		string,
		{
			readonly fields: ReadonlyArray<BoxField>
			readonly keys: Arr.NonEmptyReadonlyArray<ReadonlyArray<string>>
		}
	>
>

type KindName = keyof typeof box

const kindNames: Arr.NonEmptyReadonlyArray<KindName> = ["pair", "amount", "level", "series"]

/** One borrow of a call: a kind, its key by its place in the kind's keys, and whether exclusive. */
export interface DrawnBorrow {
	readonly kind: KindName
	readonly key: number
	readonly exclusive: boolean
}

/** One call of a race: its borrows, one statement's, and how its session ends once it holds them. */
export interface BorrowCall {
	readonly borrows: Arr.NonEmptyReadonlyArray<DrawnBorrow>
	readonly ends: "commit" | "rollback"
}

/**
 * A race: the installation's lock order, each kind's rank its place in `order`; two to four calls, the i-th in session
 * s_i, every session begun in index order; then each call's borrow statement sent in `starts`' order, each while every
 * call before it holds what it was granted and waits for what it was not; then the sessions ended in `ends`' order, each
 * as soon as its borrows are through, a session waiting on another taking its turn once that one ended.
 */
export interface BorrowRace {
	readonly order: Arr.NonEmptyReadonlyArray<KindName>
	readonly calls: Arr.NonEmptyReadonlyArray<BorrowCall>
	readonly starts: ReadonlyArray<number>
	readonly ends: ReadonlyArray<number>
}

const borrowGen: Gen<DrawnBorrow> = (s) => {
	const kind = s.draw(element(kindNames))
	return {
		kind,
		key: s.draw(
			element(
				nonEmptyList(
					upTo(box[kind].keys.length, (i) => i),
					"a kind's keys"
				)
			)
		),
		exclusive: s.draw(boolean)
	}
}

const callGen: Gen<BorrowCall> = (s) => ({
	borrows: nonEmptyList(s.draw(array(borrowGen, { min: 1, max: 5 })), "a call's borrows"),
	ends: s.draw(
		weighted([
			[3, constant<BorrowCall["ends"]>("commit")],
			[1, constant<BorrowCall["ends"]>("rollback")]
		])
	)
})

/** Every element of a list of `n`, in some order. */
const whole = (n: number) => ({ min: n, max: n })

const borrowRaces: Gen<BorrowRace> = (s) => {
	const calls = nonEmptyList(s.draw(array(callGen, { min: 2, max: 4 })), "a race's calls")
	const sessions = nonEmptyList(
		upTo(calls.length, (i) => i),
		"a race's sessions"
	)
	return {
		order: nonEmptyList(s.draw(shuffled(kindNames, whole(kindNames.length))), "the lock order"),
		calls,
		starts: s.draw(shuffled(sessions, whole(sessions.length))),
		ends: s.draw(shuffled(sessions, whole(sessions.length)))
	}
}

const borrow = (kind: KindName, key: number, exclusive: boolean): DrawnBorrow => ({
	kind,
	key,
	exclusive
})

/**
 * A race that reaches a shared borrow queued behind a waiting exclusive one: a shared holder of an amount; an exclusive
 * borrower of it by another spelling, which holds the series' lock and a pair below it as it waits; and a shared
 * borrower of it queued behind that waiter. Its sessions end in a drawn order.
 */
const queuedRace: Gen<BorrowRace> = (s) => ({
	order: ["series", "pair", "amount", "level"],
	calls: [
		{ borrows: [borrow("amount", 0, false)], ends: "commit" },
		{
			borrows: [borrow("amount", 1, true), borrow("series", 0, true), borrow("pair", 0, false)],
			ends: "commit"
		},
		{ borrows: [borrow("amount", 0, false), borrow("level", 2, false)], ends: "rollback" }
	],
	starts: [0, 1, 2],
	ends: s.draw(shuffled([0, 1, 2], whole(3)))
})

/**
 * A race that reaches a shared borrow beside a shared holder: a call that borrows one amount by two spellings, shared
 * and exclusive, and a level; another that borrows the two pairs whose texts run together alike and the level by its
 * other zero, shared, beside a third holding it shared, then waits on the first call's level. Its sessions end in a
 * drawn order.
 */
const besideRace: Gen<BorrowRace> = (s) => ({
	order: ["pair", "amount", "level", "series"],
	calls: [
		{ borrows: [borrow("level", 0, false)], ends: "commit" },
		{ borrows: [borrow("level", 1, false), borrow("amount", 2, false)], ends: "commit" },
		{
			borrows: [borrow("amount", 0, false), borrow("amount", 1, true), borrow("level", 2, true)],
			ends: "rollback"
		},
		{
			borrows: [borrow("pair", 0, true), borrow("pair", 1, true), borrow("amount", 3, true)],
			ends: "commit"
		}
	],
	starts: [0, 1, 2, 3],
	ends: s.draw(shuffled([0, 1, 2, 3], whole(4)))
})

/**
 * The race a case runs, drawn under its steering: the race that reaches the situation it aims at where one does, else
 * a drawn one or either race, each alike, while a situation is pending; otherwise a drawn one.
 */
export const aimedBorrowRaces: Steered<BorrowRace, BorrowFeature>["under"] = (steering) =>
	Option.match(steering, {
		onNone: () => borrowRaces,
		onSome: (pending) =>
			pending.aimed("a shared borrow queued behind a waiting exclusive one")
				? queuedRace
				: pending.aimed("a shared borrow beside a shared holder")
					? besideRace
					: oneOf([borrowRaces, queuedRace, besideRace])
	})

export type BorrowFeature =
	| "a call waiting while it holds the locks below the one it waits on"
	| "a shared borrow beside a shared holder"
	| "an exclusive borrow waiting on a shared holder"
	| "a shared borrow queued behind a waiting exclusive one"
	| "one key by two spellings in one call"
	| "two keys whose texts run together alike in one call"
	| "one lock borrowed shared and exclusive in one call"
	| "the series' lock"

/** A kind's rank: its place in the race's lock order. */
const rankOf = (race: BorrowRace, kind: KindName): number =>
	Option.getOrThrow(Arr.findFirstIndex(race.order, (k) => k === kind))

/** The lock kind a kind of the box is: its own unit, or the series lock, of its own name. */
const lockKindOf = (kind: KindName): BorrowLock =>
	kind === "series" ? { kind: "series", relation: kind } : { kind: "unit", unit: kind }

/** A borrow's key: its texts and its kind's fields, field by field. */
const keyOf = (
	b: DrawnBorrow
): ReadonlyArray<{ readonly text: string; readonly field: BoxField }> => {
	const kind = box[b.kind]
	const texts: ReadonlyArray<string> = defined(kind.keys[b.key], "a key of the box")
	return Arr.map(texts, (text, i) => ({ text, field: defined(kind.fields[i], "a key field") }))
}

/** A borrow's lock as the model reads it: its kind and its key's values under equality. */
const lockOf = (b: DrawnBorrow): string =>
	`${b.kind}(${Arr.join(
		Arr.map(keyOf(b), ({ text, field }) => field.value(text)),
		", "
	)})`

/** A borrow's key fields as a lock reads them: each value's text cast to its field's type. */
const lockKeys = (b: DrawnBorrow): ReadonlyArray<LockKey> =>
	Arr.map(keyOf(b), ({ text, field }) => {
		const literal = lit.text(text, types.text)
		return {
			expr: field.sqlType === undefined ? literal : cast(literal, field.sqlType),
			type: field.type
		}
	})

/** A borrow's arm of its call's borrow statement, its key a row of no source. */
const armOf = (b: DrawnBorrow): BorrowArm => {
	if (b.kind === "series") {
		return { kind: "series", relation: b.kind, exclusive: b.exclusive }
	}
	return {
		kind: "unit",
		unit: b.kind,
		exclusive: b.exclusive,
		keys: { from: [], where: undefined, fields: nonEmptyList(lockKeys(b), "a unit's key") }
	}
}

/** A kind's rank in `race`, as a literal, by its lock kind. */
const rankLiteral =
	(race: BorrowRace) =>
	(lock: BorrowLock): Expr => {
		const name = lock.kind === "unit" ? lock.unit : lock.relation
		const kind = Option.getOrThrow(Arr.findFirst(kindNames, (k) => k === name))
		return lit.int(rankOf(race, kind), types.integer)
	}

/** A call's borrow statement's text (write/borrow/statement.ts borrowQuery) in the installation's schema. */
const borrowSql = (race: BorrowRace, call: BorrowCall, installedSchema: string): string => {
	const supply = new NameSupply(ownStatement)
	const ast = borrowQuery(installedSchema, Arr.map(call.borrows, armOf), rankLiteral(race), supply)
	return emitText(ast, supply.map(), costChosen).text
}

/** One statement reading every borrow's lock id (write/borrow/lock.ts lockId), in the race's calls' borrows' order. */
const idsSql = (race: BorrowRace): string => {
	const supply = new NameSupply(ownStatement)
	const targets = Arr.flatMap(race.calls, (call) =>
		Arr.map(call.borrows, (b) =>
			targetAs(
				cast(lockId(rankLiteral(race)(lockKindOf(b.kind)), b.kind, lockKeys(b)), types.text),
				supply.column({ kind: "internal", purpose: "lock id" })
			)
		)
	)
	return emitText(
		provedSelect("oneRow", nonEmptyList(targets, "the race's borrows"), [], undefined),
		supply.map(),
		costChosen
	).text
}

/** A lock as a session holds or waits for it: its id and whether exclusive. */
interface HeldLock {
	readonly id: bigint
	readonly exclusive: boolean
}

/** A session's advisory locks: those granted, in id order, and the one it waits for, if any. */
interface Locks {
	readonly granted: ReadonlyArray<HeldLock>
	readonly waiting: HeldLock | undefined
}

/** A backend's advisory locks as pg_locks shows them, each by its int8 key, its high half classid and its low objid. */
const locksSql = `SELECT ((l.classid::pg_catalog.int8 << 32) | l.objid::pg_catalog.int8)::pg_catalog.text, l.mode, l.granted::pg_catalog.text FROM pg_catalog.pg_locks AS l WHERE l.pid = $1::pg_catalog.int4 AND l.locktype = 'advisory' ORDER BY 1`

const lockText = (l: HeldLock): string => `${l.id} ${l.exclusive ? "exclusive" : "shared"}`

const locksText = (locks: Locks): string =>
	`${Arr.join(Arr.map(locks.granted, lockText), ", ") || "nothing"} granted${
		locks.waiting === undefined ? "" : `, waiting for ${lockText(locks.waiting)}`
	}`

const byId = Order.mapInput(Order.BigInt, (l: HeldLock) => l.id)

/** Whether two modes conflict: an exclusive lock with any other, a shared one with an exclusive one. */
const conflicts = (a: HeldLock, b: HeldLock): boolean =>
	a.id === b.id && (a.exclusive || b.exclusive)

/** What failed of a session's statement: its SQLSTATE or its tag, none where it succeeded. */
const failureOf = (o: ScheduleOutcome): string | undefined =>
	o._tag === "PgError"
		? o.fields.code
		: o._tag === "RolledBack" || o._tag === "Failed"
			? o._tag
			: undefined

/** What a race showed: the problems it met, and the features it reached. */
interface BorrowRun {
	readonly problems: ReadonlyArray<string>
	readonly features: ReadonlyArray<BorrowFeature>
}

/** The features a race's calls reach by their borrows alone. */
const drawnFeatures = (race: BorrowRace): ReadonlyArray<BorrowFeature> =>
	Arr.flatMap(race.calls, (call): ReadonlyArray<BorrowFeature> => {
		const spelled = Arr.map(call.borrows, (x) => `${x.kind}:${x.key}`)
		const locks = Arr.dedupe(Arr.map(call.borrows, lockOf))
		const both = Arr.some(locks, (l) => {
			const at = Arr.filter(call.borrows, (x) => lockOf(x) === l)
			return Arr.some(at, (x) => x.exclusive) && Arr.some(at, (x) => !x.exclusive)
		})
		return [
			...(locks.length < Arr.dedupe(spelled).length
				? ["one key by two spellings in one call" as const]
				: []),
			...(Arr.contains(spelled, "pair:0") && Arr.contains(spelled, "pair:1")
				? ["two keys whose texts run together alike in one call" as const]
				: []),
			...(both ? ["one lock borrowed shared and exclusive in one call" as const] : []),
			...(Arr.some(call.borrows, (x) => x.kind === "series") ? ["the series' lock" as const] : [])
		]
	})

/**
 * The problems of a race's lock ids, `ids` each borrow's in the race's calls' borrows' order: two borrows take one lock
 * exactly where their kinds and their key values under equality are one, and every lock of a kind of a lower rank has a
 * lower id than every lock of a kind of a higher one.
 */
const idProblems = (race: BorrowRace, ids: ReadonlyArray<bigint>): ReadonlyArray<string> => {
	const all = Arr.flatMap(race.calls, (call) => call.borrows)
	const pairs = Arr.flatMap(all, (a, i) =>
		Arr.map(all, (c, j) => ({ a, c, ia: defined(ids[i], "an id"), ic: defined(ids[j], "an id") }))
	)
	return Arr.flatMap(pairs, ({ a, c, ia, ic }) => [
		...((lockOf(a) === lockOf(c)) === (ia === ic)
			? []
			: [
					`${lockOf(a)} and ${lockOf(c)} take ${ia === ic ? "one lock" : "two locks"}, ${ia} and ${ic}`
				]),
		...(rankOf(race, a.kind) < rankOf(race, c.kind) && ia >= ic
			? [`${lockOf(a)} ranks below ${lockOf(c)}, but its id ${ia} is not below ${ic}`]
			: [])
	])
}

/**
 * Runs `race` (BorrowRace) over `installed` and judges it against the model. Its ids first (idProblems). Then each call
 * in `starts`' order: it takes its locks in the order of their ids, each at the strongest mode its borrows name it at,
 * so it holds exactly those of its locks below the first that conflicts with a lock another session holds or waits for
 * (PostgreSQL 19 lock.c: a request waits behind a waiter of a conflicting mode) and waits for that one, or holds them
 * all, each wait read by polling the backend's lock wait (substrate/barrier.ts lockWaitOf) against its fiber's end and
 * each lock read from pg_locks. Then the sessions end in `ends`' order, the first whose borrows are through, each then
 * holding every one of its locks, none refused, so none deadlocked (40P01).
 */
export const runRace = (installed: Installed, race: BorrowRace) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const env = yield* exploreEnv(substrate)
			const features = new Set<BorrowFeature>(drawnFeatures(race))
			const done = (problems: ReadonlyArray<string>): BorrowRun => ({
				problems,
				features: [...features]
			})
			const [idRow] = yield* env.observer.queryValues(idsSql(race), [])
			const ids = Arr.map(defined(idRow, "the ids' row"), (v) => BigInt(String(textOfValue(v))))
			const wrongIds = idProblems(race, ids)
			if (wrongIds.length > 0) {
				return done(wrongIds)
			}
			const calls = Arr.flatMap(race.calls, (call, i) => Arr.map(call.borrows, (b) => ({ i, b })))
			/** A call's locks in id order, each at the strongest mode its borrows name. */
			const locksOf = (i: number): ReadonlyArray<HeldLock> => {
				const own = new Map<bigint, boolean>()
				for (const [at, { i: of, b }] of calls.entries()) {
					if (of === i) {
						const id = defined(ids[at], "an id")
						own.set(id, (own.get(id) ?? false) || b.exclusive)
					}
				}
				return Arr.sort(
					Arr.map([...own], ([id, exclusive]) => ({ id, exclusive })),
					byId
				)
			}
			const writer = installed.world(world.app)
			const actors = yield* openActors(
				substrate,
				Rec.fromEntries(
					Arr.map(race.calls, (_, i) => [`s${i}`, { kind: "raw" as const, as: writer }] as const)
				)
			)
			const actorOf = (i: number): DirectActor => defined(actors[`s${i}`], `session s${i}`)
			const readLocks = (i: number) =>
				Effect.map(env.observer.queryValues(locksSql, [actorOf(i).pid]), (rows): Locks => {
					const read = Arr.map(rows, (row) => ({
						lock: {
							id: BigInt(String(textOfValue(row[0]))),
							exclusive: textOfValue(row[1]) === "ExclusiveLock"
						},
						granted: textOfValue(row[2]) === "true"
					}))
					return {
						granted: Arr.sort(
							Arr.map(
								Arr.filter(read, (l) => l.granted),
								(l) => l.lock
							),
							byId
						),
						waiting: Option.getOrUndefined(
							Option.map(
								Arr.findFirst(read, (l) => !l.granted),
								(l) => l.lock
							)
						)
					}
				})
			for (const [i] of race.calls.entries()) {
				yield* actorOf(i).perform({ _tag: "Begin" })
				yield* actorOf(i).perform({
					_tag: "Sql",
					sql: "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
				})
			}
			const model = new Map<number, Locks>()
			const fibers = new Map<number, Fiber.Fiber<ScheduleOutcome>>()
			const problems: Array<string> = []
			for (const i of race.starts) {
				if (problems.length > 0) {
					break
				}
				const own = locksOf(i)
				const others = [...model.values()]
				const blocked = Arr.findFirstIndex(own, (l) =>
					Arr.some(
						others,
						(held) =>
							Arr.some(held.granted, (h) => conflicts(h, l)) ||
							(held.waiting !== undefined && conflicts(held.waiting, l))
					)
				)
				const expected: Locks = Option.match(blocked, {
					onNone: () => ({ granted: own, waiting: undefined }),
					onSome: (at) => ({ granted: Arr.take(own, at), waiting: own[at] })
				})
				const sql = borrowSql(race, defined(race.calls[i], `call ${i}`), installed.schema)
				const fiber = yield* Effect.forkChild(actorOf(i).perform({ _tag: "Sql", sql }))
				fibers.set(i, fiber)
				for (;;) {
					const through = fiber.pollUnsafe()
					if (through !== undefined) {
						break
					}
					if ((yield* lockWaitOf(env.observer, actorOf(i).pid)) !== undefined) {
						break
					}
					yield* Effect.yieldNow
				}
				const shown = yield* readLocks(i)
				if (locksText(shown) !== locksText(expected)) {
					problems.push(
						`s${i} holds ${locksText(shown)}, where taking its locks in id order behind the sessions before it holds ${locksText(expected)}`
					)
				}
				model.set(i, shown)
				const sharedHeld = (l: HeldLock) =>
					Arr.some(others, (held) => Arr.some(held.granted, (h) => h.id === l.id && !h.exclusive))
				if (Arr.some(expected.granted, (l) => !l.exclusive && sharedHeld(l))) {
					features.add("a shared borrow beside a shared holder")
				}
				const waited = expected.waiting
				if (waited !== undefined) {
					if (expected.granted.length > 0) {
						features.add("a call waiting while it holds the locks below the one it waits on")
					}
					if (waited.exclusive && sharedHeld(waited)) {
						features.add("an exclusive borrow waiting on a shared holder")
					}
					if (
						!waited.exclusive &&
						Arr.some(others, (held) => held.waiting?.id === waited.id && held.waiting.exclusive)
					) {
						features.add("a shared borrow queued behind a waiting exclusive one")
					}
				}
			}
			/**
			 * Every session ends, in `ends`' order, the first whose borrows are through or that never sent them: rolled back
			 * once a problem is met, so every session still waiting is let through and ends too.
			 */
			const ended = new Set<number>()
			const sent = Arr.filter(race.ends, (i) => fibers.has(i))
			const throughOf = (i: number) => Option.fromNullishOr(fibers.get(i)?.pollUnsafe())
			while (ended.size < race.calls.length) {
				const ready = Arr.findFirst(
					race.ends,
					(i) => !ended.has(i) && (!fibers.has(i) || Option.isSome(throughOf(i)))
				)
				if (Option.isNone(ready)) {
					yield* Effect.raceAll(
						Arr.flatMap(sent, (i) => {
							const fiber = fibers.get(i)
							return ended.has(i) || fiber === undefined ? [] : [Fiber.await(fiber)]
						})
					)
					continue
				}
				const through = ready.value
				const exit = throughOf(through)
				const failed = Option.match(exit, {
					onNone: () => undefined,
					onSome: (e) => (Exit.isSuccess(e) ? failureOf(e.value) : "died")
				})
				if (failed !== undefined) {
					problems.push(`s${through}'s borrow failed: ${failed}`)
				} else if (Option.isSome(exit) && problems.length === 0) {
					const shown = yield* readLocks(through)
					const expected: Locks = { granted: locksOf(through), waiting: undefined }
					if (locksText(shown) !== locksText(expected)) {
						problems.push(
							`s${through}, its borrows through, holds ${locksText(shown)}, where it holds ${locksText(expected)}`
						)
					}
				}
				const commits =
					problems.length === 0 &&
					failed === undefined &&
					defined(race.calls[through], `call ${through}`).ends === "commit"
				yield* actorOf(through).perform(commits ? { _tag: "Commit" } : { _tag: "Rollback" })
				ended.add(through)
			}
			return done(problems)
		})
	)
