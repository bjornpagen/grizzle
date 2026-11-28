/** What the properties of admission.test.ts read: its spaces, models and helpers. */

import { Array as Arr } from "effect"
import type { QueryDesc, RuleDesc } from "#test/support/fixtures/ir/desc.ts"
import { idDesc } from "#test/support/ids.ts"
import {
	match,
	param,
	plainVar,
	ref,
	relationSource,
	rule,
	varRef,
	vars
} from "#test/support/unit/check/dsl.ts"

/** The pairs (a, b) of the transitive closure of Edge, and the arms beside the transitive one. */
export type Arm = "b repeating a" | "b fixed to a parameter"

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
				{ a: s("a"), b: arm === "b repeating a" ? s("a") : param("start", idDesc) }
			)
		],
		where: [],
		head: { a: s("a"), b: s("a") },
		interiors: [],
		attach: []
	})

export const pairs = (arms: ReadonlyArray<Arm>): QueryDesc => ({
	stage: {
		kind: "recursive",
		recursive: {
			name: "Pairs",
			row: { a: idDesc, b: idDesc },
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
