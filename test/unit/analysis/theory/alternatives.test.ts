/**
 * An alternatives statement's laws (fin.md §7, R5): its expansion is pure and headless, one forward containment per arm
 * relation, `eq` for an arm of one handle and `in` for an arm of several, and one reverse containment per armed
 * handle; the theory states each as a containment law of source `alternatives`, and a containment the schema also
 * states itself is one law with both statements. The oracle is fin.md §7's expansion written as its own checker,
 * judged over every roster of at most four handles with every assignment of its handles to two arm relations or none.
 *
 * Plants (~/.cache/grizzle-release/BR03/plants): alternatives-forward-first-handle (an arm of several handles is
 * contained in its first handle's parents alone, `eq` where fin.md §7 states `in`).
 *
 * Features: one handle per arm, an arm of several handles, an unarmed handle, a restated containment.
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import { type ExprDesc, expandAlternatives, type StatementDesc } from "#compiler/ir/desc.ts"
import { assert, defined } from "#test/support/assert.ts"
import {
	alternatives,
	closed,
	contained,
	decodedSchema,
	f,
	on,
	onWhere,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { upTo } from "#test/support/up-to.ts"
import { schemaOf, theoryOf } from "#test/unit/analysis/theory/support.ts"

/** Which arm relation each handle of the roster is the arm of, or none. */
type Assignment = ReadonlyArray<"A" | "B" | undefined>

/**
 * A roster of 1 to 4 handles, each the arm of A, of B or of none, at least one armed, built by its first armed handle:
 * the handles before it unarmed, it the arm of A or B, and every one after it any of the three.
 */
const assignment: Gen<{ readonly arms: Assignment; readonly restated: boolean }> = (source) => {
	const size = source.draw(int(1, 4))
	const first = source.draw(int(0, size - 1))
	const after = size - first - 1
	return {
		arms: [
			...upTo(first, (): "A" | "B" | undefined => undefined),
			source.draw(element(["A", "B"] as const)),
			...source.draw(array(element(["A", "B", undefined] as const), { min: after, max: after }))
		],
		restated: source.draw(boolean)
	}
}

const handleOf = (i: number): string => `h${i}`

/** The schema: roster R, parent P(id, tag: closedId(R)), arm relations A and B, the alternatives over P.tag. */
const alternativesSchema = (arms: Assignment, restated: boolean): SchemaDesc => {
	const handles = upTo(arms.length, handleOf)
	const armOf = Rec.fromEntries(
		Arr.flatMap(arms, (a, i) =>
			a === undefined ? [] : [[handleOf(i), { name: a, primaryKey: ["id"] }] as const]
		)
	)
	const statement = alternatives(
		{ name: "P", primaryKey: ["id"] },
		"tag",
		{ name: "R", handles },
		armOf
	)
	const firstArmed = Arr.findFirstIndex(arms, (a) => a !== undefined).pipe(
		Option.getOrElse(() => assert.fail("an assignment arms a handle"))
	)
	const restatement = contained(
		onWhere("P", ["id"], {
			kind: "compare",
			op: "eq",
			left: { kind: "field", field: "tag" },
			right: { kind: "literal", value: handleOf(firstArmed) }
		}),
		on(defined(arms[firstArmed]), ["id"])
	)
	return schemaOf(
		[
			closed("R", handles),
			relation("P", { id: f.uuid, tag: f.closedId("R") }, ["id"]),
			relation("A", { id: f.uuid }, ["id"]),
			relation("B", { id: f.uuid }, ["id"])
		],
		restated ? [statement, restatement] : [statement]
	)
}

/** A containment by what it states: its two relations and each side's selection, by its conjuncts' canonical texts. */
const containmentText = (
	from: string,
	fromSelection: ReadonlyArray<ExprDesc>,
	to: string,
	toSelection: ReadonlyArray<ExprDesc>
): string =>
	`${from}[${Arr.join(Arr.map(fromSelection, canonicalTextOf), ";")}] in ${to}[${Arr.join(Arr.map(toSelection, canonicalTextOf), ";")}]`

/** The discriminator among `handles`: `eq` for one, `in` for several, as fin.md §7 spells an arm's selection. */
const tagAmong = (handles: ReadonlyArray<string>): ExprDesc => {
	const tag: ExprDesc = { kind: "field", field: "tag" }
	const [only, ...more] = handles
	return more.length === 0
		? {
				kind: "compare",
				op: "eq",
				left: tag,
				right: { kind: "literal", value: defined(only) }
			}
		: { kind: "in", arg: tag, values: handles }
}

/**
 * fin.md §7's expansion, as its own checker: per arm relation, its key in P selected by the handles it is the arm of;
 * per armed handle, P selected by it in its arm. No containment reads the roster: there is no head.
 */
const expectedContainments = (arms: Assignment): ReadonlyArray<string> => {
	const relations = Arr.dedupe(Arr.filter(arms, (a): a is "A" | "B" => a !== undefined))
	const forward = Arr.map(relations, (rel) =>
		containmentText(rel, [], "P", [
			tagAmong(Arr.flatMap(arms, (a, i) => (a === rel ? [handleOf(i)] : [])))
		])
	)
	const reverse = Arr.flatMap(arms, (a, i) =>
		a === undefined ? [] : [containmentText("P", [tagAmong([handleOf(i)])], a, [])]
	)
	return Arr.sort([...forward, ...reverse], Order.String)
}

type Feature =
	| "one handle per arm"
	| "an arm of several handles"
	| "an unarmed handle"
	| "a restated containment"

describe("alternatives (fin.md §7)", () => {
	it.effect(
		"expands to its arms' containments, headless, each a containment law, a restated one merged",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/theory/alternatives",
						generator: assignment,
						literal: Formatter.format,
						/** The space: 2 + 8 + 26 + 80 armed assignments of 1 to 4 handles, each restated or not. */
						limit: 232,
						box: "every roster of 1 to 4 handles, each handle the arm of A, B or none, restated or not",
						oracle: { kind: "specification", name: "fin.md §7's expansion as a checker" },
						coverage: requiredInSpace<Feature>([
							"one handle per arm",
							"an arm of several handles",
							"an unarmed handle",
							"a restated containment"
						]),
						caseHang
					},
					({ arms, restated }, k) =>
						Effect.sync(() => {
							const several =
								Arr.filter(arms, (a) => a === "A").length > 1 ||
								Arr.filter(arms, (a) => a === "B").length > 1
							k.note(several ? "an arm of several handles" : "one handle per arm")
							if (Arr.some(arms, (a) => a === undefined)) {
								k.note("an unarmed handle")
							}
							const desc = alternativesSchema(arms, restated)
							const statement = Arr.findFirst(
								decodedSchema(desc).statements,
								(s): s is Extract<StatementDesc, { readonly kind: "alternatives" }> =>
									s.kind === "alternatives"
							).pipe(Option.getOrElse(() => assert.fail("the schema states its alternatives")))
							const once = expandAlternatives(statement)
							const twice = expandAlternatives(statement)
							assert.deepEqual(once, twice, "the expansion is pure")
							const statedAs = (
								cs: ReadonlyArray<Extract<StatementDesc, { readonly kind: "contained" }>>
							): ReadonlyArray<string> =>
								Arr.sort(
									Arr.map(cs, (c) =>
										containmentText(
											c.left.relation,
											c.left.selection.conjuncts,
											c.right.relation,
											c.right.selection.conjuncts
										)
									),
									Order.String
								)
							assert.deepEqual(
								statedAs(once),
								expectedContainments(arms),
								"the expansion is fin.md §7's, with no head"
							)
							const t = theoryOf(desc)
							const laws = Arr.filter(t.laws, (law) => law.detail.kind === "containment")
							const lawsAs: ReadonlyArray<string> = Arr.sort(
								Arr.flatMap(laws, (law) =>
									law.detail.kind === "containment"
										? [
												containmentText(
													law.detail.from.relation,
													Arr.map(law.detail.from.selection.conjuncts, (c) => c.predicate),
													law.detail.to.relation,
													Arr.map(law.detail.to.selection.conjuncts, (c) => c.predicate)
												)
											]
										: []
								),
								Order.String
							)
							assert.deepEqual(lawsAs, expectedContainments(arms), "each containment is one law")
							assert.ok(
								Arr.every(
									laws,
									(law) => law.source.kind === "alternatives" && law.shape === "contained"
								),
								"each of source alternatives, of shape contained"
							)
							if (restated) {
								k.note("a restated containment")
								const merged = Arr.filter(laws, (law) => law.statements.length === 2)
								assert.equal(
									merged.length,
									1,
									"the restated containment is one law with both statements"
								)
							}
						})
				)
			)
	)
})
