/** What the properties of coverage.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Data, Option } from "effect"
import { pg, span } from "#compiler/public/fields.ts"
import {
	contained,
	key,
	on,
	relation,
	schema,
	select,
	type Statement
} from "#compiler/public/schema.ts"
import type { Catalogued, Seat } from "#test/pg/fin/installed.ts"
import { covered, isEmpty, keyRefusal, type Row, SPANS } from "#test/pg/substrate/temporal.ts"
import { nonEmpty } from "#test/support/assert.ts"
import type { Moment } from "#test/support/families/mutate.ts"
import type { Names } from "#test/support/kernel/naming.ts"
import { upTo } from "#test/support/up-to.ts"

const Target = relation(
	"Target",
	{ id: pg.integer, k: pg.integer, during: span(pg.integer), on: pg.boolean },
	["id"]
)

const Source = relation(
	"Source",
	{ id: pg.integer, k: pg.integer, during: span(pg.integer), on: pg.boolean },
	["id"]
)

const selectedTarget = select(Target, (t) => t.eq(t.on, true))

/** The target key, over a selected side, which the installation reports as its own law (a projected key). */
const targetKey = key(on(selectedTarget, "k", "during"))

/** The coverage: a selected source's span within its key's selected target spans. */
const coverage = contained(
	on(
		select(Source, (s) => s.eq(s.on, true)),
		"k",
		"during"
	),
	on(selectedTarget, "k", "during")
)

export const Coverage = schema("fin_coverage", [Target, Source], [targetKey, coverage])

export const RELATIONS = ["Target", "Source"] as const

export class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** What refuses a statement, by the model: an empty span's shape CHECK, the target key, or the coverage. */
type Refusal = "empty span" | "key" | "coverage"

type Model =
	| { readonly kind: "committed" }
	| { readonly kind: "refused"; readonly moment: Moment; readonly by: Refusal }

/** A case: target rows in one INSERT, then one source row. */
interface Sketch {
	readonly targets: ReadonlyArray<Row>
	readonly source: Row
}

const ROWS: Arr.NonEmptyReadonlyArray<Row> = nonEmpty(
	Arr.flatMap([0, 1], (k) => Arr.map(SPANS, (s): Row => ({ k, span: s })))
)

export const sketchGen: Gen<Sketch> = (source) => {
	const n = source.draw(element([0, 1, 2] as const))
	return {
		targets: Arr.map(
			upTo(n, (i) => i + 1),
			() => source.draw(element(ROWS))
		),
		source: source.draw(element(ROWS))
	}
}

/** The statements' model: each INSERT refused by an empty span first, then the key or the coverage. */
export const modelOf = (sketch: Sketch): Model => {
	const empty = (rows: ReadonlyArray<Row>) =>
		Arr.some(rows, (r) => r.span.kind === "span" && isEmpty(r.span))
	const targets = Arr.isReadonlyArrayNonEmpty(sketch.targets)
	if (targets && empty(sketch.targets)) {
		return { kind: "refused", moment: { kind: "statement", index: 0 }, by: "empty span" }
	}
	if (targets && Option.isSome(keyRefusal(sketch.targets))) {
		return { kind: "refused", moment: { kind: "statement", index: 0 }, by: "key" }
	}
	if (empty([sketch.source])) {
		return {
			kind: "refused",
			moment: { kind: "statement", index: targets ? 1 : 0 },
			by: "empty span"
		}
	}
	return covered(sketch.targets, sketch.source)
		? { kind: "committed" }
		: { kind: "refused", moment: { kind: "commit" }, by: "coverage" }
}

/** A row's values: its span, or a placeholder span outside the selection. */
const valuesOf = (id: number, row: Row): string =>
	row.span.kind === "null"
		? `(${id}, ${row.k}, '[0,1)', false)`
		: `(${id}, ${row.k}, '[${row.span.lo},${row.span.hi})', true)`

export const insertSql = (
	seat: Seat,
	relation: string,
	rows: ReadonlyArray<Row>,
	from: number
): string =>
	`INSERT INTO ${seat.table(relation)} (${Arr.join(
		Arr.map(["id", "k", "during", "on"], (r) => seat.column(relation, r)),
		", "
	)}) VALUES ${Arr.join(
		Arr.map(rows, (row, i) => valuesOf(from + i, row)),
		", "
	)}`

/**
 * What a refusal's constraint is, as the installation reports it: a CHECK over a span field, its shape; a unique or a
 * foreign key reporting the target key's law or the coverage's law, each the law its statement declares
 * (kernel/naming.ts lawOf), whatever kind of law the theory makes of it.
 */
export const refusalOf =
	(laws: Names) =>
	(c: Catalogued): Option.Option<Refusal> => {
		const reports = (law: Statement) => Option.contains(c.law, laws.lawOf(law))
		switch (c.kind) {
			case "check":
				return c.columns.includes("during") ? Option.some("empty span") : Option.none()
			case "unique":
			case "primary":
				return reports(targetKey) ? Option.some("key") : Option.none()
			case "foreign":
				return reports(coverage) ? Option.some("coverage") : Option.none()
		}
	}

export const SQLSTATE: Readonly<Record<Refusal, string>> = {
	"empty span": "23514",
	key: "23P01",
	coverage: "23503"
}

export type CoverageFeature =
	| "committed"
	| "committed with a source outside its selection"
	| `refused ${Refusal}`
	| "refused coverage across a gap"
