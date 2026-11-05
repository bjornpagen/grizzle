import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { subarray } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import type { QueryDesc, RuleDesc } from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import {
	match,
	param,
	plainVar,
	ref,
	relationSource,
	rule,
	varRef,
	vars
} from "#test/unit/check/dsl.ts"
import { Graph, lower, reads, theRecursive } from "#test/unit/recursion/fixtures.ts"

/**
 * Recursion admission factors several transition arms into one feedback scan, here over the arms that fix or repeat
 * a state column: the arm matching self with b fixed to a parameter, or with b repeating a, reads the current state
 * through equalities on it, beside the transitive arm, so the definition reads its feedback once and lowers. The
 * factoring of arms that read no self, of the reverse transition, of a negated fixed relation and of an importer's
 * parameters is unit/recursion/feedback-shape's; the state heading's casts are unit/recursion/state-heading's.
 */

const uuidField: FieldDesc = { kind: "uuid" }

/** The pairs (a, b) of the transitive closure of Edge, and the arms beside the transitive one. */
type Arm = "b repeating a" | "b fixed to a parameter"

const s = (column: string) => varRef(`self.${column}`)

const transitive: RuleDesc = rule({
	vars: [plainVar("self.a"), plainVar("self.b"), ...vars("Edge", "to")],
	matches: [
		match({ kind: "self" }, { a: s("a"), b: s("b") }),
		match(relationSource("Edge"), { from: s("b"), to: ref("Edge", "to") })
	],
	where: [],
	head: { a: s("a"), b: ref("Edge", "to") },
	interiors: [],
	attach: []
})

const armOf = (arm: Arm): RuleDesc =>
	rule({
		vars: [plainVar("self.a")],
		matches: [
			match(
				{ kind: "self" },
				{ a: s("a"), b: arm === "b repeating a" ? s("a") : param("start", uuidField) }
			)
		],
		where: [],
		head: { a: s("a"), b: s("a") },
		interiors: [],
		attach: []
	})

const pairs = (arms: ReadonlyArray<Arm>): QueryDesc => ({
	stage: {
		kind: "recursive",
		recursive: {
			name: "Pairs",
			row: { a: uuidField, b: uuidField },
			base: [
				rule({
					vars: vars("Edge", "from", "to"),
					matches: [
						match(relationSource("Edge"), { from: ref("Edge", "from"), to: ref("Edge", "to") })
					],
					where: [],
					head: { a: ref("Edge", "from"), b: ref("Edge", "to") },
					interiors: [],
					attach: []
				})
			],
			rec: [transitive, ...Arr.map(arms, armOf)]
		}
	}
})

describe("factoring transition arms into one feedback scan", () => {
	it.effect(
		"factors arms that fix or repeat state columns as equalities on the current state, one feedback read, and lowers them",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/recursion/factoring-equalities",
						generator: subarray<Arm>(["b repeating a", "b fixed to a parameter"]),
						literal: Formatter.format,
						limit: 4,
						coverage: requiredInSpace<Arm | "both">([
							"b repeating a",
							"b fixed to a parameter",
							"both"
						]),
						caseHang
					},
					(arms, c) =>
						Effect.sync(() => {
							c.noteAll(arms)
							if (arms.length === 2) {
								c.note("both")
							}
							const q = succeeded(checkQuery(checking(Graph), pairs(arms), checkOptions("query")))
							assert.equal(reads(q, theRecursive(q).self), 1, "one feedback read")
							assert.deepEqual(
								Arr.map(q.params, (p) => p.name),
								arms.includes("b fixed to a parameter") ? ["start"] : []
							)
							lower(q)
						})
				)
			)
	)
})
