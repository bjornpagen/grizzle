/**
 * What recursion admission refuses, each with its typed cause (core/causes.ts RecursionRefusal), judged by planted
 * bounded-exhaustive properties: each family's rule, as check/recursion states it, restated as a model over a small
 * space of definitions that breaks it in every way the rule names and keeps it in the controls beside them. A refusal is
 * compared by its cause, never its prose; where several rules refuse one definition, the cause is one of theirs, since
 * admission states no priority among them.
 *
 * - an arm whose head misses or adds a state column, at that arm's head (scan.ts);
 * - a state column an arm delivers at another identity, another numeric typmod or an unproved text refinement, and a
 *   state column with no hashing (state.ts); an exact conversion is cast;
 * - feedback read twice, self outside a recursive arm's own matches, r.not(self), an aggregate or r.pack over self,
 *   an approximate stage below an arm (scan.ts); an aggregate in the base, and a recursive arm reading no self, are
 *   admitted;
 * - a recursion or a union of rules read by a recursive arm that reads self, matched or negated, at any depth of what
 *   it reads, which PostgreSQL would read whole for every row the step extends (scan.ts); the same read in the base
 *   or in an arm reading no self, and a stored relation or one rule read in the step, are admitted;
 * - a state column computed from its own value with no admitted bound, directly, through a cycle of computed columns
 *   or through an import whose bind map reads the state; a countdown seeded by data counts its carrier
 *   (termination.ts).
 *
 * These definitions are built by hand because no generator draws them: the generated recursions
 * (unit/recursion/certificates) seed literals over one integer counter, a tag and a mark, and never break a head, a
 * type, the feedback's shape or an import. A refusal's place, its label and path, is the place of what it names in the
 * description as decoded, never its printed text. A countdown's seen-state estimate is searched over seeds drawn near
 * bigint's bounds and anywhere between.
 *
 * Oracle: each family's rule restated as a model (a specification); the countdown's states counted from its seed (a
 * second implementation).
 *
 * Features: each verdict and each cause of each family, several rules refusing one definition, and the admitted controls.
 */

import { assert, containsEqual, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { boolean, element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import type { RecursionRefusal } from "#compiler/core/causes.ts"
import { int8Max, int8Min } from "#compiler/ir/carriers.ts"
import { DecimalText } from "#compiler/ir/decimal.ts"
import { type FieldDesc } from "#compiler/ir/desc.ts"
import { subsumes } from "#compiler/ir/scalar.ts"
import { placeOf, succeeded } from "#test/support/assert.ts"
import { type AuthoredExprDesc as ExprDesc } from "#test/support/fixtures/ir/desc.ts"
import { idDesc } from "#test/support/ids.ts"
import { checkAuthored, checking, checkOptions } from "#test/support/policy.ts"
import {
	cast,
	compute,
	gt,
	imported,
	lt,
	match,
	narrowed,
	or,
	param,
	plainVar,
	ref,
	relationSource,
	rule,
	typedLit,
	varRef,
	vars
} from "#test/support/unit/check/dsl.ts"
import { descOf, Graph, lower, nodes, reads, theRecursive } from "#test/unit/recursion/fixtures.ts"
import {
	admitted,
	type Advance,
	armPlace,
	type At,
	type Base,
	baseArm,
	bigint,
	type Bound,
	type CounterCarrier,
	type CountdownFeature,
	covered,
	declared,
	delivered,
	Echo,
	expected,
	type Extra,
	extraArms,
	type HeadFeature,
	heads,
	type ImportFeature,
	Inc,
	integer,
	mainArm,
	mains,
	naturalField,
	nothingMore,
	type Observed,
	observed,
	outcomeOf,
	type ReadFeature,
	type ReadHow,
	type ReadPlace,
	readSelf,
	readSources,
	readVerdict,
	readingDefinition,
	recursive,
	refusedFor,
	rowPlace,
	s,
	seed,
	seedGen,
	selfVars,
	shaped,
	type ShapeFeature,
	Spans,
	type Spelled,
	type StateFeature,
	step,
	type Term,
	terms,
	totalCast,
	type UnboundedFeature,
	unboundedHops,
	verdicts,
	type Via,
	type X
} from "#test/unit/recursion/refusals.fixtures.ts"

/** Arm heads refuses an arm whose head misses or adds a state column, at that arm's head, naming what it misses and adds. */
export const armHeadsRefusesAnArmWhoseHeadMissesOrAddsAStateColumnAtThatArmsHeadNamingWhatItMissesAndAdds =
	property.exhaust(
		finite((source) => [source.draw(heads), source.draw(heads)] as const),
		{
			needs: {},
			situations: [
				"admitted",
				"base missing",
				"base extra",
				"rec missing",
				"rec extra",
				"both arms broken"
			] satisfies ReadonlyArray<Reached<HeadFeature>>,
			check:
				(_, c: Case<HeadFeature>) =>
				([baseHead, recHead]) =>
					Effect.sync(() => {
						const desc = recursive(
							"Walks",
							{ node: idDesc, hops: integer },
							[seed(shaped(baseHead, ref("Vertex", "id"), typedLit(0, integer)), [])],
							[
								step(
									["node", "hops"],
									[lt(s("hops"), typedLit(4, integer))],
									shaped(
										recHead,
										ref("Edge", "to"),
										compute("add", s("hops"), typedLit(1, integer))
									),
									nothingMore
								)
							]
						)
						const outcome = outcomeOf(desc)
						const broken = Arr.filter(
							[
								["base", baseHead],
								["rec", recHead]
							] as const,
							([, head]) => head !== "exact"
						)
						if (broken.length === 0) {
							c.note("admitted")
							admitted(outcome)
							return
						}
						for (const [arm, head] of broken) {
							if (head !== "exact") {
								c.note(`${arm} ${head}`)
							}
						}
						if (broken.length === 2) {
							c.note("both arms broken")
						}
						const { cause, place } = refusedFor(outcome)
						containsEqual(
							Arr.map(broken, ([arm, head]): RecursionRefusal => ({
								kind: "armHead",
								recursion: "Walks",
								arm,
								row: ["hops", "node"],
								missing: head === "missing" ? ["hops"] : [],
								extra: head === "extra" ? ["more"] : []
							})),
							cause
						)
						if (cause.kind === "armHead") {
							assert.deepEqual(place, armPlace(desc, cause.arm, "head"), "at the arm's head")
						}
					}),
			oracle: {
				kind: "specification",
				name: "check/recursion/scan.ts: an arm whose head misses or adds a state column is refused at that arm's head, naming both"
			},
			box: "each arm's head exact, missing the counter, or adding a column",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/check/recursion/scan.ts",
					original: "\t\tif (missing.length > 0 || extra.length > 0) {",
					replacement: "\t\tif (missing.length > 0) {",
					why: "An arm head's extra column admitted; the arm-heads search fails."
				}
			]
		}
	)

/** The state heading admits a column of the declared type, casts an exact conversion, and refuses an inexact one or an unhashable column. */
export const theStateHeadingAdmitsAColumnOfTheDeclaredTypeCastsAnExactConversionAndRefusesAnInexactOneOrAnUnhashableColumn =
	property.exhaust(
		finite((source) => {
			const d = source.draw(element(declared))
			const a = source.draw(element(delivered))
			const spelled = source.draw(
				element<Spelled>(
					totalCast(d, a) ? ["as delivered", "cast by the author"] : ["as delivered"]
				)
			)
			return [d, a, spelled] as const
		}),
		{
			needs: {},
			situations: [
				"admitted same",
				"admitted cast",
				"refused unhashable",
				"refused anotherType",
				"refused anotherTypmod",
				"refused unprovedRefinement",
				"cast by the author"
			] satisfies ReadonlyArray<Reached<StateFeature>>,
			check:
				(_, c: Case<StateFeature>) =>
				([d, a, spelled]) =>
					Effect.sync(() => {
						const term = spelled === "cast by the author" ? cast(a.term, d.field) : a.term
						const desc = recursive(
							"Labels",
							{ node: idDesc, c: d.field },
							[seed({ node: ref("Vertex", "id"), c: term }, a.reads)],
							[step(["node", "c"], [], { node: ref("Edge", "to"), c: s("c") }, nothingMore)]
						)
						const outcome = outcomeOf(desc)
						/** A cast by the author delivers the declared type itself. */
						const want = spelled === "cast by the author" ? expected(d, d) : expected(d, a)
						if (spelled === "cast by the author") {
							c.note("cast by the author")
						}
						switch (want.kind) {
							case "unhashable": {
								c.note("refused unhashable")
								const { cause, place } = refusedFor(outcome)
								assert.ok(cause.kind === "unhashableState", `refused for ${cause.kind}`)
								assert.deepEqual(
									{ recursion: cause.recursion, column: cause.column },
									{ recursion: "Labels", column: "c" }
								)
								assert.deepEqual(place, rowPlace(desc, "c"), "at the declared column")
								return
							}
							case "inexact": {
								c.note(`refused ${want.conversion}`)
								const { cause } = refusedFor(outcome)
								assert.ok(cause.kind === "inexactConversion", `refused for ${cause.kind}`)
								/**
								 * The delivered and declared type labels are the types' own; the rule's contract is the arm, the
								 * column and the conversion.
								 */
								const { recursion, arm, column, conversion } = cause
								assert.deepEqual(
									{ recursion, arm, column, conversion },
									{
										recursion: "Labels",
										arm: "base",
										column: "c",
										conversion: want.conversion
									}
								)
								return
							}
							case "admitted": {
								c.note(`admitted ${want.conversion}`)
								const q = admitted(outcome)
								const rec = theRecursive(q)
								const base = rec.base
								assert.ok(base.kind === "ProjectSet", "the base arm is projected to the state")
								assert.deepEqual(base.heading, rec.heading)
								const column = Option.getOrThrow(Arr.findFirst(base.out, (o) => o.name === "c"))
								const kind = column.expr.kind
								const declared = Option.getOrThrow(
									Arr.findFirst(rec.heading, (h) => h.name === "c")
								).type
								const [read] = column.expr.kind === "cast" ? column.expr.args : [column.expr]
								/**
								 * The author's cast is a cast where it changes the type; a cast to the type the term has already
								 * restates it. A type the declared one subsumes stands as it is, with no node of its own (ir/scalar.ts
								 * subsumes, bbfa4eca06: a refined text where the state declares text, a domain's value where it
								 * declares its base), since the IR builds no cast up to a type that subsumes its operand's
								 * (ir/expr.ts builtExpr).
								 */
								const casts =
									(spelled === "cast by the author"
										? a.identity !== d.identity || a.within !== d.within
										: want.conversion === "cast") &&
									!subsumes(declared, defined(read, "the column's read").type)
								assert.equal(
									kind === "cast",
									casts,
									"the column is cast exactly where its type changes to one that does not subsume it"
								)
							}
						}
					}),
			oracle: {
				kind: "specification",
				name: "check/recursion/state.ts: every state column hashes; a delivered column converts exactly, cast where its type changes, or is refused for the conversion"
			},
			box: "every declared type of nine against every delivered type of six, as delivered or cast by the author where the cast is total",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/check/recursion/state.ts",
					original: "\t\tif (subsumes(target.type, column.type)) {\n",
					replacement: "\t\tif (sameScalarType(column.type, target.type)) {\n",
					why: "A delivered column whose type the state's subsumes is cast up to it, a node the IR refuses as an up-cast (ir/expr.ts builtExpr): a vertex's refined label delivered into a state of wildcard text dies a defect; the state-heading search fails."
				},
				{
					file: "packages/engine/src/check/recursion/state.ts",
					original:
						"\tif (dt !== undefined && (at?.precision !== dt.precision || at.scale !== dt.scale)) {",
					replacement: "\tif (dt !== undefined && at?.scale !== dt.scale) {",
					why: "A numeric typmod change of precision alone converted; the state-heading search fails."
				}
			]
		}
	)

/** The feedback's shape refuses feedback read twice, negated, aggregated, misplaced or below an approximate stage, and factors every admitted arm into one feedback read. */
export const theFeedbacksShapeRefusesFeedbackReadTwiceNegatedAggregatedMisplacedOrBelowAnApproximateStageAndFactorsEveryAdmittedArmIntoOneFeedbackRead =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(element<Base>(["seed", "aggregate", "approximate", "self"])),
					source.draw(element<Extra>(["none", "no self", "reverse"])),
					source.draw(mains)
				] as const
		),
		{
			needs: {},
			situations: [
				"admitted",
				"admitted with an aggregate base",
				"admitted with an arm reading no self",
				"admitted with two transition arms",
				"admitted negating a fixed relation",
				"admitted with an importer's parameter",
				"refused approximateSource",
				"refused nonlinearFeedback",
				"refused selfNegation",
				"refused recursiveAggregation",
				"refused misplaced self",
				"several rules refuse"
			] satisfies ReadonlyArray<Reached<ShapeFeature>>,
			check:
				(_, c: Case<ShapeFeature>) =>
				([base, extra, m]) =>
					Effect.sync(() => {
						const desc = recursive(
							"Reach",
							{ node: idDesc, n: naturalField },
							[baseArm(base)],
							[mainArm(m), ...extraArms(extra)]
						)
						const outcome = outcomeOf(desc)
						const want = verdicts(base, m)
						if (want.length > 0) {
							const seen = observed(outcome)
							assert.ok(
								seen !== "admitted" && seen !== "another refusal",
								`${Formatter.format(seen)}, where the rules refuse`
							)
							containsEqual<Observed>(
								Arr.map(want, (verdict): Observed =>
									verdict.kind === "misplaced self"
										? verdict
										: { kind: "cause", cause: verdict.cause }
								),
								seen
							)
							for (const verdict of want) {
								c.note(
									verdict.kind === "misplaced self" ? "refused misplaced self" : verdict.feature
								)
							}
							if (want.length > 1) {
								c.note("several rules refuse")
							}
							return
						}
						const q = admitted(outcome)
						c.note("admitted")
						const rec = theRecursive(q)
						assert.equal(reads(q, rec.self), 1, "one feedback read")
						assert.equal(
							rec.base.kind === "Union",
							extra === "no self",
							"the base is a union exactly when an arm reads no self"
						)
						assert.equal(
							Arr.some(nodes(q), (n) => n.kind === "AntiJoin"),
							m.negatesBlocked,
							"a fixed relation is negated exactly where the step negates it"
						)
						assert.deepEqual(
							Arr.sort(
								Arr.map(q.params, (p) => p.name),
								Order.String
							),
							Arr.sort(
								[...(base === "seed" ? ["start"] : []), ...(m.avoids ? ["avoid"] : [])],
								Order.String
							)
						)
						lower(q)
						if (base === "aggregate") {
							c.note("admitted with an aggregate base")
						}
						if (extra === "no self") {
							c.note("admitted with an arm reading no self")
						}
						if (extra === "reverse") {
							c.note("admitted with two transition arms")
						}
						if (m.negatesBlocked) {
							c.note("admitted negating a fixed relation")
						}
						if (m.avoids) {
							c.note("admitted with an importer's parameter")
						}
					}),
			oracle: {
				kind: "specification",
				name: "check/recursion/scan.ts: one feedback read, never negated, aggregated, misplaced or below an approximate stage; every admitted arm factored into one read"
			},
			box: "every base arm of four, every further arm of three, and every main arm reading self once or twice, negating, aggregating, nesting, approximating, negating a fixed relation or reading an importer's parameter",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/check/recursion/scan.ts",
					original: "\t\tif (secondSelf !== undefined) {",
					replacement: "\t\tif (secondSelf !== undefined && selves.length > 2) {",
					why: "Feedback read twice admitted; the feedback-shape search fails."
				}
			]
		}
	)

/**
 * A recursive arm that reads self reads no recursion and no union, at any depth of what it matches or negates, since
 * PostgreSQL computes a recursion once as a relation with no index and deduplicates a union before any join reaches
 * it; the base and an arm reading no self read either, and the step reads a stored relation or one rule.
 */
export const aStepReadsNoRecursionAndNoUnionAtAnyDepthOfWhatItMatchesOrNegatesWhileTheBaseAndAnArmReadingNoSelfReadEither =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(element<ReadPlace>(["base", "step", "arm reading no self"])),
					source.draw(element(readSources)),
					source.draw(element<ReadHow>(["matched", "negated"]))
				] as const
		),
		{
			needs: {},
			situations: [
				"refused recursiveStep matched",
				"refused recursiveStep negated",
				"refused unionStep matched",
				"refused unionStep negated",
				"refused at depth",
				"admitted a stored relation in the step",
				"admitted one rule in the step",
				"admitted in the base",
				"admitted in an arm reading no self"
			] satisfies ReadonlyArray<Reached<ReadFeature>>,
			check:
				(_, c: Case<ReadFeature>) =>
				([place, read, how]) =>
					Effect.sync(() => {
						const desc = readingDefinition(place, read, how)
						const outcome = outcomeOf(desc)
						const want = readVerdict(place, read)
						if (want !== undefined) {
							const { cause, place: at } = refusedFor(outcome)
							assert.deepEqual(cause, want)
							assert.deepEqual(
								at,
								how === "matched"
									? armPlace(desc, "rec", "matches", 2)
									: armPlace(desc, "rec", "where", 0),
								"refused at the match or the negation that reads it"
							)
							c.note(`refused ${want.kind} ${how}`)
							if (read === "one rule over a recursion" || read === "a union over a recursion") {
								c.note("refused at depth")
							}
							return
						}
						lower(admitted(outcome))
						if (place === "step") {
							c.note(
								read === "a stored relation"
									? "admitted a stored relation in the step"
									: "admitted one rule in the step"
							)
						} else {
							c.note(
								place === "base" ? "admitted in the base" : "admitted in an arm reading no self"
							)
						}
					}),
			oracle: {
				kind: "specification",
				name: "check/recursion/scan.ts: a recursive arm reading self reads no recursion and no union at any depth of what it matches or negates, a recursion first; the base and an arm reading no self read either"
			},
			box: "every place of three (the base, the step, an arm reading no self), every source of six (a stored relation, one rule, a union, a recursion, one rule over a recursion, a union over a recursion), matched or negated",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/check/recursion/scan.ts",
					original: "\t\t\t\tif (whole !== undefined) {",
					replacement: '\t\t\t\tif (whole?.kind === "unionStep") {',
					why: "A recursion read in a step admitted; the read-in-step search fails at a recursion."
				},
				{
					file: "packages/engine/src/check/recursion/scan.ts",
					original: "\treturn more.length > 0",
					replacement: "\treturn more.length > 1",
					why: "A union of two rules read in a step admitted; the read-in-step search fails at a union."
				}
			]
		}
	)

/** R.pack over a recursive arm refuses r.pack over self as an aggregate, at its head term, and admits the arm without it. */
export const rPackOverARecursiveArmRefusesRPackOverSelfAsAnAggregateAtItsHeadTermAndAdmitsTheArmWithoutIt =
	property.exhaust(finite(boolean), {
		needs: {},
		situations: ["packed", "plain"] satisfies ReadonlyArray<Reached<"packed" | "plain">>,
		check: (_, c: Case<"packed" | "plain">) => (pack) =>
			Effect.sync(() => {
				c.note(pack ? "packed" : "plain")
				const r = checkQuery(checking(Spans), descOf(covered(pack)), checkOptions("query"))
				if (!pack) {
					succeeded(r)
					return
				}
				assert.ok(
					!r.ok && r.error.reason._tag === "RecursionRefused",
					"refused by recursion admission"
				)
				assert.deepEqual(r.error.reason.cause, {
					kind: "recursiveAggregation",
					recursion: "Covered",
					fold: "pack"
				})
				assert.deepEqual(
					placeOf(r.error.reason.at),
					armPlace(descOf(covered(pack)), "rec", "head", "during"),
					"at the packed head term"
				)
			}),
		oracle: {
			kind: "specification",
			name: "check/recursion/scan.ts: r.pack over self is an aggregation over the feedback, refused at its head term"
		},
		box: "the step's span packed or delivered as read",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/recursion/scan.ts",
				original:
					'\t\t\t\treturn h.kind === "producer" && h.fn === "pack" ? [{ key, fold: h.fn }] : []',
				replacement: "\t\t\t\treturn []",
				why: "r.pack over self admitted; the pack search fails."
			}
		]
	})

/** Unbounded computed state admits only a counter over an integer carrier bounded on the side it moves towards, and refuses every other computed feedback. */
export const unboundedComputedStateAdmitsOnlyACounterOverAnIntegerCarrierBoundedOnTheSideItMovesTowardsAndRefusesEveryOtherComputedFeedback =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(element<CounterCarrier>(["int4", "numeric"])),
					source.draw(
						element<Bound>(["current below", "current above", "either of two", "next below"])
					),
					source.draw(element<Advance>(["plus one", "times two"]))
				] as const
		),
		{
			needs: {},
			situations: [
				"a bounded counter",
				"refused int4 current above plus one",
				"refused int4 either of two plus one",
				"refused int4 next below plus one",
				"refused int4 current below times two",
				"refused numeric current below plus one"
			] satisfies ReadonlyArray<Reached<UnboundedFeature>>,
			check:
				(_, c: Case<UnboundedFeature>) =>
				([carrier, bound, advance]) =>
					Effect.sync(() => {
						const type: FieldDesc =
							carrier === "int4" ? integer : { kind: "numeric", precision: 1000, scale: 0 }
						const k = (n: number) =>
							carrier === "int4"
								? typedLit(n, type)
								: typedLit(defined(DecimalText.parse(String(n))), type)
						const hops = s("hops")
						const guard: ExprDesc =
							bound === "current below"
								? lt(hops, k(4))
								: bound === "current above"
									? gt(hops, k(4))
									: bound === "either of two"
										? or([lt(hops, k(4)), lt(hops, k(5))])
										: lt(compute("add", hops, k(1)), k(4))
						const desc = recursive(
							"Walks",
							{ node: idDesc, hops: type },
							[seed({ node: ref("Vertex", "id"), hops: k(0) }, [])],
							[
								step(
									["node", "hops"],
									[guard],
									{
										node: ref("Edge", "to"),
										hops: compute(
											advance === "plus one" ? "add" : "mul",
											hops,
											k(advance === "plus one" ? 1 : 2)
										)
									},
									nothingMore
								)
							]
						)
						const outcome = outcomeOf(desc)
						if (carrier === "int4" && bound === "current below" && advance === "plus one") {
							c.note("a bounded counter")
							assert.equal(theRecursive(admitted(outcome)).termination.kind, "boundedState")
							return
						}
						c.note(`refused ${carrier} ${bound} ${advance}`)
						assert.deepEqual(refusedFor(outcome).cause, unboundedHops)
					}),
			oracle: {
				kind: "specification",
				name: "check/recursion/termination.ts: only a counter over an integer carrier bounded on the side it moves towards"
			},
			box: "an integer or numeric counter, bounded below, above, by either of two, or by its successor, advanced by one or doubled",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/check/recursion/termination.ts",
					original:
						"\t\t\t\t\t? risingLast(g.op, boundAt(g.bound, max))\n\t\t\t\t\t: fallingLast(g.op, boundAt(g.bound, min))",
					replacement:
						"\t\t\t\t\t? (risingLast(g.op, boundAt(g.bound, max)) ?? fallingLast(g.op, boundAt(g.bound, min)))\n\t\t\t\t\t: (fallingLast(g.op, boundAt(g.bound, min)) ?? risingLast(g.op, boundAt(g.bound, max)))",
					why: "A counter bounded on the side it moves away from admitted; the unbounded-counter search fails."
				}
			]
		}
	)

/** Unbounded computed state refuses a cycle of computed columns, each computed from the other, and admits every acyclic pairing. */
export const unboundedComputedStateRefusesACycleOfComputedColumnsEachComputedFromTheOtherAndAdmitsEveryAcyclicPairing =
	property.exhaust(
		finite((source) => [source.draw(terms), source.draw(terms)] as const),
		{
			needs: {},
			situations: ["a cycle", "acyclic"] satisfies ReadonlyArray<Reached<"a cycle" | "acyclic">>,
			check:
				(_, c: Case<"a cycle" | "acyclic">) =>
				([aTerm, bTerm]) =>
					Effect.sync(() => {
						const term = (column: "a" | "b", t: Term): ExprDesc => {
							const other = column === "a" ? "b" : "a"
							switch (t) {
								case "the other plus one":
									return narrowed(compute("add", s(other), typedLit(1, integer)), "int4")
								case "itself plus one":
									return compute("add", s(column), typedLit(1, integer))
								case "copied":
									return s(column)
								case "a literal":
									return typedLit(1, integer)
							}
						}
						const desc = recursive(
							"Swap",
							{ a: integer, b: integer },
							[
								rule({
									vars: vars("Edge", "cost"),
									matches: [match(relationSource("Edge"), { cost: ref("Edge", "cost") })],
									where: [],
									head: { a: typedLit(0, integer), b: typedLit(0, integer) },
									interiors: [],
									attach: []
								})
							],
							[
								rule({
									vars: selfVars("a", "b"),
									matches: [readSelf("a", "b")],
									where: [lt(s("a"), typedLit(10, integer)), lt(s("b"), typedLit(10, integer))],
									head: { a: term("a", aTerm), b: term("b", bTerm) },
									interiors: [],
									attach: []
								})
							]
						)
						const outcome = outcomeOf(desc)
						if (aTerm === "the other plus one" && bTerm === "the other plus one") {
							c.note("a cycle")
							containsEqual<RecursionRefusal>(
								[
									{
										kind: "unboundedState",
										recursion: "Swap",
										column: "a",
										reads: ["b"]
									},
									{
										kind: "unboundedState",
										recursion: "Swap",
										column: "b",
										reads: ["a"]
									}
								],
								refusedFor(outcome).cause
							)
							return
						}
						c.note("acyclic")
						admitted(outcome)
					}),
			oracle: {
				kind: "specification",
				name: "check/recursion/termination.ts: a cycle of computed columns is unbounded, every acyclic pairing admitted"
			},
			box: "every pairing of four step terms for two integer columns",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/check/recursion/termination.ts",
					original:
						'\t\t\t\tif (form.value.kind === "computed" && formReads(form).some((r) => own.has(r))) {',
					replacement:
						'\t\t\t\tif (form.value.kind === "computed" && formReads(form).some((r) => r === m)) {',
					why: "A cycle of computed columns admitted, only a column computed from its own value refused; the computed-cycle search fails."
				}
			]
		}
	)

/** Unbounded computed state through a correlated import refuses a counter laundered through an import whose bind map reads the state, through a chain, and admits one bound to data. */
export const unboundedComputedStateThroughACorrelatedImportRefusesACounterLaunderedThroughAnImportWhoseBindMapReadsTheStateThroughAChainAndAdmitsOneBoundToData =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(
						(source) =>
							[
								source.draw(element<Via>(["Inc", "Echo then Inc", "a counter beside Echo"])),
								source.draw(element<X>(["the hop count", "the edge's cost", "a parameter"]))
							] as const
					),
					source.draw(
						(source) =>
							[
								source.draw(element<At>(["the state's node", "the edge's end"])),
								source.draw(boolean)
							] as const
					)
				] as const
		),
		{
			needs: {},
			situations: [
				"admitted Inc",
				"refused Inc",
				"admitted Echo then Inc",
				"refused Echo then Inc",
				"admitted a counter beside Echo",
				"refused a counter beside Echo",
				"unproved a counter beside Echo"
			] satisfies ReadonlyArray<Reached<ImportFeature>>,
			check:
				(_, c: Case<ImportFeature>) =>
				([[via, x], [at, guarded]]) =>
					Effect.sync(() => {
						const xTerm =
							x === "the hop count"
								? s("hops")
								: x === "the edge's cost"
									? ref("Edge", "cost")
									: param("x0", integer)
						const atTerm = at === "the state's node" ? s("node") : ref("Edge", "to")
						const guard = guarded ? [lt(s("hops"), typedLit(4, integer))] : []
						/** The step reads the state and any edge: no data match binds the state's node, so it stays state. */
						const more =
							via === "Inc"
								? {
										vars: [plainVar("inc.y")],
										matches: [
											match(imported(Inc, { x: xTerm, at: atTerm }), {
												id: atTerm,
												y: varRef("inc.y")
											})
										]
									}
								: via === "Echo then Inc"
									? {
											vars: [plainVar("echo.id"), plainVar("echo.y"), plainVar("inc.y")],
											matches: [
												match(imported(Echo, { x: xTerm }), {
													id: varRef("echo.id"),
													y: varRef("echo.y")
												}),
												match(imported(Inc, { x: varRef("echo.y"), at: atTerm }), {
													id: atTerm,
													y: varRef("inc.y")
												})
											]
										}
									: {
											vars: [plainVar("echo.id")],
											matches: [
												match(imported(Echo, { x: xTerm }), {
													id: varRef("echo.id"),
													y: s("hops")
												})
											]
										}
						const next =
							via === "a counter beside Echo"
								? compute("add", s("hops"), typedLit(1, integer))
								: varRef("inc.y")
						const desc = recursive(
							"Walks",
							{ node: idDesc, hops: integer },
							[seed({ node: ref("Vertex", "id"), hops: typedLit(0, integer) }, [])],
							[
								rule({
									vars: [...selfVars("node", "hops"), ...vars("Edge", "to", "cost"), ...more.vars],
									matches: [
										readSelf("node", "hops"),
										match(relationSource("Edge"), {
											to: ref("Edge", "to"),
											cost: ref("Edge", "cost")
										}),
										...more.matches
									],
									where: guard,
									head: { node: ref("Edge", "to"), hops: next },
									interiors: [],
									attach: []
								})
							]
						)
						const outcome = outcomeOf(desc)
						/**
						 * Beside an Echo bound to data, the Echo's output binds the hop count, which is then data, so its successor
						 * is an exact integer no counter's bound proves fits the column: a narrowing left unproved.
						 */
						const dataHops = via === "a counter beside Echo" && x !== "the hop count"
						if (dataHops) {
							c.note("unproved a counter beside Echo")
							assert.deepEqual(outcome, { kind: "malformed", reason: "PartialOperation" })
							return
						}
						/**
						 * The state columns the next hop count is computed from: through an import, those its bind maps read. A
						 * counter is computed from itself, admitted under its bound.
						 */
						const reads =
							via === "a counter beside Echo"
								? guarded
									? []
									: ["hops"]
								: [
										...(x === "the hop count" ? ["hops"] : []),
										...(at === "the state's node" ? ["node"] : [])
									]
						if (!reads.includes("hops")) {
							c.note(`admitted ${via}`)
							admitted(outcome)
							return
						}
						c.note(`refused ${via}`)
						assert.deepEqual(refusedFor(outcome).cause, {
							...unboundedHops,
							reads: Arr.sort([...reads], Order.String)
						})
					}),
			oracle: {
				kind: "specification",
				name: "check/recursion/termination.ts: the state columns an import's bind map reads are the columns its output is computed from"
			},
			box: "Inc, Echo then Inc, or a counter beside Echo, bound to the hop count, the edge's cost or a parameter, at the state's node or the edge's end, guarded or not",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/check/recursion/termination.ts",
					original:
						'\t\t\ti !== self && m.source.kind !== "query" && m.source.kind !== "step" ? boundVars(m) : []',
					replacement: "\t\t\ti !== self ? boundVars(m) : []",
					why: "A variable an import binds read as data whatever its bind map reads; the import-laundering search fails."
				}
			]
		}
	)

/**
 * The seen-state estimate counts a countdown's states from its seed to its bound and admits every estimate, and
 * refuses the step over a seed that may be bigint's least value.
 *
 * Budget: 64 runs and 32 steered cases, what its suite stated before it became a property
 * (test/unit/recursion/refusals.test.ts:1419 at 8cad5bce, its runs and its coverage's cases).
 */
export const theSeenStateEstimateCountsACountdownsStatesFromItsSeedToItsBoundAndAdmitsEveryEstimateAndRefusesTheStepOverASeedThatMayBeBigintsLeastValue =
	property.explore(seedGen, {
		needs: {},
		budget: { runs: 64, steered: 32 },
		situations: [
			"admitted from zero or above",
			"admitted from below zero",
			"admitted from bigint's greatest value",
			"refused a parameter",
			"refused from bigint's least value"
		] satisfies ReadonlyArray<Reached<CountdownFeature>>,
		check: (_, c: Case<CountdownFeature>) => (seeded) =>
			Effect.sync(() => {
				const desc = recursive(
					"Countdown",
					{ n: bigint },
					[
						rule({
							vars: vars("Vertex", "id"),
							matches: [match(relationSource("Vertex"), { id: ref("Vertex", "id") })],
							where: [],
							head: {
								n: seeded.kind === "param" ? param("seed", bigint) : typedLit(seeded.value, bigint)
							},
							interiors: [],
							attach: []
						})
					],
					[
						rule({
							vars: selfVars("n"),
							matches: [readSelf("n")],
							where: [gt(s("n"), typedLit(0n, bigint))],
							head: { n: compute("sub", s("n"), typedLit(1n, bigint)) },
							interiors: [],
							attach: []
						})
					]
				)
				if (seeded.kind === "literal" && seeded.value > int8Min) {
					c.note(seeded.value >= 0n ? "admitted from zero or above" : "admitted from below zero")
					if (seeded.value === int8Max) {
						c.note("admitted from bigint's greatest value")
					}
					const cert = theRecursive(admitted(outcomeOf(desc))).termination
					assert.equal(cert.kind, "wellFounded")
					assert.equal(cert.stateEstimate, seeded.value >= 0n ? seeded.value + 1n : 1n)
					return
				}
				c.note(
					seeded.kind === "param" ? "refused a parameter" : "refused from bigint's least value"
				)
				const r = checkAuthored(checking(Graph), desc, checkOptions("query"))
				assert.ok(!r.ok, "the step over bigint's least value is refused")
				const reason = r.error.reason
				assert.ok(reason._tag === "PartialOperation", `refused as ${reason._tag}`)
				assert.deepEqual(
					{ precondition: reason.precondition, operand: reason.operand },
					{ precondition: "fits", operand: "n" }
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the countdown's states counted from its seed, and the step's least value, its least state less one, within bigint"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/recursion/termination.ts",
				original:
					"\t\tconst count = range === undefined ? valueCount(all) : range[1] - range[0] + 1n",
				replacement:
					"\t\tconst count = range === undefined ? valueCount(all) : range[1] - range[0]",
				why: "A counter's count of states one short of every integer from its least value to its greatest; the countdown search fails."
			}
		]
	})
