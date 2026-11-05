/**
 * Coverage through grizzle's lowering, on PostgreSQL 19rc1 (fin.md §7, w4-w7 §2.5): a containment of a selected source's
 * span into a selected target's, `contained(on(select(Source, on), "k", "during"), on(select(Target, on), "k",
 * "during"))`, with the target keyed by `key(on(select(Target, on), "k", "during"))`, which over a span term is
 * WITHOUT OVERLAPS; grizzle lowers it to a PERIOD foreign key over the sides' law columns, NO ACTION, deferred only by
 * its deferral rule.
 *
 * - **The specification turned into a checker:** G2's coverage model (test/pg/substrate/temporal.ts), the same one the
 *   substrate's hand-written lowering is proved against: a source row is covered when it is outside its selection
 *   (its law columns NULL, skipped) or its span lies inside the union of its key's selected target spans; the target
 *   key refuses two selected spans of one key that overlap (23P01). PostgreSQL must commit exactly what the model
 *   commits and refuse the rest at the statement the model names, by the installed native of the model's SQLSTATE.
 * - **The named non-empty CHECK:** an empty span is refused by the span field's own shape CHECK, 23514 naming that
 *   CHECK on the row's table, before WITHOUT OVERLAPS's unattributed 23514 could, selected or not.
 * - **Deferral:** by #deferral's rule (laws/model/model.ts), which a PERIOD foreign key keeps (w4-w7 §3.8), a foreign key
 *   is deferred on a cycle or into a replaceable target, one whose fields its target columns do not cover. Target holds
 *   fields beyond (k, during), so the PERIOD foreign key is deferrable, and a gap is refused at COMMIT; the empty span
 *   and the overlap are refused at their statements.
 *
 * The box is G2's (doctrine rule 9): keys 0 and 1, points 0 to 3, each span one of the six non-empty intervals over
 * them, the empty one, or outside the selection; at most two target rows in one INSERT, then one source row.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, Option } from "effect"
import { pg, span } from "#compiler/public/fields.ts"
import { contained, key, on, relation, schema, select } from "#compiler/public/schema.ts"
import {
	cleared,
	type Catalogued,
	constraintText,
	type Seat,
	seatOf
} from "#test/pg/fin/installed.ts"
import { covered, isEmpty, keyRefusal, type Row, SPANS } from "#test/pg/substrate/temporal.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import type { Moment } from "#test/support/families/mutate.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	type Attempted,
	attempt,
	momentText,
	refusalText,
	sameMoment
} from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Target = relation("Target", { id: pg.int4, k: pg.int4, during: span(pg.int4), on: pg.bool }, [
	"id"
])
const Source = relation("Source", { id: pg.int4, k: pg.int4, during: span(pg.int4), on: pg.bool }, [
	"id"
])
const selectedTarget = select(Target, (t) => t.eq(t.on, true))

const Coverage = schema("fin_coverage", { Target, Source }, [
	key(on(selectedTarget, "k", "during")),
	contained(
		on(
			select(Source, (s) => s.eq(s.on, true)),
			"k",
			"during"
		),
		on(selectedTarget, "k", "during")
	)
])

const RELATIONS = ["Target", "Source"] as const

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

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

const sketchGen: Gen<Sketch> = (source) => {
	const n = source.draw(element([0, 1, 2] as const))
	return {
		targets: Arr.map(Arr.range(1, n).slice(0, n), () => source.draw(element(ROWS))),
		source: source.draw(element(ROWS))
	}
}

/** The statements' model: each INSERT refused by an empty span first, then the key or the coverage. */
const modelOf = (sketch: Sketch): Model => {
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

const insertSql = (seat: Seat, relation: string, rows: ReadonlyArray<Row>, from: number): string =>
	`INSERT INTO ${seat.table(relation)} (${Arr.join(
		Arr.map(["id", "k", "during", "on"], (r) => seat.column(relation, r)),
		", "
	)}) VALUES ${Arr.join(
		Arr.map(rows, (row, i) => valuesOf(from + i, row)),
		", "
	)}`

/** The native a refusal's constraint is, by kind and columns: the span shape CHECK, the WITHOUT OVERLAPS key, the PERIOD FK. */
const refusalOf = (c: Catalogued): Option.Option<Refusal> => {
	switch (c.kind) {
		case "check":
			return c.columns.includes("during") && c.columns.length === 1
				? Option.some("empty span")
				: Option.none()
		case "unique":
		case "primary":
			return c.relation === "Target" && c.columns.length > 1 ? Option.some("key") : Option.none()
		case "foreign":
			return c.relation === "Source" ? Option.some("coverage") : Option.none()
	}
}

const SQLSTATE: Readonly<Record<Refusal, string>> = {
	"empty span": "23514",
	key: "23P01",
	coverage: "23503"
}

type CoverageFeature =
	| "committed"
	| "committed with a source outside its selection"
	| `refused ${Refusal}`
	| "refused coverage across a gap"

layer(Substrate.layer)("coverage through grizzle's lowering on PostgreSQL 19rc1", (it) => {
	it.effect(
		"commit exactly the covered states of G2's box, refuse a gap or an overlap by its native, and an empty span by the span's named CHECK, each at its statement",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const seat = yield* seatOf(Coverage, RELATIONS, "coverage")
					const fk = Arr.filter(seat.constraints, (c) => Option.contains(refusalOf(c), "coverage"))
					assert.ok(
						fk.length === 1 && Arr.every(fk, (c) => c.deferrable),
						`one coverage foreign key, deferrable into its replaceable target: ${Arr.join(Arr.map(fk, constraintText), "; ")}`
					)
					return yield* exhaust(
						{
							suite: "fin/coverage",
							generator: sketchGen,
							literal: Formatter.format,
							limit: Arr.reduce([0, 1, 2], 0, (sum, n) => sum + ROWS.length ** n) * ROWS.length,
							box: "keys 0 and 1, points 0 to 3, each span a non-empty interval, the empty one, or outside its selection: at most two target rows in one INSERT, then one source row",
							oracle: {
								kind: "specification",
								name: "G2's coverage model (test/pg/substrate/temporal.ts covered, keyRefusal) as a checker, an empty span refused first by its field's shape CHECK"
							},
							coverage: requiredInSpace<CoverageFeature>([
								"committed",
								"committed with a source outside its selection",
								"refused empty span",
								"refused key",
								"refused coverage",
								"refused coverage across a gap"
							]),
							caseHang
						},
						(sketch, c) =>
							Effect.gen(function* () {
								const model = modelOf(sketch)
								const statements = [
									...(Arr.isReadonlyArrayNonEmpty(sketch.targets)
										? [insertSql(seat, "Target", sketch.targets, 0)]
										: []),
									insertSql(seat, "Source", [sketch.source], 100)
								]
								const real: Attempted = yield* attempt(seat.session, statements)
								yield* seat.session.resetStatements
								const disagree = (why: string) =>
									new Disagreed({
										message: `${why}: the model predicts ${Formatter.format(model)}, PostgreSQL gave ${real.kind === "committed" ? "commit" : `refusal ${momentText(real.moment)}: ${refusalText(real.fields)}`}, for ${Formatter.format(sketch)}`
									})
								if (real.kind === "committed") {
									yield* cleared(seat, RELATIONS)
									if (model.kind !== "committed") {
										return yield* disagree("PostgreSQL committed")
									}
									c.note(
										sketch.source.span.kind === "null"
											? "committed with a source outside its selection"
											: "committed"
									)
									return
								}
								if (model.kind !== "refused") {
									return yield* disagree("PostgreSQL refused")
								}
								const named = Option.flatMap(seat.refusedBy(real.fields), refusalOf)
								if (
									!sameMoment(real.moment, model.moment) ||
									!Option.contains(named, model.by) ||
									real.fields.code !== SQLSTATE[model.by]
								) {
									return yield* disagree("the moment, the native or the SQLSTATE differs")
								}
								c.note(`refused ${model.by}`)
								if (model.by === "coverage" && sketch.source.span.kind === "span") {
									const { lo, hi } = sketch.source.span
									if (
										Arr.some(
											sketch.targets,
											(t) =>
												t.k === sketch.source.k &&
												t.span.kind === "span" &&
												t.span.lo < hi &&
												lo < t.span.hi
										)
									) {
										c.note("refused coverage across a gap")
									}
								}
							})
					)
				})
			)
	)
})
