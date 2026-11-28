/** What the properties of arbiter.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import {
	array,
	constant,
	element,
	type Gen,
	int,
	oneOf,
	weighted,
	type Steered
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn as drawnField, natural, int4 } from "#compiler/public/fields.ts"
import { query } from "#compiler/public/query.ts"
import {
	check,
	counted,
	fin,
	fold,
	key,
	login,
	Monoid,
	on,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import {
	type CallInput,
	callStandUps,
	callStatements,
	type InstalledShape,
	shapeTemplate,
	writeBegin
} from "#test/pg/isolation/support/race.ts"
import { Id } from "#test/support/ids.ts"
import { replaceMigrated } from "#test/support/install-migrate.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { openActors, textOfValue } from "#test/support/schedules/actors.ts"
import { exploreEnv } from "#test/support/schedules/interleave.ts"
import type { ScheduleOutcome } from "#test/support/schedules/types.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

const Doc = relation("Doc", { id: Id, slug: int4, title: int4 }, ["id"])

const Invoice = relation(
	"Invoice",
	{ id: Id, amount: int4, lines: drawnField(natural), total: accumulated(int4, 0) },
	["id"]
)

const Line = relation("Line", { invoice: Id, n: int4, amount: int4 }, ["invoice", "n"])

const invoiceLines = counted(on(Line, "invoice"), fin(Invoice, "lines"))

/**
 * The import shape under the name `name`: the role `importer`, with its member `doc` and, where it `posts`, `post`.
 * Generate certifies an importer that posts SERIALIZABLE, by its post's reads of Invoice and Line, and one that only
 * inserts Docs READ COMMITTED.
 */
const importShape = (posts: boolean) => (name: string) => {
	const relations = { Doc, Invoice, Line } as const
	const base = schema(name, Rec.values(relations), [
		key(on(Doc, "slug")),
		invoiceLines,
		fold(invoiceLines, Monoid.sum, on(Line, "invoice", "amount"), on(Invoice, "id", "total")),
		check("Settled", Invoice, (i) => i.eq(i.total, i.amount))
	])
	const importer = role(base, "importer", relations, { insert: ["Doc", "Invoice", "Line"] })
	const mine = importer.relations
	const doc = ChangeSet.empty(importer).insert(
		mine.Doc,
		query(importer).rule((r) =>
			r.find({
				id: r.param("id", Id),
				slug: r.param("slug", int4),
				title: r.param("title", int4)
			})
		)
	)
	const post = ChangeSet.empty(importer).insert(mine.Invoice, []).insert(mine.Line, [])
	return {
		schema: base,
		roles: { importer },
		login: login(base, "app", [importer], {
			workload: [posts ? workload(importer, { doc, post }) : workload(importer, { doc })]
		})
	}
}

/** A uuid of the races' pool. */
const uuidOf = (n: number): string => `00000000-0000-4000-8000-${Str.padStart(12, "0")(String(n))}`

/**
 * A call before its session is named, with the keys it writes at, and whether it posts an Invoice its amount leaves
 * unsettled, an amount other than its Lines' sum, which the Settled CHECK refuses.
 */
interface CallSketch {
	readonly kind: "doc" | "post" | "lines"
	readonly member: "doc" | "post"
	readonly input: CallInput
	readonly keys: ReadonlyArray<string>
	readonly unsettled: boolean
}

const docCall = (id: number, slug: number, title: number): CallSketch => ({
	kind: "doc",
	member: "doc",
	input: { kind: "params", params: { id: uuidOf(id), slug, title } },
	keys: [`doc ${id}`, `slug ${slug}`],
	unsettled: false
})

const postCall = (id: number, amounts: ReadonlyArray<number>, amount: number): CallSketch => ({
	kind: "post",
	member: "post",
	keys: [`invoice ${id}`],
	unsettled: amount !== Arr.reduce(amounts, 0, (a, b) => a + b),
	input: {
		kind: "facts",
		facts: {
			insert: {
				Invoice: [{ id: uuidOf(id), amount }],
				Line: Arr.map(amounts, (a, n) => ({ invoice: uuidOf(id), n, amount: a }))
			}
		},
		params: {}
	}
})

/** A post of the Invoice `id` whose amount is its Lines' sum plus what `off` draws: 0 settles it, 1 the CHECK refuses. */
const postedOff =
	(id: number, off: Gen<number>): Gen<CallSketch> =>
	(s) => {
		const amounts = s.draw(array(element([1, 2, 3]), { min: 0, max: 3 }))
		const sum = Arr.reduce(amounts, 0, (a, b) => a + b)
		return postCall(id, amounts, sum + s.draw(off))
	}

/** A post whose amount is its Lines' sum, or, drawn, one off it, which the CHECK refuses. */
const posted = (id: number): Gen<CallSketch> =>
	postedOff(
		id,
		weighted([
			[3, constant(0)],
			[1, constant(1)]
		])
	)

/** The Invoice the i-th call of a disjoint race posts, which no other call of the race names. */
const disjointInvoice = (i: number): number => 20 + i

/** A race of disjoint keys: two or three calls, the i-th at keys no other names, Docs only or any. */
interface DisjointRace {
	readonly docsOnly: boolean
	readonly calls: Arr.NonEmptyReadonlyArray<CallSketch>
}

const disjointRaces: Gen<DisjointRace> = (s) => {
	const docsOnly = s.draw(element([true, false]))
	const count = s.draw(int(2, 3))
	const calls = upTo(count, (i): CallSketch =>
		docsOnly || s.draw(element([true, false]))
			? docCall(10 + i, 10 + i, s.draw(int(0, 1)))
			: s.draw(posted(disjointInvoice(i)))
	)
	return { docsOnly, calls: nonEmptyList(calls, "a race's calls") }
}

/**
 * A drawn race with its first call a post of an Invoice the CHECK refuses, at that call's own keys, so the race's keys
 * stay disjoint; a drawn race posts one too rarely for the floor and the steered phase.
 */
const refusedFirst: Gen<DisjointRace> = (s) => {
	const drawnRace = s.draw(disjointRaces)
	return {
		docsOnly: false,
		calls: [
			s.draw(postedOff(disjointInvoice(0), constant(1))),
			...Arr.tailNonEmpty(drawnRace.calls)
		]
	}
}

/**
 * The race a witness runs, drawn under its steering: while a CHECK's refusal is pending, in half its cases one whose
 * first call the CHECK refuses (refusedFirst); otherwise a drawn one, as a rotating case always is. The generator draws
 * it, so it is the race the search runs, prints and keeps.
 */
export const aimedDisjoint: Steered<DisjointRace, DisjointFeature>["under"] = (steering) =>
	Option.exists(steering, (pending) => pending.names("a CHECK refused"))
		? oneOf([disjointRaces, refusedFirst])
		: disjointRaces

/** A SIRead lock a race's sessions hold, read from pg_locks: its kind, its relation's name, and whether that relation
 * is an index of a relation some foreign key references, which in the import shape is Invoice alone. */
interface SireadLock {
	readonly kind: string
	readonly relation: string
	readonly referenced: boolean
}

const sireadLocksSql = `SELECT l.locktype, c.relname, EXISTS (
	SELECT 1 FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_constraint AS f ON f.confrelid = i.indrelid AND f.contype = 'f'
	WHERE i.indexrelid = l.relation
)::text
FROM pg_catalog.pg_locks AS l JOIN pg_catalog.pg_class AS c ON c.oid = l.relation
WHERE l.mode = 'SIReadLock' AND l.pid = ANY ($1::int4[])
ORDER BY 2, 1`

/** What one call showed: each statement's SQLSTATE where it failed, then its COMMIT's, none where all succeeded. */
const failureOf = (outcomes: ReadonlyArray<ScheduleOutcome>): string | undefined => {
	for (const o of outcomes) {
		if (o._tag === "PgError") {
			return o.fields.code
		}
		if (o._tag === "RolledBack" || o._tag === "Failed") {
			return o._tag
		}
	}
	return undefined
}

/**
 * Runs a race of disjoint keys over `s`: every session begins as the importer's served writes do, at the level generate
 * certifies it at (race.ts writeBegin), and sends its call's statements one at a time in turn with the others', so every
 * transaction is open across every other's statements, the SIRead locks are read while all are open, and each commits
 * in turn. Each call's failure, and the locks.
 */
export const runDisjoint = (s: InstalledShape, race: DisjointRace) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			yield* Effect.provideService(replaceMigrated(s.installed, {}), Substrate, substrate)
			const env = yield* exploreEnv(substrate)
			const role = defined(s.shape.roles["importer"], "the importer")
			const sessions = Arr.map(race.calls, (_, i) => `s${i}`)
			const actors = yield* openActors(
				substrate,
				Rec.fromEntries(
					Arr.map(
						sessions,
						(name) => [name, { kind: "psql" as const, as: s.installed.world(role) }] as const
					)
				)
			)
			const sent = yield* Effect.forEach(race.calls, (c, i) =>
				callStatements(s, {
					kind: "change",
					session: `s${i}`,
					role: "importer",
					member: c.member,
					input: c.input
				})
			)
			const outcomes = Arr.map(sessions, (): Array<ScheduleOutcome> => [])
			const actorOf = (i: number) => defined(actors[`s${i}`], `session s${i}`)
			for (const [i, c] of race.calls.entries()) {
				for (const sql of callStandUps(s, { role: "importer", member: c.member })) {
					yield* actorOf(i).perform({ _tag: "Sql", sql })
				}
			}
			for (const [i] of sessions.entries()) {
				const begun = yield* actorOf(i).perform(writeBegin(s, "importer"))
				defined(outcomes[i], "a session's outcomes").push(begun)
			}
			const longest = Arr.reduce(sent, 0, (most, statements) => Math.max(most, statements.length))
			for (let step = 0; step < longest; step++) {
				for (const [i, statements] of sent.entries()) {
					const sql = statements[step]
					if (sql !== undefined && failureOf(defined(outcomes[i], "outcomes")) === undefined) {
						const outcome = yield* actorOf(i).perform({ _tag: "Sql", sql })
						defined(outcomes[i], "a session's outcomes").push(outcome)
					}
				}
			}
			const pids = Arr.map(sessions, (_, i) => actorOf(i).pid)
			const rows = yield* env.observer.queryValues(sireadLocksSql, [pids])
			const locks = Arr.map(rows, (row): SireadLock => ({
				kind: textOfValue(row[0]) ?? "",
				relation: textOfValue(row[1]) ?? "",
				referenced: textOfValue(row[2]) === "true"
			}))
			for (const [i] of sessions.entries()) {
				const own = defined(outcomes[i], "a session's outcomes")
				const ended = yield* actorOf(i).perform(
					failureOf(own) === undefined ? { _tag: "Commit" } : { _tag: "Rollback" }
				)
				own.push(ended)
			}
			return { failures: Arr.map(outcomes, failureOf), locks }
		})
	)

export type DisjointFeature =
	| "docs only"
	| "an invoice posted"
	| "three sessions"
	| "a CHECK refused"
	| "a 40001 under an Invoice race"

/**
 * The import shape installed once per member as `grizzle generate` drafts and serves it (race.ts shapeTemplate): the
 * importer at the level generate certifies it at, SERIALIZABLE.
 */
export const importTemplate = shapeTemplate(import.meta, "arbiter", importShape(true))

/**
 * The import shape's Docs alone installed once per member as `grizzle generate` drafts and serves it: the importer at
 * the level generate certifies its Doc inserts at, READ COMMITTED.
 */
export const docTemplate = shapeTemplate(import.meta, "arbiter docs", importShape(false))
