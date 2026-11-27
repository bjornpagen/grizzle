/**
 * What the properties of rule-suffix.test.ts read: a rule whose probe seeks a suffix it holds fixed, its schema and
 * template, its cases, and each case's run.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { parsePlan, planNodes } from "#bench/harness/explain.ts"
import { Logic, Text } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, derived, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { param, tableCol, types } from "#compiler/sql/build.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { suffixRange } from "#compiler/sql/suffix.ts"
import { type Seat, type SeatTemplate, seatTemplate } from "#test/pg/fin/installed.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	judgedDeltaReadsOf,
	keyedWork,
	planAsRun,
	plannedQueryOf,
	probeCostOf,
	standUpJudge,
	wideScans
} from "#test/support/judge.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** A reference's target, up to 256 bytes of any text. */
const Target = str.bytes(256, str.regex("^.*$", "su"))

/** A reference to a file, by its id: its kind and its target. */
const Ref = relation("Ref", { id: pg.integer, kind: pg.integer, target: Target }, ["id"])

/** A suffix no reference of kind 1 may end with, keyed by itself, written by a policy, as edullm's MediaType is. */
const Forbidden = relation("Forbidden", { suffix: Target }, ["suffix"])

export const RELATIONS = ["Ref", "Forbidden"] as const

/**
 * The references that end with a forbidden suffix, a join of Forbidden and Ref by a suffix test, edullm's servedPaths in
 * miniature: a forbidden suffix inserted adds the references it ends, which its probe reads by the suffix it holds
 * fixed, a seek of the B-tree on Ref's target's suffix key (sql/suffix.ts), never every reference.
 */
const schemaOf = (name: string) => {
	const Base = schema(name, [Ref, Forbidden], [])
	const Ending = derived(
		"Ending",
		query(Base).rule((r) => {
			const { id, kind, target } = v(Ref, "ref")
			const { suffix } = v(Forbidden, "forbidden")
			return r
				.match(Forbidden, { suffix })
				.match(Ref, { id, kind, target })
				.where(Logic.eq(Text.endsWith(target, suffix), true))
				.find({ id, kind })
		})
	)
	return schema.extend(
		[Base],
		`${name}_1`,
		[Ending],
		[check("Unforbidden", Ending, (e) => e.ne(e.kind, 1))]
	)
}

/** The schema installed once per member (fin/installed.ts seatTemplate). */
export const suffixTemplate: SeatTemplate = seatTemplate(
	import.meta,
	schemaOf("Rule_suffix"),
	"rule_suffix"
)

/**
 * The references of keys `from` to `to`, by one statement: each key's reference of kind 1 at `f<k>.x<k>`, which no
 * forbidden suffix ends, and its reference of kind 0 at `g<k>.z<k>`, which the suffix `.z<k>` a case forbids ends.
 */
const referencesSql = (seat: Seat, from: number, to: number): string => {
	const c = (f: string) => seat.column("Ref", f)
	return `INSERT INTO ${seat.table("Ref")} (${c("id")}, ${c("kind")}, ${c("target")}) SELECT k * 2 + kind, kind, CASE kind WHEN 1 THEN 'f' || k || '.x' || k ELSE 'g' || k || '.z' || k END FROM generate_series(${from}, ${to}) AS g(k), (VALUES (0), (1)) AS v(kind)`
}

/** A locality case: the keys the references stand for when first measured, more when measured again, and the key. */
export interface Locality {
	readonly before: number
	readonly after: number
	readonly key: number
}

/** 2,048 to 2,200 keys, so every table is larger than one probe of it, then 600 to 900 more, so the references fill more
 * heap and index pages each time. */
export const localityGen: Gen<Locality> = (s) => {
	const before = s.draw(int(2048, 2200))
	return { before, after: s.draw(int(before + 600, before + 900)), key: s.draw(int(1, before)) }
}

/** What one forbidden suffix inserted costs: the rows the judged statements over its delta read, and the SIRead locks. */
interface Footprint {
	readonly rows: ReadonlyArray<number>
	readonly locks: ReadonlyArray<string>
}

/** The SIRead locks the transaction open on `session` holds, by lock type and relation. */
const siReadLocks = (session: RawSession) =>
	Effect.map(
		session.values(
			"SELECT l.locktype, coalesce(l.relation::regclass::text, ''), count(*)::int FROM pg_catalog.pg_locks l WHERE l.mode = 'SIReadLock' AND l.virtualtransaction = (SELECT o.virtualtransaction FROM pg_catalog.pg_locks o WHERE o.pid = pg_catalog.pg_backend_pid() AND o.locktype = 'virtualxid' AND o.granted) GROUP BY 1, 2 ORDER BY 1, 2",
			[]
		),
		(rows) => Arr.map(rows, (r) => `${String(r[0])} ${String(r[1])} ×${String(r[2])}`)
	)

/**
 * The footprint of forbidding `.z<key>`, on a fresh session with no planner setting, in one transaction rolled back:
 * the INSERT, its judge deferred, each judged statement over Forbidden's side of news explained while the delta holds
 * the row, then SET CONSTRAINTS ALL IMMEDIATE, which runs the judge, the forbidden suffix ending only a reference of
 * kind 0, and the SIRead locks the transaction holds.
 */
const footprintOf = (seat: Seat, key: number) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const session = yield* substrate.session({ ...ownerSession(), label: "rule suffix locality" })
		yield* standUpJudge(session, seat.installed.installation)
		const probeCost = yield* probeCostOf((sql) => session.values(sql, []))
		const probes = Arr.flatMap(judgedDeltaReadsOf(seat.installed.installation), (r) =>
			Arr.some([...r.deltas], Str.startsWith("__delta_news_forbidden_")) ? [r.statement] : []
		)
		assert.ok(probes.length > 0, "a judged statement reads Forbidden's side of news")
		yield* session.begin
		const footprint = yield* Effect.onError(
			Effect.gen(function* () {
				yield* session.query(
					`INSERT INTO ${seat.table("Forbidden")} (${seat.column("Forbidden", "suffix")}) VALUES ('.z${key}')`,
					[]
				)
				const rows: Array<number> = []
				for (const probe of probes) {
					const explained = yield* session.values(
						`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) ${plannedQueryOf(probe)}`,
						[]
					)
					const plan = succeeded(parsePlan(explained[0]?.[0]), "one EXPLAIN plan").plan
					assert.deepEqual(
						wideScans(plan, probeCost),
						[],
						"a probe of a forbidden suffix reads no table larger than a probe whole"
					)
					rows.push(keyedWork(plan, probeCost))
				}
				yield* session.query("SET CONSTRAINTS ALL IMMEDIATE", [])
				return { rows, locks: yield* siReadLocks(session) } satisfies Footprint
			}),
			() => Effect.ignore(session.rollback)
		)
		yield* session.rollback
		return footprint
	})

/** The footprint of forbidding key `key`'s suffix once keys `from` to `to` are loaded beside those the seat holds. */
export const footprintBeside = (seat: Seat, key: number, from: number, to: number) =>
	Effect.gen(function* () {
		yield* seat.session.query(referencesSql(seat, from, to), [])
		yield* seat.session.query(`ANALYZE ${seat.table("Ref")}`, [])
		return yield* footprintOf(seat, key)
	})

/**
 * The code points a suffix key's range turns on (test/unit/sql/suffix.fixtures.ts): the sentinel and the next one up,
 * ASCII, the dot, the edges of UTF-8's sequences, U+D7FF and U+E000 beside the surrogates, the first astral code point,
 * and U+10FFFE and U+10FFFF.
 */
const codePoints = [
	0x1, 0x2, 0x2e, 0x61, 0x62, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff, 0x10000, 0x10fffe,
	0x10ffff
] as const

const textGen =
	(max: number): Gen<string> =>
	(source) =>
		Arr.join(
			Arr.map(source.draw(array(element(codePoints), { min: 0, max })), (c) =>
				String.fromCodePoint(c)
			),
			""
		)

/** A seek case: references' targets, and suffixes each a target's tail or drawn apart. */
export interface Seek {
	readonly targets: ReadonlyArray<string>
	readonly suffixes: ReadonlyArray<string>
}

export const seekGen: Gen<Seek> = (s) => {
	const targets = s.draw(array(textGen(5), { min: 1, max: 12 }))
	const suffixes = s.draw(
		array(
			(source): string => {
				if (source.draw(boolean)) {
					const points = Array.from(
						defined(targets[source.draw(int(0, targets.length - 1))], "a target")
					)
					return Arr.join(points.slice(points.length - source.draw(int(0, points.length))), "")
				}
				return source.draw(textGen(3))
			},
			{ min: 1, max: 6 }
		)
	)
	return { targets, suffixes }
}

export type SeekFeature =
	| "a suffix some target ends with"
	| "a suffix no target ends with"
	| "an empty suffix"
	| "a suffix of U+10FFFF alone"
	| "an astral suffix"

/** A text as a SQL literal, its every code point spelled through chr, so no character stands raw in the statement. */
const textLiteral = (text: string): string =>
	text === ""
		? "''"
		: Arr.join(
				Arr.map(
					Array.from(text),
					(c) => `chr(${Option.getOrElse(Str.codePointAt(0)(c), () => 0)})`
				),
				" || "
			)

/**
 * The references a seek case stores beside its targets, each `k<i>q`, of letters no drawn suffix holds, so the table is
 * larger than one probe of it and PostgreSQL seeks a range of the key in it rather than read it whole, with no planner
 * setting: a table of a page or two it reads whole for what a probe costs.
 *
 * @limitKind derived
 * @owner the suffix seek property (rule-suffix.test.ts)
 * @unit references
 * @scope the background each seek case reads beside its targets
 * @evidence ~/.cache/grizzle/DECLSTATS-work/unitscale/run3.sh, its output unitscale3.log beside it (2026-11-23): a
 *   probe of a key at every table from 2^10 rows
 */
const seekBackground = 2048

/** The id of the first background reference, past every drawn target's. */
const backgroundId = 1000

/**
 * Over `seek`'s targets stored as references beside a background of others (`seekBackground`), each suffix's
 * references read two ways, by its suffix key's range (sql/suffix.ts suffixRange, printed as a judged read states it)
 * and by the suffix test, `right(target, char_length(suffix)) = suffix`, with no planner setting: the two find the same
 * ids, the host's endsWith's, and the range of every suffix but the empty one, whose range is every reference, is read
 * as an index condition of the B-tree on the key, by an index scan or a bitmap of one.
 */
export const runSeek = (seat: Seat, seek: Seek, note: (f: SeekFeature) => void) =>
	Effect.gen(function* () {
		const ref = seat.table("Ref")
		const id = seat.column("Ref", "id")
		const target = seat.column("Ref", "target")
		yield* seat.session.query(
			`INSERT INTO ${ref} (${id}, ${seat.column("Ref", "kind")}, ${target}) VALUES ${Arr.join(
				Arr.map(seek.targets, (t, i) => `(${i}, 0, ${textLiteral(t)})`),
				", "
			)}`,
			[]
		)
		yield* seat.session.query(
			`INSERT INTO ${ref} (${id}, ${seat.column("Ref", "kind")}, ${target}) SELECT ${backgroundId} + g, 0, 'k' || g || 'q' FROM generate_series(0, ${seekBackground - 1}) AS s(g)`,
			[]
		)
		const ids = (where: string, suffix: string) =>
			Effect.map(
				seat.session.values(`SELECT ${id} FROM ${ref} WHERE ${where} ORDER BY 1`, [suffix]),
				(rows) => Arr.map(rows, (r) => Number(r[0]))
			)
		/** The range of the suffix `$1`, as a judged read states it. */
		const range = printExpr(
			suffixRange(
				tableCol(seat.installed.installation.names.column("Ref", "target")),
				param(1, types.text)
			)
		)
		for (const suffix of seek.suffixes) {
			const at = `${Formatter.format(seek)}, the suffix ${Formatter.format(suffix)}`
			const host = [
				...Arr.flatMap(seek.targets, (t, i): ReadonlyArray<number> =>
					Str.endsWith(suffix)(t) ? [i] : []
				),
				...(suffix === "" ? Arr.makeBy(seekBackground, (g) => backgroundId + g) : [])
			]
			const bySeek = yield* ids(range, suffix)
			const byTest = yield* ids(
				`pg_catalog.right(${target}, pg_catalog.char_length($1::text)) = $1::text`,
				suffix
			)
			assert.deepEqual(bySeek, host, `${at}: the range finds the references that end with it`)
			assert.deepEqual(byTest, host, `${at}: the suffix test finds them too`)
			const plan = yield* planAsRun(
				seat.session.values,
				`SELECT ${id} FROM ${ref} WHERE ${range}`,
				[suffix]
			)
			const scans = Arr.filter(Arr.fromIterable(planNodes(plan)), (n) => Option.isSome(n.relation))
			assert.ok(
				suffix === "" ||
					(Arr.isReadonlyArrayNonEmpty(scans) &&
						Arr.every(
							scans,
							(n) =>
								(n.nodeType === "Index Scan" && Option.isSome(n.indexCond)) ||
								(n.nodeType === "Bitmap Heap Scan" &&
									Arr.every(
										n.children,
										(c) => c.nodeType === "Bitmap Index Scan" && Option.isSome(c.indexCond)
									))
						)),
				`${at}: the range seeks the B-tree on the suffix key, ${Formatter.format(Arr.map(scans, (n) => n.nodeType))}`
			)
			note(host.length > 0 ? "a suffix some target ends with" : "a suffix no target ends with")
			const points = Array.from(suffix)
			if (points.length === 0) {
				note("an empty suffix")
			} else if (Arr.every(points, (p) => p === "\u{10ffff}")) {
				note("a suffix of U+10FFFF alone")
			}
			if (Arr.some(points, (p) => Option.getOrElse(Str.codePointAt(0)(p), () => 0) > 0xffff)) {
				note("an astral suffix")
			}
		}
	})
