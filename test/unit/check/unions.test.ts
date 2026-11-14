/**
 * Unions (check/checker.ts): a union of one to three arms over a drawn schema, delivered, ordered, taken or matched, is
 * admitted exactly where the union rules admit it, with the heading, the discriminant and the widening they give, and
 * refused otherwise for the rule it breaks: an attachment on a shared heading, incompatible column types, an attached
 * arm widened, no discriminant, a keyless order, constants no arm delivers, or a column the selected arms lack.
 *
 * Oracle: the union rules restated over the drawn arms (test/unit/check/unions.ts verdictOf).
 *
 * Plants (~/.cache/grizzle-release/BR04/plants): unions-clashing-discriminant-admitted.patch (discriminant literals
 * that do not tell the heading groups apart are admitted).
 *
 * Features: each rule refused, and each admitted shape: one heading, headings told apart by Kind or by every literal
 * column, a widened column, an attached arm, a keyed order, a narrowed match, a set beside a discriminant of Kind.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { checkAuthored, checking, checkOptions } from "#test/support/policy.ts"
import { schemaDescOf } from "#test/unit/check/drawn.ts"
import {
	caseDesc,
	type UnionCase,
	type UnionRule,
	unionCaseGen,
	verdictOf
} from "#test/unit/check/unions.ts"

/** What a case reached: the rule a refusal enforced, or the shape of what the checker admitted. */
type UnionFeature =
	| UnionRule
	| "one heading"
	| "several headings told apart by Kind"
	| "several headings told apart by every literal column"
	| "a widened column"
	| "an attached arm admitted"
	| "a keyed order over several headings"
	| "a match narrowed to some arms"
	| "a set column beside a discriminant of Kind"

const rules: Arr.NonEmptyReadonlyArray<UnionRule> = [
	"an attachment on a shared heading",
	"incompatible column types",
	"an attached arm widened",
	"no discriminant",
	"a keyless order",
	"constants no arm delivers",
	"a column the selected arms lack"
]

/** The admitted shapes a case reached, read off the model's verdict and the case. */
const admittedFeatures = (
	c: UnionCase,
	v: Extract<ReturnType<typeof verdictOf>, { readonly kind: "admitted" }>
): ReadonlyArray<UnionFeature> => [
	...(v.groups === 1 ? ["one heading" as const] : []),
	...(v.chosen === "of Kind" ? ["several headings told apart by Kind" as const] : []),
	...(v.chosen === "of every literal column"
		? ["several headings told apart by every literal column" as const]
		: []),
	...(v.widened ? ["a widened column" as const] : []),
	...(Arr.some(c.arms, (a) => a.attached) ? ["an attached arm admitted" as const] : []),
	...((c.consumer.kind === "ordered" || c.consumer.kind === "taken") && v.groups > 1
		? ["a keyed order over several headings" as const]
		: []),
	...(v.narrowed ? ["a match narrowed to some arms" as const] : []),
	...(v.chosen === "of Kind" && Arr.contains(v.heading, "marks")
		? ["a set column beside a discriminant of Kind" as const]
		: [])
]

describe("a union of rules", () => {
	it.effect(
		"is grouped by heading, typed per column, told apart by its discriminant, ordered only within a key and narrowed by a match's constants, as the model of its rules decides",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/check/unions",
						draw: drawn(unionCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the union rules restated over the drawn arms (test/unit/check/unions.ts)"
						},
						coverage: required<UnionFeature>(
							[
								...rules,
								"one heading",
								"several headings told apart by Kind",
								"several headings told apart by every literal column",
								"a widened column",
								"an attached arm admitted",
								"a keyed order over several headings",
								"a match narrowed to some arms",
								"a set column beside a discriminant of Kind"
							],
							{ cases: 1200, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const v = verdictOf(c)
							const result = checkAuthored(
								checking(schemaDescOf(c.schema)),
								caseDesc(c),
								checkOptions("unions")
							)
							if (v.kind === "refused") {
								k.note(v.rule)
								refused(result, v.reason, v.rule)
								return
							}
							k.noteAll(admittedFeatures(c, v))
							const q = succeeded(result, "the union the model admits")
							if (c.consumer.kind === "matched" || c.arms.length === 1) {
								return
							}
							const union = Arr.findFirst(topoOrder(q.dag), (n) => n.kind === "Union")
							assert.deepEqual(
								Option.match(union, {
									onNone: () => ({ groups: 1, discriminant: [] }),
									onSome: (n) => ({ groups: n.groups.length, discriminant: n.discriminant })
								}),
								{ groups: v.groups, discriminant: v.discriminant },
								"the union's heading groups and discriminant"
							)
						})
				)
			)
	)
})
