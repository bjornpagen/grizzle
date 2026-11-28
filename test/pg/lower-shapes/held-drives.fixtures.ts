/** What held-drives.test.ts reads: its schema, its writes, a case's stored state and its run. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import type { Fixture } from "#bench/query/support/kit.ts"
import {
	attemptLabel,
	installWrites,
	observedChange,
	openFull,
	ownerTransaction
} from "#bench/write/support/writes.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { natural, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema, unit } from "#compiler/public/schema.ts"
import { type PgClassState, pgClassStates, standIn } from "#test/support/advice.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const i = int4

/**
 * A ledger's learner rows, as qti-pie's holds them, each under the learner's unit: each item session of a learner's
 * stage, of an item of a package; each attempt of an item; each attempt's snapshot of a variable; each attempt's
 * feedback; and a tag table no key of which the feedback's notes name. The writes' targets beside them.
 */
const Session = relation("Session", { child: i, stage: i, package: i, path: i }, [
	"child",
	"stage",
	"path"
])
const Attempt = relation("Attempt", { child: i, package: i, path: i, n: i }, [
	"child",
	"package",
	"path",
	"n"
])
const Snapshot = relation(
	"Snapshot",
	{ child: i, package: i, path: i, n: i, variable: i, value: i },
	["child", "package", "path", "n", "variable"]
)
const Feedback = relation("Feedback", { child: i, package: i, path: i, n: i, note: i }, [
	"child",
	"package",
	"path",
	"n"
])
const Out = relation("Out", { child: i, package: i, path: i, n: i, variable: i, value: i }, [
	"child",
	"package",
	"path",
	"n",
	"variable"
])
const Noted = relation("Noted", { child: i, package: i, path: i, n: i, note: i }, [
	"child",
	"package",
	"path",
	"n"
])
const Tally = relation("Tally", { child: i, package: i, path: i, attempts: natural }, [
	"child",
	"package",
	"path"
])
const Picked = relation("Picked", { child: i, stage: i, package: i, path: i }, [
	"child",
	"stage",
	"path"
])

const build = (name: string) =>
	schema(
		name,
		[Session, Attempt, Snapshot, Feedback, Out, Noted, Tally, Picked],
		[unit("Learner", { child: i })]
	)

type Schema = ReturnType<typeof build>

/** The stored relations the property counts the rows a write reads of: the learner's, every unit's. */
const counted = [Session, Attempt, Snapshot, Feedback] as const

/**
 * How a write reads the call's sittings: `inputs`, its relation input joined to the sessions, their attempts and the
 * attempts' snapshots in one rule; `share`, two inserts reading one join of the sittings, sessions and attempts, a share
 * the statement holds, one beside the snapshots, the other beside the feedback; `fold`, the call's seats beside a region of each session of
 * their stage beside its item's count of attempts, the region computed apart (a fold inside it) and read at the keys
 * the seats name, two seats naming each stage: a stage's region is evaluated once at its key, never once for each seat
 * that names it, each evaluation reading every attempt of its sessions' items (a count, which no index's first or last
 * entry answers, as it would a max); `array`, the call's array of items beside the
 * learner's sessions of a stage at its parameters, a unit's rows its history grows (edullm's answerTestItem `next`
 * rules): the array the call passes in leads, each item a seek of its session, never the learner's every session read
 * first and filtered by the array; `pair`, the call's sittings beside a definition of each session with both of its
 * attempts' variables, one join of the attempts and their snapshots read twice, navigated from the sittings' columns
 * (analysis/theory/navigate.ts navigatedRule `inputs`): navigated from no value, it led with every learner's snapshots
 * of the first variable and read the sessions last (CARRYKEY's finding 5).
 */
export type Form = "inputs" | "share" | "fold" | "array" | "pair"

const forms = ["inputs", "share", "fold", "array", "pair"] as const satisfies ReadonlyArray<Form>

/** A case: the form of the call's rows, and the pg_class state every table stands in (test/support/advice.ts PgClassState). */
export interface HeldCase {
	readonly form: Form
	readonly state: PgClassState
}

export const heldGen: Gen<HeldCase> = (s) => ({
	form: s.draw(element<Form>(forms)),
	state: s.draw(element<PgClassState>(pgClassStates))
})

export type HeldFeature =
	| "the relation input"
	| "a share two inserts read"
	| "a fold's region read at the call's keys"
	| "the call's array beside a unit's rows"
	| "a definition the call's rows bind"
	| `every table ${PgClassState}`

const sittingsHeading = { child: i, stage: i } as const

/** The call's seats (form `fold`): a learner's sittings, each at a seat of its stage. */
const seatsHeading = { child: i, stage: i, seat: i } as const

/** A query of the sittings' sessions' attempts, `sittings` the write's relation input. */
const processingOf = (s: Schema) =>
	query(s).rule((r) => {
		const sittings = r.relation("sittings", sittingsHeading)
		const { child, stage } = v(sittings, "sitting")
		const { package: pkg, path } = v(Session, "session")
		const { n } = v(Attempt, "attempt")
		return r
			.match(sittings, { child, stage })
			.match(Session, { child, stage, package: pkg, path })
			.match(Attempt, { child, package: pkg, path, n })
			.find({ child, package: pkg, path, n })
	})

/** The case's write: what `form` inserts from the call's sittings. */
const changeOf = (s: Schema, form: Form) => {
	const processing = processingOf(s)
	const snaps = query(s).rule((r) => {
		const p = processing.bind({ sittings: r.relation("sittings", sittingsHeading) })
		const { child, package: pkg, path, n } = v(p, "processing")
		const { variable, value } = v(Snapshot, "snapshot")
		return r
			.match(p, { child, package: pkg, path, n })
			.match(Snapshot, { child, package: pkg, path, n, variable, value })
			.find({ child, package: pkg, path, n, variable, value })
	})
	switch (form) {
		case "inputs":
			return ChangeSet.empty(s).insert(
				Out,
				query(s).rule((r) => {
					const sittings = r.relation("sittings", sittingsHeading)
					const { child, stage } = v(sittings, "sitting")
					const { package: pkg, path } = v(Session, "session")
					const { n } = v(Attempt, "attempt")
					const { variable, value } = v(Snapshot, "snapshot")
					return r
						.match(sittings, { child, stage })
						.match(Session, { child, stage, package: pkg, path })
						.match(Attempt, { child, package: pkg, path, n })
						.match(Snapshot, { child, package: pkg, path, n, variable, value })
						.find({ child, package: pkg, path, n, variable, value })
				})
			)
		case "share":
			return ChangeSet.empty(s)
				.insert(Out, snaps)
				.insert(
					Noted,
					query(s).rule((r) => {
						const p = processing.bind({ sittings: r.relation("sittings", sittingsHeading) })
						const { child, package: pkg, path, n } = v(p, "processing")
						const { note } = v(Feedback, "feedback")
						return r
							.match(p, { child, package: pkg, path, n })
							.match(Feedback, { child, package: pkg, path, n, note })
							.find({ child, package: pkg, path, n, note })
					})
				)
		case "fold": {
			const tally = query(s).rule((r) => {
				const { child, package: pkg, path, n } = v(Attempt, "attempt")
				return r
					.match(Attempt, { child, package: pkg, path, n })
					.find({ child, package: pkg, path, attempts: r.count() })
			})
			const progress = query(s).rule((r) => {
				const { child, stage, package: pkg, path } = v(Session, "session")
				const { attempts } = v(tally, "tally")
				return r
					.match(Session, { child, stage, package: pkg, path })
					.match(tally, { child, package: pkg, path, attempts })
					.find({ child, stage, package: pkg, path, attempts })
			})
			return ChangeSet.empty(s).insert(
				Tally,
				query(s).rule((r) => {
					const seats = r.relation("seats", seatsHeading)
					const { child, stage } = v(seats, "seat")
					const { package: pkg, path, attempts } = v(progress, "progress")
					return r
						.match(seats, { child, stage })
						.match(progress, { child, stage, package: pkg, path, attempts })
						.find({ child, package: pkg, path, attempts })
				})
			)
		}
		case "pair": {
			const snapshots = query(s).rule((r) => {
				const { child, package: pkg, path, n } = v(Attempt, "attempt")
				const { variable, value } = v(Snapshot, "snapshot")
				return r
					.match(Attempt, { child, package: pkg, path, n })
					.match(Snapshot, { child, package: pkg, path, n, variable, value })
					.find({ child, package: pkg, path, n, variable, value })
			})
			const both = query(s).rule((r) => {
				const { child, stage, package: pkg, path } = v(Session, "session")
				const { n, value: first } = v(snapshots, "first")
				const { value: second } = v(snapshots, "second")
				return r
					.match(Session, { child, stage, package: pkg, path })
					.match(snapshots, { child, package: pkg, path, n, variable: 1, value: first })
					.match(snapshots, { child, package: pkg, path, n, variable: 2, value: second })
					.find({ child, stage, package: pkg, path, n, first, second })
			})
			return ChangeSet.empty(s).insert(
				Noted,
				query(s).rule((r) => {
					const sittings = r.relation("sittings", sittingsHeading)
					const { child, stage } = v(sittings, "sitting")
					const { package: pkg, path, n, second } = v(both, "both")
					return r
						.match(sittings, { child, stage })
						.match(both, { child, stage, package: pkg, path, n, second })
						.find({ child, package: pkg, path, n, note: second })
				})
			)
		}
		case "array":
			return ChangeSet.empty(s).insert(
				Picked,
				query(s).rule((r) => {
					const next = r.relation("next", { package: i, path: i })
					const { package: pkg, path } = v(next, "next")
					return r
						.match(next, { package: pkg, path })
						.match(Session, {
							child: r.param("child", i),
							stage: r.param("stage", i),
							package: pkg,
							path
						})
						.find({ child: r.param("child", i), stage: r.param("stage", i), package: pkg, path })
				})
			)
	}
}

/** The call's sittings: learner 1's two stages. */
const sittings = [
	{ child: 1, stage: 0 },
	{ child: 1, stage: 1 }
] as const

/** The call's seats (form `fold`): learner 1's two stages, each at two seats, so the call names each stage twice. */
const seats = [
	{ child: 1, stage: 0, seat: 1 },
	{ child: 1, stage: 0, seat: 2 },
	{ child: 1, stage: 1, seat: 1 },
	{ child: 1, stage: 1, seat: 2 }
] as const

/** The call's array of items (form `array`): two of learner 1's history's items, at its stage 7. */
const next = [
	{ package: 2, path: 100 },
	{ package: 2, path: 101 }
] as const

/** Each learner's items: three of package 1, each item a session at both stages, so two sessions share each key. */
const items = [1, 2, 3] as const

/**
 * The load of learners 1 to `learners` (test/support/advice.ts StateLoad), a learner its unit, each call one owner's
 * transaction judged at its COMMIT (bench/write/support/writes.ts ownerTransaction): each learner's sessions of the
 * three items at both stages, a session more of learner 1's history of another package at stage 7 (a unit's rows,
 * growing with the learners stored), two attempts of each item, a snapshot of two variables of each attempt, and the
 * feedback of each first attempt.
 */
const stored = (fx: Fixture<unknown>, learners: number) => {
	const names = namesOf(fx.installed)
	const it = `unnest(ARRAY[${Arr.join(Arr.map(items, String), ", ")}]) AS it(path)`
	const columns = (r: Parameters<typeof names.table>[0], fs: ReadonlyArray<string>) =>
		`${names.table(r)} (${Arr.join(
			Arr.map(fs, (f) => quoteIdent(names.columnIdent(r, f))),
			", "
		)})`
	return {
		tables: Arr.map([Session, Attempt, Snapshot, Feedback] as const, (t) => names.table(t)),
		units: learners,
		load: (from: number, to: number) => {
			const g = `generate_series(${String(from)}, ${String(to)}) AS g(child)`
			return ownerTransaction([
				`INSERT INTO ${columns(Session, ["child", "stage", "package", "path"])} SELECT child, stage, 1, path FROM ${g}, generate_series(0, 1) AS st(stage), ${it}`,
				`INSERT INTO ${columns(Session, ["child", "stage", "package", "path"])} SELECT 1, 7, 2, 99 + child FROM ${g}`,
				`INSERT INTO ${columns(Attempt, ["child", "package", "path", "n"])} SELECT child, 1, path, n FROM ${g}, ${it}, generate_series(1, 2) AS a(n)`,
				`INSERT INTO ${columns(Snapshot, ["child", "package", "path", "n", "variable", "value"])} SELECT child, 1, path, n, variable, variable FROM ${g}, ${it}, generate_series(1, 2) AS a(n), generate_series(1, 2) AS b(variable)`,
				`INSERT INTO ${columns(Feedback, ["child", "package", "path", "n", "note"])} SELECT child, 1, path, 1, path FROM ${g}, ${it}`
			])
		}
	}
}

/** The rows `form`'s write leaves in its target: learner 1's of the two stages, each item's once. */
const expected = (form: Form): number =>
	form === "inputs" || form === "share"
		? items.length * 2 * 2
		: form === "array"
			? next.length
			: form === "pair"
				? items.length * 2
				: items.length

/**
 * One scale's run, on an installation whose workload holds each form's write, so it plans the index every read of
 * theirs asks for (a write served under a snapshot reads only through the indexes it holds, deploy/snapshot/served.ts
 * snapshotResolver): the rows the write read of each counted relation, each its sequential scans' rows and its indexes'
 * entries returned (pg_stat_get_xact_tuples_returned of the table and of each index on it), an index-only scan's among
 * them, which fetch no heap row (idx_tup_fetch counts none of an attempt's, its key every column it holds); and the rows
 * its first target holds after.
 */
const runAt = (c: HeldCase, learners: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const s0 = yield* Substrate
			const base = build("HeldDrives")
			const fx = yield* installWrites(base, "helddrives", {
				programs: Rec.fromEntries(Arr.map(forms, (f) => [f, changeOf(base, f)] as const)),
				logins: () => []
			})
			const S = build(fx.installed.declared)
			const names = namesOf(fx.installed)
			yield* standIn({ values: s0.admin.queryValues }, stored(fx, learners), c.state)
			const db = yield* openFull(fx, S)
			const read = new Map<string, number>()
			const observed = yield* observedChange(db, changeOf(S, c.form), attemptLabel, {
				kind: "probe",
				run: (probe) =>
					Effect.map(
						probe.rows(
							`SELECT t.k::text, (pg_catalog.pg_stat_get_xact_tuples_returned(t.rel) + (SELECT COALESCE(pg_catalog.sum(pg_catalog.pg_stat_get_xact_tuples_returned(i.indexrelid)), 0) FROM pg_catalog.pg_index AS i WHERE i.indrelid = t.rel))::text FROM pg_catalog.unnest(ARRAY[${Arr.join(
								Arr.map(counted, (_, k) => `$${k + 1}::pg_catalog.regclass`),
								", "
							)}]) WITH ORDINALITY AS t(rel, k)`,
							Arr.map(counted, (r) => names.table(r))
						),
						(rows) => {
							for (const row of rows) {
								read.set(String(row[0]), Number(row[1]))
							}
						}
					)
			})
			const applied = yield* observed.apply(
				c.form === "array"
					? { next, child: 1, stage: 7 }
					: c.form === "fold"
						? { seats }
						: { sittings }
			)
			assert.ok(
				applied.value.kind === "accepted",
				`${c.form} at ${String(learners)} learners: the call commits, not ${applied.value.kind}`
			)
			const target =
				c.form === "fold" ? Tally : c.form === "array" ? Picked : c.form === "pair" ? Noted : Out
			const rows = yield* Effect.map(
				s0.admin.queryValues(`SELECT pg_catalog.count(*)::text FROM ${names.table(target)}`, []),
				(r) => Number(r[0]?.[0])
			)
			assert.equal(
				rows,
				expected(c.form),
				`${c.form} at ${String(learners)} learners: the target's rows`
			)
			return Arr.map(counted, (r, k) => ({
				relation: r.name,
				rows: defined(read.get(String(k + 1)), "a counted relation's rows read")
			}))
		})
	)

/**
 * The learners stored beside the call's: a few, then two thousand, so the snapshots are a table PostgreSQL seeks rather
 * than scans at the call's keys.
 */
const scales = [4, 2000] as const

/**
 * A case: the write at each scale. The rows it reads of every counted relation at two thousand learners are at most those
 * at four, the call's own rows alone entering its work; and where a region holding a fold is read at the call's keys,
 * beside two thousand learners (where a seek, not a scan of a page or two, reads them) it is evaluated once at each
 * stage the seats name, its attempts read once for each stage, never once for each seat that names it.
 */
export const runHeld = (c: HeldCase, k: Case<HeldFeature>) =>
	Effect.gen(function* () {
		const [few, many] = yield* Effect.forEach(scales, (learners) => runAt(c, learners))
		const at = (
			runs: ReadonlyArray<{ readonly relation: string; readonly rows: number }> | undefined
		) =>
			Arr.join(
				Arr.map(runs ?? [], (r) => `${r.relation} ${String(r.rows)}`),
				", "
			)
		for (const [a, b] of Arr.zip(defined(few, "the few"), defined(many, "the many"))) {
			assert.ok(
				b.rows <= a.rows,
				`${c.form} with every table ${c.state}: the write reads ${String(b.rows)} rows of ${b.relation} beside ${String(scales[1])} learners, ${String(a.rows)} beside ${String(scales[0])} (${at(few)}; ${at(many)})`
			)
		}
		if (c.form === "fold") {
			const attempts = Option.getOrThrow(
				Arr.findFirst(defined(many, "the many"), (r) => r.relation === "Attempt")
			).rows
			const once = new Set(Arr.map(seats, (s) => s.stage)).size * items.length * 2
			assert.ok(
				attempts <= once,
				`fold with every table ${c.state}: the write reads ${String(attempts)} attempts beside ${String(scales[1])} learners, more than its stages' ${String(once)}, the region evaluated again for a seat naming a stage another named`
			)
		}
		k.note(
			c.form === "inputs"
				? "the relation input"
				: c.form === "share"
					? "a share two inserts read"
					: c.form === "fold"
						? "a fold's region read at the call's keys"
						: c.form === "pair"
							? "a definition the call's rows bind"
							: "the call's array beside a unit's rows"
		)
		k.note(`every table ${c.state}`)
	})
