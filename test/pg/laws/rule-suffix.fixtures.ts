/**
 * What the properties of rule-suffix.test.ts read: a rule whose probe seeks a suffix it holds fixed, its schema and
 * template, its cases, and each case's run.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { explainServerStatement, planNodes } from "#bench/harness/explain.ts"
import { Logic, Text } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, derived, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { param, tableCol, types } from "#compiler/sql/build.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { suffixRange } from "#compiler/sql/suffix.ts"
import { type Seat, type SeatTemplate, seatTemplate } from "#test/pg/fin/installed.ts"
import { lawsHold, routineScopes } from "#test/support/advice.ts"
import { judgedDeltaReadsOf, judgedPlans, scannedWork, standUpJudge } from "#test/support/judge.ts"
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

/** 250 to 400 keys, then 600 to 900 more, so the references fill more heap and index pages each time. */
export const localityGen: Gen<Locality> = (s) => {
	const before = s.draw(int(250, 400))
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
 * The footprint of forbidding `.z<key>`, on a fresh session, in one transaction rolled back: the INSERT, its judge
 * deferred, each judged statement over Forbidden's side of news explained while the delta holds the row, under its
 * routine's advice (judge.ts judgedPlans), then SET CONSTRAINTS ALL IMMEDIATE, which runs the judge, the forbidden
 * suffix ending only a reference of kind 0, and the SIRead locks the transaction holds.
 */
const footprintOf = (seat: Seat, key: number) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const session = yield* substrate.session({ ...ownerSession(), label: "rule suffix locality" })
		yield* standUpJudge(session, seat.installed.installation)
		const reads = Arr.filter(judgedDeltaReadsOf(seat.installed.installation), (r) =>
			Arr.some([...r.deltas], Str.startsWith("__delta_news_forbidden_"))
		)
		assert.ok(reads.length > 0, "a judged statement reads Forbidden's side of news")
		const probes = Arr.map(reads, (r) => r.statement)
		/** The routines the probes are judged in, whose plans the laws hold over (Law 2: the range an index condition). */
		const routines = new Set(Arr.map(reads, (r) => `${r.routine.schema}.${r.routine.name}`))
		const scopes = Arr.filter(
			routineScopes(seat.installed.installation),
			(scope) =>
				scope.vehicle.kind === "routine" &&
				routines.has(`${scope.vehicle.routine.schema}.${scope.vehicle.routine.name}`)
		)
		yield* session.begin
		const footprint = yield* Effect.onError(
			Effect.gen(function* () {
				yield* session.query(
					`INSERT INTO ${seat.table("Forbidden")} (${seat.column("Forbidden", "suffix")}) VALUES ('.z${key}')`,
					[]
				)
				const plans = yield* judgedPlans(
					(sql) => session.values(sql, []),
					seat.installed.installation,
					probes
				)
				const rows = Arr.map(plans, ({ plan }) => scannedWork(plan))
				for (const scope of scopes) {
					yield* lawsHold(session, scope)
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
 * The references a seek case stores beside its targets, each `k<i>q`, of letters no drawn suffix holds: more than one
 * leaf of the B-tree on the suffix key, so a range read by its index condition seeks its own leaves among others, and
 * every range but the empty suffix's leaves them out.
 *
 * @limitKind derived
 * @owner PostgreSQL 19's B-tree leaf layout (nbtree.h, bufpage.h)
 * @unit references
 * @scope the background each seek case reads beside its targets
 * @derivation A suffix key entry of `k<i>q` is an 8-byte index tuple header and a short varlena of at most 7 bytes,
 *   MAXALIGNed to 16, and a 4-byte line pointer, 20 bytes, so a leaf's 8,192 bytes less its 24-byte header and 16-byte
 *   special space hold at most 407 entries: 2,048 fill five leaves or more beneath a root.
 */
const seekBackground = 2048

/** The id of the first background reference, past every drawn target's. */
const backgroundId = 1000

/**
 * Over `seek`'s targets stored as references beside a background of others (`seekBackground`), each suffix's
 * references read two ways, by its suffix key's range (sql/suffix.ts suffixRange, printed as a judged read states it)
 * and by the suffix test, `right(target, char_length(suffix)) = suffix`: the two find the same ids, the host's
 * endsWith's; and the range of every suffix, planned under the advice that reads Ref by its suffix key's B-tree, as a
 * judged read's carries, is that scan's index condition, never its filter (the plan laws' Law 2,
 * test/support/advice.ts), at every code point the range turns on.
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
		/** The B-tree on Ref's suffix key, schema-qualified, as advice names an index: Ref's one expression index. */
		const expressionIndexes = yield* seat.session.values(
			"SELECT pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(c.relname) FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class AS c ON c.oid = i.indexrelid JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace WHERE i.indrelid = $1::regclass AND i.indexprs IS NOT NULL",
			[ref]
		)
		const [suffixIndex, ...others] = Arr.map(expressionIndexes, (row) => String(row[0]))
		assert.ok(
			suffixIndex !== undefined && others.length === 0,
			"Ref has one expression index, its suffix key's"
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
			yield* seat.session.begin
			const plan = yield* Effect.ensuring(
				Effect.andThen(
					seat.session.query(
						"SELECT pg_catalog.set_config('pg_plan_advice.advice', $1::text, true)",
						[`INDEX_SCAN(r1 ${suffixIndex})`]
					),
					explainServerStatement(
						seat.session,
						`SELECT ${id} FROM ${ref} AS r1 WHERE ${range}`,
						[suffix],
						"generic",
						{ serialize: { kind: "off" }, wal: false, verbose: false }
					)
				),
				Effect.ignore(seat.session.rollback)
			)
			const scans = Arr.filter(Arr.fromIterable(planNodes(plan.plan)), (n) =>
				Option.isSome(n.relation)
			)
			assert.ok(
				Arr.isReadonlyArrayNonEmpty(scans) &&
					Arr.every(
						scans,
						(n) =>
							n.nodeType === "Index Scan" && Option.isSome(n.indexCond) && Option.isNone(n.filter)
					),
				`${at}: the range is the index condition of a scan of the B-tree on the suffix key, ${Formatter.format(Arr.map(scans, (n) => [n.nodeType, n.indexCond, n.filter]))}`
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
