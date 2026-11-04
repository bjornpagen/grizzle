import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { AnchorPair, FamilyLaw, ResidualFamily } from "#compiler/ir/law.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { Expr, PlDeclaration, PlStatement } from "#compiler/sql/ast.ts"

/** The variables a family may declare: each family's records and its cover, never the skeleton's key record `k`, so
 * a family's declarations and the skeleton's share one DECLARE block without a clash. */
export type FamilyVariable = "cover" | "g" | "p" | "t" | "w"

/** A family's declaration of one of its variables. */
export interface FamilyDeclaration extends PlDeclaration {
	readonly name: FamilyVariable
}

/** Where a residual law is installed, as its units are emitted: its schema, the installation's names its literals are
 * typed by, and whether a violation of a relation reports its keys (`witnessShown`): the role holds it whole. */
export interface FamilyAt {
	/** The PostgreSQL schema identifier the law is installed in. */
	readonly schema: string
	readonly names: PhysicalNames
	readonly shown: (relation: string) => Expr
}

interface FamilyInput<F extends ResidualFamily> extends FamilyAt {
	readonly law: FamilyLaw<F>
}

/** One component of an affected key: its family's pairing at the anchor-key field (ir/law.ts KeyComponent), and the
 * expression that holds its value. */
export interface KeyValue {
	readonly pair: AnchorPair
	readonly value: Expr
}

/** One participating relation's steps 2 and 3, which the function of each of its event units runs after that event's
 * step 1: the variables it declares, and the check for one affected key, re-checking only what that relation's writes
 * can break. */
export interface FamilyUnit {
	/** The variables steps 2 and 3 use, declared once in each of the relation's unit functions. */
	readonly declare: ReadonlyArray<FamilyDeclaration>
	/** Steps 2 and 3 for one affected key, one component per anchor-key field in anchor-key order (step 1's output):
	 * read the anchor rows, then probe and raise with the law's identity and a DetailCodec DETAIL when what the
	 * relation's writes can break is violated. */
	readonly check: (key: NonEmptyReadonlyArray<KeyValue>) => ReadonlyArray<PlStatement>
}

/** The residual-family plug-in contract. Every residual law function has the same three steps: take the affected keys
 * from its event's row images, read the law's anchor rows for those keys, and evaluate what the event can break for
 * them, raising with the law's stable identity and a DetailCodec DETAIL. The residual skeleton owns step 1 and the
 * function and trigger DDL around it, one function per participating relation and event; a family owns steps 2 and 3
 * for one affected anchor key of one participating relation, because its anchor, its absent-anchor rule and its
 * violation probe are what distinguish it. A family reads the detail its law carries (`ResidualLaw`) once, and for
 * each participant returns the variables it declares with the statements for one affected key; the skeleton hands it
 * each affected key as the PL/pgSQL expressions that hold it, in the order of the law's anchor key, each with its
 * family's pairing at that field, and splices the statements into each of the participant's unit functions. A family
 * refuses by throwing a Refusal, which the skeleton returns. */
export type FamilyPlugin<F extends ResidualFamily> = (
	input: FamilyInput<F>
) => (participant: FamilyLaw<F>["participants"][number]) => FamilyUnit
