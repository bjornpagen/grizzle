/**
 * Coverage's lowering (fin.md §7, "Tested on 19rc1, not assumed") against PostgreSQL 19rc1: a span target keyed
 * `UNIQUE (k, r WITHOUT OVERLAPS)` and a source whose `FOREIGN KEY (k, PERIOD r)` requires the union of its key's
 * target spans to cover each of its own, both spans STORED generated columns `CASE WHEN φ THEN int4range(lo, hi) END`,
 * so a row outside φ projects NULL.
 *
 * Oracle: a model of interval-union coverage on the host, the specification turned into a checker. Spans are half-open
 * integer intervals. The target key refuses a non-NULL empty span and two non-NULL spans of one key that overlap, at the
 * row whose insert meets it; a NULL span is never compared. A source row is covered when its span is NULL, or non-empty
 * and inside the union of its key's non-NULL target spans. PostgreSQL must commit exactly what the model commits, and
 * refuse the rest with the SQLSTATE the model names at the moment the FK's deferral puts it.
 *
 * The box (doctrine rule 9): keys 0 and 1, points 0 to 3, so a span is one of the six non-empty intervals over them,
 * the empty one, or NULL; at most three target rows; one source row, since PostgreSQL checks each source row alone.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, Option } from "effect"
import { indices } from "#compiler/core/array.ts"
import { quoteIdent, quoteString } from "#compiler/sql/print.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import type { Moment } from "#test/support/families/mutate.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	type Attempted,
	attempt,
	momentText,
	qualified,
	refusalText,
	sameMoment,
	tuple
} from "#test/support/substrate.ts"
import { expectSqlstate } from "#test/support/substrate/expect.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** PostgreSQL's disagreement with the coverage model, with both sides spelt out. */
class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** A row's span: an interval [lo, hi) of the box's points, empty where lo = hi, or NULL outside φ. */
type Span =
	| { readonly kind: "null" }
	| { readonly kind: "span"; readonly lo: number; readonly hi: number }

/** The box's points. */
const points = [0, 1, 2, 3] as const

/** Every non-empty interval over the box's points. */
const INTERVALS: Arr.NonEmptyReadonlyArray<Span> = nonEmpty(
	Arr.flatMap(points, (lo) =>
		Arr.map(
			Arr.filter(points, (hi) => hi > lo),
			(hi): Span => ({ kind: "span", lo, hi })
		)
	)
)

/** Every span a row of the box may hold: the intervals, an empty one, and NULL. */
const SPANS: Arr.NonEmptyReadonlyArray<Span> = [
	...INTERVALS,
	{ kind: "span", lo: 1, hi: 1 },
	{ kind: "null" }
]

const isEmpty = (s: Span): boolean => s.kind === "span" && s.lo === s.hi

const overlaps = (a: Span, b: Span): boolean =>
	a.kind === "span" && b.kind === "span" && a.lo < b.hi && b.lo < a.hi && !isEmpty(a) && !isEmpty(b)

/** A row of either table: its key and its span. */
interface Row {
	readonly k: number
	readonly span: Span
}

/** Whether a source row is covered by the target rows: NULL, or non-empty and inside its key's union. */
const covered = (targets: ReadonlyArray<Row>, source: Row): boolean => {
	if (source.span.kind === "null") {
		return true
	}
	const { lo, hi } = source.span
	return (
		lo < hi &&
		Arr.every(
			Arr.filter(indices(hi), (p) => p >= lo),
			(p) =>
				Arr.some(
					targets,
					(t) => t.k === source.k && t.span.kind === "span" && t.span.lo <= p && p < t.span.hi
				)
		)
	)
}

/**
 * What the target key does with rows inserted in order: the first row whose span is empty (23514, which PostgreSQL
 * raises with no constraint named: executor/execIndexing.c), or that overlaps an earlier row of its key (23P01, the
 * key's exclusion), or none.
 */
const keyRefusal = (rows: ReadonlyArray<Row>): Option.Option<"23514" | "23P01"> => {
	for (const [i, row] of rows.entries()) {
		if (row.span.kind === "span" && isEmpty(row.span)) {
			return Option.some("23514")
		}
		if (
			Arr.some(
				rows.slice(0, i),
				(earlier) => earlier.k === row.k && overlaps(earlier.span, row.span)
			)
		) {
			return Option.some("23P01")
		}
	}
	return Option.none()
}

/** The column values of a row, `(id, k, lo, hi, φ)`, a NULL span stored as φ false over a placeholder interval. */
const valuesOf = (id: number, row: Row): string =>
	row.span.kind === "null"
		? tuple([id, row.k, 0, 1, "false"])
		: tuple([id, row.k, row.span.lo, row.span.hi, "true"])

const insertSql = (table: string, rows: ReadonlyArray<Row>, from: number): string =>
	`INSERT INTO ${table} (id, k, lo, hi, phi) VALUES ${Arr.join(
		Arr.map(rows, (row, i) => valuesOf(from + i, row)),
		", "
	)}`

/** The span columns both tables share, the span generated from them. */
const spanColumns =
	"id int4 PRIMARY KEY, k int4 NOT NULL, lo int4 NOT NULL, hi int4 NOT NULL, phi boolean NOT NULL, r int4range GENERATED ALWAYS AS (CASE WHEN phi THEN int4range(lo, hi) END) STORED"

/** The coverage lowering in a schema: btree_gist in it for the scalar key column, the target, and the covered source. */
const coverageDdl = (schema: string, deferral: "immediate" | "deferred"): ReadonlyArray<string> => [
	`CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA ${quoteIdent(schema)}`,
	`CREATE TABLE ${qualified(schema, "target")} (${spanColumns}, CONSTRAINT target_span UNIQUE NULLS DISTINCT (k, r WITHOUT OVERLAPS))`,
	`CREATE TABLE ${qualified(schema, "source")} (${spanColumns}, CONSTRAINT source_covered FOREIGN KEY (k, PERIOD r) REFERENCES ${qualified(schema, "target")} (k, PERIOD r) MATCH SIMPLE ${deferral === "deferred" ? "DEFERRABLE INITIALLY DEFERRED" : "NOT DEFERRABLE"})`
]

/** A coverage lowering installed in a schema of its own, with its session. */
interface Seat {
	readonly deferral: "immediate" | "deferred"
	readonly schema: string
	readonly session: RawSession
}

const seatOf = (deferral: "immediate" | "deferred") =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const schema = yield* s.schema(freshSchema)
		for (const statement of coverageDdl(schema, deferral)) {
			yield* s.admin.query(statement, [])
		}
		const session = yield* s.session({ ...ownerSession(), label: deferral })
		return { deferral, schema, session } satisfies Seat
	})

const clear = (seat: Seat) =>
	seat.session.query(
		`TRUNCATE ${qualified(seat.schema, "source")}, ${qualified(seat.schema, "target")}`,
		[]
	)

/** What the model says of a transaction: it commits, or is refused at a moment with a SQLSTATE. */
type Verdict =
	| { readonly kind: "committed" }
	| { readonly kind: "refused"; readonly moment: Moment; readonly code: string }

const verdictText = (v: Verdict): string =>
	v.kind === "committed" ? "commit" : `refusal ${momentText(v.moment)} with ${v.code}`

/**
 * Judges PostgreSQL's transaction against the model's verdict: the same verdict, the same moment and SQLSTATE, the
 * coverage FK named on a 23503 and the key on a 23P01, and on a 23514 of an empty span no constraint named, as
 * executor/execIndexing.c raises it.
 */
const judge = (real: Attempted, model: Verdict, what: string): Effect.Effect<void, Disagreed> => {
	const disagree = (why: string) =>
		Effect.fail(
			new Disagreed({
				message: `${why}: the model predicts ${verdictText(model)}, PostgreSQL gave ${real.kind === "committed" ? "commit" : `refusal ${momentText(real.moment)}: ${refusalText(real.fields)}`}, for ${what}`
			})
		)
	if (real.kind === "committed" || model.kind === "committed") {
		return real.kind === model.kind ? Effect.void : disagree("the verdicts differ")
	}
	if (!sameMoment(real.moment, model.moment) || real.fields.code !== model.code) {
		return disagree("the moment or the SQLSTATE differs")
	}
	const named = real.fields.constraint
	const expected =
		model.code === "23503" ? "source_covered" : model.code === "23P01" ? "target_span" : undefined
	return named === expected ? Effect.void : disagree(`PostgreSQL names ${named ?? "no constraint"}`)
}

/** A sequence of target rows of the box: at most three, in the order one insert sends them. */
interface KeyCase {
	readonly rows: ReadonlyArray<Row>
}

const ROW_KINDS: Arr.NonEmptyReadonlyArray<Row> = nonEmpty(
	Arr.flatMap([0, 1], (k) => Arr.map(SPANS, (span): Row => ({ k, span })))
)

const keyGen: Gen<KeyCase> = (source) => ({
	rows: Arr.map(indices(source.draw(int(0, 3))), () => source.draw(element(ROW_KINDS)))
})

type KeyFeature =
	| "refused by an overlap"
	| "refused by an empty span"
	| "two NULL spans of one key admitted"
	| "adjacent spans of one key admitted"
	| "overlapping spans of two keys admitted"

/** The one set of disjoint intervals before any interval is offered: the empty set. */
const nothingDisjoint: ReadonlyArray<ReadonlyArray<Span>> = [[]]

/** Every set of pairwise disjoint intervals over the box's points: the target spans of one key in a valid state. */
const DISJOINT: Arr.NonEmptyReadonlyArray<ReadonlyArray<Span>> = nonEmpty(
	Arr.reduce(INTERVALS, nothingDisjoint, (sets, interval) => [
		...sets,
		...Arr.flatMap(sets, (set): ReadonlyArray<ReadonlyArray<Span>> =>
			Arr.every(set, (s) => !overlaps(s, interval)) ? [[...set, interval]] : []
		)
	])
)

/** A valid target state, a source row, and whether a NULL target row sits beside the spans. */
interface CoverCase {
	readonly zero: ReadonlyArray<Span>
	readonly one: ReadonlyArray<Span>
	readonly nullTarget: boolean
	readonly source: Row
}

const coverGen: Gen<CoverCase> = (source) => ({
	zero: source.draw(element(DISJOINT)),
	one: source.draw(element(DISJOINT)),
	nullTarget: source.draw(element([false, true] as const)),
	source: source.draw(element(ROW_KINDS))
})

const targetsOf = (c: {
	readonly zero: ReadonlyArray<Span>
	readonly one: ReadonlyArray<Span>
	readonly nullTarget: boolean
}): ReadonlyArray<Row> => [
	...Arr.map(c.zero, (span): Row => ({ k: 0, span })),
	...Arr.map(c.one, (span): Row => ({ k: 1, span })),
	...(c.nullTarget ? [{ k: 0, span: { kind: "null" } } satisfies Row] : [])
]

type CoverFeature =
	| `${"immediate" | "deferred"} covered by one span`
	| `${"immediate" | "deferred"} covered by a union of spans`
	| `${"immediate" | "deferred"} refused across a gap`
	| `${"immediate" | "deferred"} refused an empty source span`
	| `${"immediate" | "deferred"} skipped a NULL source span`
	| "deferred committed a source sent before its targets"

/** A single change of one target row of a valid, covering state: deleted, given another span, or φ turned off. */
type TargetChange =
	| { readonly kind: "delete"; readonly at: number }
	| { readonly kind: "respan"; readonly at: number; readonly span: Span }

interface ChangeCase {
	readonly targets: ReadonlyArray<Span>
	readonly source: Span
	readonly change: TargetChange
}

/** The valid states the change proof starts from: one key's disjoint spans, and a source span they cover. */
const COVERING: Arr.NonEmptyReadonlyArray<readonly [ReadonlyArray<Span>, Span]> = nonEmpty(
	Arr.flatMap(DISJOINT, (set) =>
		Arr.flatMap(INTERVALS, (span): ReadonlyArray<readonly [ReadonlyArray<Span>, Span]> =>
			covered(
				Arr.map(set, (s): Row => ({ k: 0, span: s })),
				{ k: 0, span }
			)
				? [[set, span]]
				: []
		)
	)
)

const changesOf = (targets: ReadonlyArray<Span>): Arr.NonEmptyReadonlyArray<TargetChange> =>
	nonEmpty(
		Arr.flatMap(indices(targets.length), (at): ReadonlyArray<TargetChange> => [
			{ kind: "delete", at },
			...Arr.map(SPANS, (span): TargetChange => ({ kind: "respan", at, span }))
		])
	)

const changeGen: Gen<ChangeCase> = (source) => {
	const [targets, span] = source.draw(element(COVERING))
	return { targets, source: span, change: source.draw(element(changesOf(targets))) }
}

type ChangeFeature =
	| `${"immediate" | "deferred"} ${"delete" | "respan"} ${"committed" | "refused 23503" | "refused 23514" | "refused 23P01"}`
	| "a shrink that keeps the source covered committed"

/** A change's verdict as a feature. */
const changeFeature = (
	deferral: "immediate" | "deferred",
	kind: TargetChange["kind"],
	model: Verdict
): ChangeFeature => {
	if (model.kind === "committed") {
		return `${deferral} ${kind} committed`
	}
	switch (model.code) {
		case "23503":
			return `${deferral} ${kind} refused 23503`
		case "23514":
			return `${deferral} ${kind} refused 23514`
		default:
			return `${deferral} ${kind} refused 23P01`
	}
}

/** Whether a change narrows a target span that overlapped the source to a smaller span inside it. */
const shrinks = (c: ChangeCase): boolean => {
	if (c.change.kind !== "respan" || c.change.span.kind !== "span") {
		return false
	}
	const next = c.change.span
	return Option.match(Arr.get(c.targets, c.change.at), {
		onNone: () => false,
		onSome: (old) =>
			old.kind === "span" &&
			old.lo <= next.lo &&
			next.hi <= old.hi &&
			next.hi - next.lo < old.hi - old.lo &&
			next.lo < next.hi &&
			overlaps(old, c.source)
	})
}

layer(Substrate.layer)("coverage's temporal lowering of fin.md §7 on PostgreSQL 19rc1", (it) => {
	it.effect(
		"need btree_gist for the scalar key column of a WITHOUT OVERLAPS key, and take the key and the PERIOD foreign key over STORED generated spans",
		() =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const schema = yield* s.schema(freshSchema)
				const installed = yield* s.admin.queryValues(
					"SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'btree_gist'",
					[]
				)
				assert.deepEqual(installed, [], "the shared database starts without btree_gist")
				const target = `CREATE TABLE ${qualified(schema, "target")} (${spanColumns}, CONSTRAINT target_span UNIQUE NULLS DISTINCT (k, r WITHOUT OVERLAPS))`
				yield* expectSqlstate(s.admin.query(target, []), "42704")
				for (const statement of coverageDdl(schema, "immediate")) {
					yield* s.admin.query(statement, [])
				}
				const generated = yield* s.admin.queryValues(
					`SELECT a.attrelid::regclass::text, a.attgenerated::text FROM pg_catalog.pg_attribute AS a WHERE a.attrelid IN (${quoteString(qualified(schema, "target"))}::regclass, ${quoteString(qualified(schema, "source"))}::regclass) AND a.attname = 'r' ORDER BY 1`,
					[]
				)
				assert.deepEqual(
					Arr.map(generated, ([, kind]) => String(kind)),
					["s", "s"],
					"both spans are STORED generated columns"
				)
			})
	)

	it.effect(
		"take only NO ACTION for a PERIOD foreign key's update and delete actions, deferrable or not, and refuse RESTRICT, CASCADE, SET NULL and SET DEFAULT with 0A000",
		() =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const schema = yield* s.schema(freshSchema)
				for (const statement of Arr.take(coverageDdl(schema, "immediate"), 2)) {
					yield* s.admin.query(statement, [])
				}
				const actions = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"] as const
				const deferrals = [
					"NOT DEFERRABLE",
					"DEFERRABLE INITIALLY IMMEDIATE",
					"DEFERRABLE INITIALLY DEFERRED"
				] as const
				for (const [event, action, deferral] of Arr.flatMap(
					["UPDATE", "DELETE"] as const,
					(event) =>
						Arr.flatMap(actions, (action) =>
							Arr.map(deferrals, (deferral) => [event, action, deferral] as const)
						)
				)) {
					const sql = `CREATE TABLE ${qualified(schema, "referencing")} (k int4, r int4range, FOREIGN KEY (k, PERIOD r) REFERENCES ${qualified(schema, "target")} (k, PERIOD r) ON ${event} ${action} ${deferral})`
					if (action === "NO ACTION") {
						yield* s.admin.query(sql, [])
						yield* s.admin.query(`DROP TABLE ${qualified(schema, "referencing")}`, [])
					} else {
						yield* expectSqlstate(s.admin.query(sql, []), "0A000")
					}
				}
			})
	)

	it.effect(
		"refuse in a WITHOUT OVERLAPS key exactly the rows that overlap an earlier row of their key or hold an empty span, never comparing a NULL span",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const seat = yield* seatOf("immediate")
					const target = qualified(seat.schema, "target")
					return yield* exhaust(
						{
							suite: "substrate/temporal-key",
							generator: keyGen,
							literal: Formatter.format,
							limit: Arr.reduce([0, 1, 2, 3], 0, (n, size) => n + ROW_KINDS.length ** size),
							coverage: requiredInSpace<KeyFeature>([
								"refused by an overlap",
								"refused by an empty span",
								"two NULL spans of one key admitted",
								"adjacent spans of one key admitted",
								"overlapping spans of two keys admitted"
							]),
							caseHang
						},
						(c, k) =>
							Effect.gen(function* () {
								const real = yield* attempt(
									seat.session,
									Arr.isReadonlyArrayNonEmpty(c.rows) ? [insertSql(target, c.rows, 0)] : []
								)
								yield* seat.session.resetStatements
								const model: Verdict = Option.match(keyRefusal(c.rows), {
									onNone: (): Verdict => ({ kind: "committed" }),
									onSome: (code): Verdict => ({
										kind: "refused",
										moment: { kind: "statement", index: 0 },
										code
									})
								})
								yield* judge(real, model, Formatter.format(c))
								if (real.kind === "committed") {
									const pairs = Arr.flatMap(c.rows, (a, i) =>
										Arr.map(c.rows.slice(i + 1), (b) => [a, b] as const)
									)
									if (
										Arr.some(
											pairs,
											([a, b]) => a.k === b.k && a.span.kind === "null" && b.span.kind === "null"
										)
									) {
										k.note("two NULL spans of one key admitted")
									}
									if (
										Arr.some(
											pairs,
											([a, b]) =>
												a.k === b.k &&
												a.span.kind === "span" &&
												b.span.kind === "span" &&
												(a.span.hi === b.span.lo || b.span.hi === a.span.lo)
										)
									) {
										k.note("adjacent spans of one key admitted")
									}
									if (Arr.some(pairs, ([a, b]) => a.k !== b.k && overlaps(a.span, b.span))) {
										k.note("overlapping spans of two keys admitted")
									}
									yield* clear(seat)
								} else if (model.kind === "refused") {
									k.note(
										model.code === "23514" ? "refused by an empty span" : "refused by an overlap"
									)
								}
							})
					)
				})
			)
	)

	it.effect(
		"admit a source span exactly when its key's target spans cover it, immediately or at commit, refusing an empty span and skipping a NULL one",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const seats = [yield* seatOf("immediate"), yield* seatOf("deferred")]
					return yield* exhaust(
						{
							suite: "substrate/temporal-cover",
							generator: coverGen,
							literal: Formatter.format,
							limit: DISJOINT.length * DISJOINT.length * 2 * ROW_KINDS.length,
							coverage: requiredInSpace<CoverFeature>([
								"deferred committed a source sent before its targets",
								...Arr.flatMap(
									["immediate", "deferred"] as const,
									(d): ReadonlyArray<CoverFeature> => [
										`${d} covered by one span`,
										`${d} covered by a union of spans`,
										`${d} refused across a gap`,
										`${d} refused an empty source span`,
										`${d} skipped a NULL source span`
									]
								)
							]),
							caseHang
						},
						(c, k) =>
							Effect.forEach(
								seats,
								(seat) =>
									Effect.gen(function* () {
										const targets = targetsOf(c)
										const targetInsert = Arr.isReadonlyArrayNonEmpty(targets)
											? [insertSql(qualified(seat.schema, "target"), targets, 0)]
											: []
										const sourceInsert = insertSql(qualified(seat.schema, "source"), [c.source], 0)
										/** The deferred FK is sent its source first, as a cascade-fed target's rows arrive after it. */
										const statements =
											seat.deferral === "deferred"
												? [sourceInsert, ...targetInsert]
												: [...targetInsert, sourceInsert]
										const real = yield* attempt(seat.session, statements)
										yield* seat.session.resetStatements
										const ok = covered(targets, c.source)
										const model: Verdict = ok
											? { kind: "committed" }
											: {
													kind: "refused",
													moment:
														seat.deferral === "deferred"
															? { kind: "commit" }
															: { kind: "statement", index: targetInsert.length },
													code: "23503"
												}
										yield* judge(real, model, `${seat.deferral}: ${Formatter.format(c)}`)
										const d = seat.deferral
										if (c.source.span.kind === "null") {
											k.note(`${d} skipped a NULL source span`)
										} else if (isEmpty(c.source.span)) {
											k.note(`${d} refused an empty source span`)
										} else if (!ok) {
											k.note(`${d} refused across a gap`)
										} else {
											const { lo, hi } = c.source.span
											const one = Arr.some(
												targets,
												(t) =>
													t.k === c.source.k &&
													t.span.kind === "span" &&
													t.span.lo <= lo &&
													hi <= t.span.hi
											)
											k.note(one ? `${d} covered by one span` : `${d} covered by a union of spans`)
											if (d === "deferred") {
												k.note("deferred committed a source sent before its targets")
											}
										}
										if (real.kind === "committed") {
											yield* clear(seat)
										}
									}),
								{ concurrency: "unbounded", discard: true }
							)
					)
				})
			)
	)

	it.effect(
		"commit a change of a referenced target row exactly when the source stays covered and the key stays free of overlaps and empty spans",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const seats = [yield* seatOf("immediate"), yield* seatOf("deferred")]
					return yield* exhaust(
						{
							suite: "substrate/temporal-change",
							generator: changeGen,
							literal: Formatter.format,
							limit: Arr.reduce(COVERING, 0, (n, [targets]) => n + changesOf(targets).length),
							coverage: requiredInSpace<ChangeFeature>([
								"immediate delete committed",
								"immediate delete refused 23503",
								"immediate respan committed",
								"immediate respan refused 23503",
								"immediate respan refused 23514",
								"immediate respan refused 23P01",
								"deferred delete refused 23503",
								"deferred respan refused 23503",
								"a shrink that keeps the source covered committed"
							]),
							caseHang
						},
						(c, k) =>
							Effect.forEach(
								seats,
								(seat) =>
									Effect.gen(function* () {
										const target = qualified(seat.schema, "target")
										const rows = Arr.map(c.targets, (span): Row => ({ k: 0, span }))
										const setup = yield* attempt(seat.session, [
											insertSql(target, rows, 0),
											insertSql(qualified(seat.schema, "source"), [{ k: 0, span: c.source }], 0)
										])
										assert.equal(setup.kind, "committed", "a covering state is admitted")
										const change = c.change
										const after: ReadonlyArray<Row> =
											change.kind === "delete"
												? Arr.filter(rows, (_, i) => i !== change.at)
												: Arr.map(rows, (row, i) =>
														i === change.at ? { k: 0, span: change.span } : row
													)
										const changed =
											change.kind === "delete"
												? `DELETE FROM ${target} WHERE id = ${change.at}`
												: change.span.kind === "null"
													? `UPDATE ${target} SET phi = false WHERE id = ${change.at}`
													: `UPDATE ${target} SET lo = ${change.span.lo}, hi = ${change.span.hi}, phi = true WHERE id = ${change.at}`
										const real = yield* attempt(seat.session, [changed])
										yield* seat.session.resetStatements
										/** The changed row is checked against the others first, then the source against what is left. */
										const keyCode =
											change.kind === "respan"
												? keyRefusal([
														...Arr.filter(rows, (_, i) => i !== change.at),
														{ k: 0, span: change.span }
													])
												: Option.none()
										const model: Verdict = Option.isSome(keyCode)
											? {
													kind: "refused",
													moment: { kind: "statement", index: 0 },
													code: keyCode.value
												}
											: covered(after, { k: 0, span: c.source })
												? { kind: "committed" }
												: {
														kind: "refused",
														moment:
															seat.deferral === "deferred"
																? { kind: "commit" }
																: { kind: "statement", index: 0 },
														code: "23503"
													}
										yield* judge(real, model, `${seat.deferral}: ${Formatter.format(c)}`)
										k.note(changeFeature(seat.deferral, c.change.kind, model))
										if (model.kind === "committed" && shrinks(c)) {
											k.note("a shrink that keeps the source covered committed")
										}
										yield* clear(seat)
									}),
								{ concurrency: "unbounded", discard: true }
							)
					)
				})
			)
	)
})
