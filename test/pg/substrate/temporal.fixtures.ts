/** What the properties of temporal.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Data, Effect, Option, type Scope } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import {
	covered,
	INTERVALS,
	overlaps,
	type Row,
	type Span,
	SPANS
} from "#test/pg/substrate/temporal.ts"
import type { Moment } from "#test/support/families/mutate.ts"
import type { SqlError } from "#test/support/pg.ts"
import {
	type Attempted,
	momentText,
	qualified,
	refusalText,
	sameMoment,
	tuple
} from "#test/support/substrate.ts"
import { fixtureGroup, type ResetGroup } from "#test/support/substrate/replace.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import {
	installTemplate,
	ownerSession,
	Substrate,
	type SubstrateCase
} from "#test/support/substrate/substrate.ts"

/** PostgreSQL's disagreement with the coverage model, with both sides spelt out. */
class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** The column values of a row, `(id, k, lo, hi, φ)`, a NULL span stored as φ false over a placeholder interval. */
const valuesOf = (id: number, row: Row): string =>
	row.span.kind === "null"
		? tuple([id, row.k, 0, 1, "false"])
		: tuple([id, row.k, row.span.lo, row.span.hi, "true"])

export const insertSql = (table: string, rows: ReadonlyArray<Row>, from: number): string =>
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

/** A coverage lowering installed in a schema of its own, with every table of it and its session. */
interface Seat {
	readonly deferral: Deferral
	readonly schema: string
	readonly tables: ResetGroup
	readonly session: RawSession
}

type Deferral = "immediate" | "deferred"

/**
 * A deferral's coverage lowering as a template (substrate.ts installTemplate): its schema and its DDL made once per
 * member, where each case made a pool of seats of it; each case's seat its schema in the worker's clone, every table of
 * it emptied after the case (Substrate.seat).
 */
const coverageTemplate = (deferral: Deferral) =>
	installTemplate({
		declaredIn: import.meta,
		name: `temporal ${deferral}`,
		content: { deferral },
		plan: (names) => Effect.succeed(names.schema),
		install: () =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const schema = yield* s.schema({ create: true, label: "install" })
				for (const statement of coverageDdl(schema, deferral)) {
					yield* s.admin.query(statement, [])
				}
			}),
		bind: (schema) => ({
			deferral,
			schema,
			tables: fixtureGroup([qualified(schema, "target"), qualified(schema, "source")])
		}),
		reset: (lowering) => lowering.tables
	})

/** Each deferral's coverage lowering, built once per member (coverageTemplate). */
export const coverageTemplates = {
	immediate: coverageTemplate("immediate"),
	deferred: coverageTemplate("deferred")
} as const

/** The seat of a case over a clone of a deferral's template (coverageTemplates): its lowering and an owner session. */
export const seatIn = (
	taken: SubstrateCase<Omit<Seat, "session">>
): Effect.Effect<Seat, SqlError, Scope.Scope> =>
	Effect.map(
		taken.substrate.session({ ...ownerSession(), label: taken.value.deferral }),
		(session) => ({ ...taken.value, session })
	)

/** What the model says of a transaction: it commits, or is refused at a moment with a SQLSTATE. */
export type Verdict =
	| { readonly kind: "committed" }
	| { readonly kind: "refused"; readonly moment: Moment; readonly code: string }

const verdictText = (v: Verdict): string =>
	v.kind === "committed" ? "commit" : `refusal ${momentText(v.moment)} with ${v.code}`

/**
 * Judges PostgreSQL's transaction against the model's verdict: the same verdict, the same moment and SQLSTATE, the
 * coverage FK named on a 23503 and the key on a 23P01, and on a 23514 of an empty span no constraint named, as
 * executor/execIndexing.c raises it.
 */
export const judge = (
	real: Attempted,
	model: Verdict,
	what: string
): Effect.Effect<void, Disagreed> => {
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

export const keyGen: Gen<KeyCase> = (source) => ({
	rows: Arr.map(indices(source.draw(int(0, 3))), () => source.draw(element(ROW_KINDS)))
})

export type KeyFeature =
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

export const coverGen: Gen<CoverCase> = (source) => ({
	zero: source.draw(element(DISJOINT)),
	one: source.draw(element(DISJOINT)),
	nullTarget: source.draw(element([false, true] as const)),
	source: source.draw(element(ROW_KINDS))
})

export const targetsOf = (c: {
	readonly zero: ReadonlyArray<Span>
	readonly one: ReadonlyArray<Span>
	readonly nullTarget: boolean
}): ReadonlyArray<Row> => [
	...Arr.map(c.zero, (span): Row => ({ k: 0, span })),
	...Arr.map(c.one, (span): Row => ({ k: 1, span })),
	...(c.nullTarget ? [{ k: 0, span: { kind: "null" } } satisfies Row] : [])
]

export type CoverFeature =
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

export const changeGen: Gen<ChangeCase> = (source) => {
	const [targets, span] = source.draw(element(COVERING))
	return { targets, source: span, change: source.draw(element(changesOf(targets))) }
}

export type ChangeFeature =
	| `${"immediate" | "deferred"} ${"delete" | "respan"} ${"committed" | "refused 23503" | "refused 23514" | "refused 23P01"}`
	| "a shrink that keeps the source covered committed"

/** A change's verdict as a feature. */
export const changeFeature = (
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
export const shrinks = (c: ChangeCase): boolean => {
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
