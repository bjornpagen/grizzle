import type { ResidualLaw } from "#compiler/ir/law.ts"
import { alternativesFamily } from "#compiler/laws/families/alternatives/index.ts"
import { capacityFamily } from "#compiler/laws/families/capacity/index.ts"
import { coverageFamily } from "#compiler/laws/families/coverage/index.ts"
import { mirrorsFamily } from "#compiler/laws/families/mirrors/index.ts"
import type { FamilyBody } from "#compiler/laws/families/plugin.ts"
import { selectedSourceFamily } from "#compiler/laws/families/selected-source/index.ts"
import type { Expr } from "#compiler/sql/ast.ts"

/** The body of a residual law, from its family's plug-in; `shown` is whether a violation of a relation reports its keys.
 *
 * The residual-family dispatch: each admitted family to the plug-in directory that owns it: selected-source
 * containment, alternatives reverse, conditional mirrors, scalar-group capacity and selected-source coverage. This
 * dispatch is written once; a family's implementation lives in its directory and never edits this file. */
export const familyBody = (
	law: ResidualLaw,
	schema: string,
	shown: (relation: string) => Expr
): FamilyBody => {
	switch (law.family) {
		case "alternativesReverse":
			return alternativesFamily({ law, schema, shown })
		case "conditionalMirrors":
			return mirrorsFamily({ law, schema, shown })
		case "selectedSourceContainment":
			return selectedSourceFamily({ law, schema, shown })
		case "scalarCapacity":
			return capacityFamily({ law, schema, shown })
		case "selectedSourceCoverage":
			return coverageFamily({ law, schema, shown })
	}
}
