/** What the property of rule-disjoint.test.ts reads: its schema and template, its space, and each case's run. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, contained, derived, on, relation, schema } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, seededTemplate } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { PgErrorFields } from "#test/support/pg.ts"
import { storedSeed } from "#test/support/stored.ts"
import { refusalOf } from "#test/support/substrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/** A row of a unit, `package` its unit: its id, the join value g it is read at, and the value x it states. */
const T = relation("T", { package: pg.integer, id: pg.integer, g: pg.integer, x: pg.integer }, [
	"package",
	"id"
])
/** A row of a unit the join meets T's at g. */
const U = relation("U", { package: pg.integer, id: pg.integer, g: pg.integer }, ["package", "id"])
/** The values x a unit admits. */
const S = relation("S", { package: pg.integer, x: pg.integer }, ["package", "x"])

/**
 * The schema the property installs, every rule unit-local and so judged whole (analysis/theory/unit.ts): T, U and S
 * immutable, each keyed by its unit, `package`, first, and every rule joining within one unit.
 *
 * - Stated: each x a T row states beside a U row of its unit at its g is a value S admits: a containment of a join.
 * - Small: no T row beside a U row at its g states an x past 99: a check over the join.
 */
const Disjoint = (() => {
	const Base = schema("Disjoint", [T, U, S], [])
	const Joined = derived(
		"Joined",
		query(Base).rule((r) => {
			const { package: unit, g, x } = v(T, "t")
			return r
				.match(T, { package: unit, g, x })
				.match(U, { package: unit, g })
				.find({ package: unit, x })
		})
	)
	return schema.extend(
		[Base],
		"Disjoint_1",
		[Joined],
		[
			contained(on(Joined, "package", "x"), on(S, "package", "x")),
			check("Small", Joined, (j) => j.le(j.x, 99))
		]
	)
})()

/**
 * The stored units between and around the written ones: every package of [0, fillers) but the written ones, each of
 * `fillerRows` rows of T, U and S, lawful.
 *
 * @formatConstant the layout of the property's stored data: enough units that PostgreSQL reads each written unit by its
 *   index, and between two spaced written units enough of them that no leaf page of a package-led index holds both
 */
const layout = { fillers: 500, fillerRows: 20, spacing: 100 } as const

/**
 * Where the written units lie: `spaced`, `spacing` packages apart, stored units between them, so no page of a
 * package-led index holds two; or `adjacent`, at consecutive packages, whose boundary leaf pages they share.
 */
const placements = ["spaced", "adjacent"] as const

/** The most units a case writes at once (concurrentGen). */
const mostUnits = 4
type Placement = (typeof placements)[number]

/** One write of a written unit: a row of T, of U or of S. */
type Row =
	| { readonly relation: "T"; readonly id: number; readonly g: number; readonly x: number }
	| { readonly relation: "U"; readonly id: number; readonly g: number }
	| { readonly relation: "S"; readonly x: number }

/** A written unit's rows: each T row's x admitted by S, so the unit keeps both rules. */
const unitGen: Gen<ReadonlyArray<Row>> = (s) => {
	const ts = s.draw(int(1, 3))
	const us = s.draw(int(1, 3))
	const g = element([1, 2, 3])
	return [
		...Array.from({ length: ts }, (_, i): Row => ({ relation: "S", x: i })),
		...Array.from({ length: ts }, (_, i): Row => ({ relation: "T", id: i, g: s.draw(g), x: i })),
		...Array.from({ length: us }, (_, i): Row => ({ relation: "U", id: i, g: s.draw(g) }))
	]
}

/**
 * A case: two to four transactions, each writing one unit of its own where `placement` puts it, and their interleaving,
 * each step the transaction whose next statement, or COMMIT after its last, runs next.
 */
export interface Concurrent {
	readonly placement: Placement
	readonly units: ReadonlyArray<ReadonlyArray<Row>>
	readonly order: ReadonlyArray<number>
}

export const concurrentGen: Gen<Concurrent> = (s) => {
	const placement = s.draw(element(placements))
	const units = s.draw(array(unitGen, { min: 2, max: mostUnits }))
	const left = Arr.map(units, (rows) => rows.length + 1)
	const order: Array<number> = []
	for (;;) {
		const ready = Arr.filter(
			Array.from({ length: units.length }, (_, j) => j),
			(j) => (left[j] ?? 0) > 0
		)
		if (!Arr.isReadonlyArrayNonEmpty(ready)) {
			return { placement, units, order }
		}
		const j = s.draw(element(ready))
		order.push(j)
		left[j] = (left[j] ?? 0) - 1
	}
}

export type ConcurrentFeature =
	| "two units at once"
	| "three or four units at once"
	| "a unit committed before another's first write"
	| "every unit's writes before any COMMIT"
	| "adjacent units"

class Coupled extends Data.TaggedError("Coupled")<{ readonly message: string }> {}

/** The package of the `j`-th written unit where `placement` puts it. */
const packageOf = (placement: Placement, j: number): number => {
	switch (placement) {
		case "spaced":
			return (j + 1) * layout.spacing
		case "adjacent":
			return layout.spacing + j
	}
}

/** Every package a case may write a unit at, under either placement: the template stores none of them. */
const writable = Arr.dedupe(
	Arr.flatMap(placements, (placement) =>
		Array.from({ length: mostUnits }, (_, j) => packageOf(placement, j))
	)
)

/**
 * The stored units, every package of [0, fillers) a case writes no unit at (`writable`), each of `fillerRows` lawful
 * rows of T, U and S, then each table analyzed.
 */
const storedRows = (installed: Installed): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const packages = `SELECT p FROM generate_series(0, ${layout.fillers - 1}) AS f(p) WHERE p NOT IN (${Arr.join(Arr.map(writable, String), ", ")})`
	return [
		`INSERT INTO ${names.table(S)} (package, x) SELECT p, i FROM (${packages}) AS u(p), generate_series(0, ${layout.fillerRows - 1}) AS r(i)`,
		`INSERT INTO ${names.table(T)} (package, id, g, x) SELECT p, i, 1 + i % 3, i FROM (${packages}) AS u(p), generate_series(0, ${layout.fillerRows - 1}) AS r(i)`,
		`INSERT INTO ${names.table(U)} (package, id, g) SELECT p, i, 1 + i % 3 FROM (${packages}) AS u(p), generate_series(0, ${layout.fillerRows - 1}) AS r(i)`,
		...Arr.map([T, U, S], (r) => `ANALYZE ${names.table(r)}`)
	]
}

/**
 * Disjoint installed and its stored units committed through the captures once per member, judged at their COMMIT
 * (stored.ts storedSeed): the template each case's clone holds.
 */
export const disjointTemplate = seededTemplate({
	declaredIn: import.meta,
	name: "disjoint units",
	schema: Disjoint,
	options: { ambient: ordinarySession, extensions: [], label: "disjoint_units" },
	seed: storedSeed(storedRows)
})

/** The INSERT of one row of the unit of `pkg`. */
const insertOf = (installed: Installed, pkg: number, row: Row): string => {
	const names = namesOf(installed)
	switch (row.relation) {
		case "T":
			return `INSERT INTO ${names.table(T)} (package, id, g, x) VALUES (${pkg}, ${row.id}, ${row.g}, ${row.x})`
		case "U":
			return `INSERT INTO ${names.table(U)} (package, id, g) VALUES (${pkg}, ${row.id}, ${row.g})`
		case "S":
			return `INSERT INTO ${names.table(S)} (package, x) VALUES (${pkg}, ${row.x})`
	}
}

/** A predicate lock as pg_locks names it: its kind (`relation`, `page` or `tuple`), its relation, page and tuple. */
type PredicateLock = ReadonlyArray<unknown>

/** The predicate locks a session holds, read inside its own transaction. */
const ownLocks = (session: RawSession) =>
	session.values(
		"SELECT locktype, relation::regclass::text, page, tuple FROM pg_catalog.pg_locks WHERE mode = 'SIReadLock' AND pid = pg_catalog.pg_backend_pid() ORDER BY 1, 2, 3, 4",
		[]
	)

/**
 * Every predicate lock held in the case's database, as ownLocks names them, each with the pid of the backend that holds
 * it, none of a committed transaction's.
 */
const databaseLocks = (loader: RawSession) =>
	loader.values(
		"SELECT locktype, relation::regclass::text, page, tuple, pid FROM pg_catalog.pg_locks WHERE mode = 'SIReadLock' AND database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()) ORDER BY 5, 1, 2, 3, 4",
		[]
	)

/** Predicate locks read at one moment: whose, and the locks. */
interface Snapshot {
	readonly of: string
	readonly locks: ReadonlyArray<PredicateLock>
}

/** A transaction's progress through its steps: running, its next step `next`; refused; or committed. */
type Progress =
	| { readonly kind: "running"; readonly next: number }
	| { readonly kind: "refused" }
	| { readonly kind: "committed" }

/** The SQLSTATE of a serialization failure, the one refusal two adjacent units' transactions may meet. */
const serializationFailure = "40001"

/**
 * One case over a fresh clone of disjointTemplate, whose stored units the template committed: the written units'
 * transactions, each on a session
 * of its own, run in the drawn order: a transaction's first step begins it, each step after runs its next INSERT, and
 * its last, once every INSERT has run, runs its judge by SET CONSTRAINTS ALL IMMEDIATE, reads its predicate locks and
 * COMMITs. Each unit keeps every rule, and no read of a whole rule's judge leaves its own unit's pages, by the unit-led
 * index it reads, so no judge holds a relation's predicate lock, which every other writer's INSERT meets. Spaced units
 * share no page, so no transaction depends on another and SERIALIZABLE commits every one. Adjacent units share their
 * boundary leaf pages, the essential coupling of PostgreSQL's page-level predicate locks, so a transaction may meet a
 * serialization failure there; its others run on, and the database's predicate locks at the refusal join those read
 * before each COMMIT, none of them a relation's. A refusal that breaks either names the transaction, the moment and its
 * error, every transaction's predicate locks read before its COMMIT, and every lock the database holds at the refusal.
 */
export const runConcurrent = (
	installed: Installed,
	loader: RawSession,
	sessions: ReadonlyArray<RawSession>,
	drawn: Concurrent,
	c: Case<ConcurrentFeature>
) =>
	Effect.gen(function* () {
		c.note(drawn.units.length === 2 ? "two units at once" : "three or four units at once")
		if (drawn.placement === "adjacent") {
			c.note("adjacent units")
		}
		const progress: Array<Progress> = Arr.map(drawn.units, () => ({ kind: "running", next: 0 }))
		const snapshots: Array<Snapshot> = []
		const coupled = (message: string) =>
			Effect.gen(function* () {
				const held = yield* databaseLocks(loader)
				return yield* new Coupled({
					message: `${message}; the predicate locks read so far: ${Arr.join(
						Arr.map(snapshots, (s) => `${s.of}: ${Formatter.format(s.locks)}`),
						"; "
					)}; the database's at the refusal: ${Formatter.format(held)}`
				})
			})
		let committedOne = false
		let firstAfterCommit = false
		let insertAfterCommit = false
		for (const j of drawn.order) {
			const session = sessions[j]
			const rows = drawn.units[j]
			const at = progress[j]
			if (session === undefined || rows === undefined || at === undefined) {
				return yield* new Coupled({ message: `a session for unit ${j}` })
			}
			if (at.kind !== "running") {
				continue
			}
			const where = `unit ${j} (package ${packageOf(drawn.placement, j)}) of ${Formatter.format(drawn)}`
			if (at.next === 0) {
				firstAfterCommit = firstAfterCommit || committedOne
				yield* session.begin
			}
			const row = rows[at.next]
			let refused: Option.Option<PgErrorFields>
			if (row !== undefined) {
				refused = yield* refusalOf(
					session.query(insertOf(installed, packageOf(drawn.placement, j), row), [])
				)
			} else {
				refused = yield* refusalOf(session.query("SET CONSTRAINTS ALL IMMEDIATE", []))
				if (Option.isNone(refused)) {
					snapshots.push({ of: `unit ${j}`, locks: yield* ownLocks(session) })
					refused = yield* refusalOf(session.commit)
				}
			}
			if (row !== undefined) {
				insertAfterCommit = insertAfterCommit || committedOne
			}
			if (Option.isNone(refused)) {
				progress[j] =
					row === undefined ? { kind: "committed" } : { kind: "running", next: at.next + 1 }
				committedOne = committedOne || row === undefined
				continue
			}
			const moment = row === undefined ? "its judge or COMMIT" : `its INSERT ${at.next}`
			if (drawn.placement === "spaced" || refused.value.code !== serializationFailure) {
				return yield* coupled(
					`${where}: ${moment} refused ${refused.value.code} (${refused.value.message}), its units ${drawn.placement}`
				)
			}
			progress[j] = { kind: "refused" }
			yield* session.rollback
			snapshots.push({
				of: `the database at unit ${j}'s refusal`,
				locks: yield* databaseLocks(loader)
			})
		}
		if (firstAfterCommit) {
			c.note("a unit committed before another's first write")
		}
		if (!insertAfterCommit) {
			c.note("every unit's writes before any COMMIT")
		}
		const related = Arr.filter(snapshots, (s) =>
			Arr.some(s.locks, (lock) => lock[0] === "relation")
		)
		if (Arr.isReadonlyArrayNonEmpty(related)) {
			return yield* coupled(
				`${Formatter.format(drawn)}: a judge read a whole relation, ${Arr.join(
					Arr.map(related, (s) => s.of),
					", "
				)} holding a relation's predicate lock, which every writer's INSERT meets`
			)
		}
	})
