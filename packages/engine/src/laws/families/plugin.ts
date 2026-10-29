import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { AnchorPair, FamilyLaw, ResidualFamily } from "#compiler/ir/law.ts"
import type { Expr, PlDeclaration, PlStatement } from "#compiler/sql/ast.ts"

/** The variables a family may declare: each family's records and its cover, never the skeleton's key record `k`, so
 * a family's declarations and the skeleton's share one DECLARE block without a clash. */
export type FamilyVariable = "cover" | "g" | "p" | "t" | "w"

/** A family's declaration of one of its variables. */
export interface FamilyDeclaration extends PlDeclaration {
	readonly name: FamilyVariable
}

interface FamilyInput<F extends ResidualFamily> {
	readonly law: FamilyLaw<F>
	/** The PostgreSQL schema identifier the law is installed in. */
	readonly schema: string
	/** Whether a violation of a relation reports its keys (`witnessShown`): the role holds it whole. */
	readonly shown: (relation: string) => Expr
}

/** One component of an affected key: its family's pairing at the anchor-key field (ir/law.ts KeyComponent), and the
 * expression that holds its value. */
export interface KeyValue {
	readonly pair: AnchorPair
	readonly value: Expr
}

export interface FamilyBody {
	/** The variables steps 2 and 3 use, declared once in the function. */
	readonly declare: ReadonlyArray<FamilyDeclaration>
	/** Steps 2 and 3 for one affected key, one component per anchor-key field in anchor-key order (step 1's output):
	 * read the anchor rows, then probe and raise with the law's identity and a DetailCodec DETAIL when the violation
	 * query is not empty. */
	readonly check: (key: NonEmptyReadonlyArray<KeyValue>) => ReadonlyArray<PlStatement>
}

/** The residual-family plug-in contract. Every residual law function has the same three steps: take the affected keys from the event's row images, read the
 * law's anchor rows for those keys, and evaluate the violation query for them, raising with the law's stable identity
 * and a DetailCodec DETAIL. The residual skeleton owns step 1 and the function and trigger DDL around
 * it; a family owns steps 2 and 3 for one affected anchor key, because its anchor, its absent-anchor rule
 * and its violation probe are what distinguish it. A family reads the detail its law
 * carries (`ResidualLaw`) once, and returns the variables it declares with the statements for one affected
 * key; the skeleton hands it each affected key as the PL/pgSQL expressions that hold it, in the order of the law's
 * anchor key, each with its family's pairing at that field, and splices the statements into the function body. A family refuses by throwing a Refusal, which the skeleton
 * returns. */
export type FamilyPlugin<F extends ResidualFamily> = (input: FamilyInput<F>) => FamilyBody
