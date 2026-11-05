import { canonicalSortKeyed, everyProperty } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { NodeId, ParamId } from "#compiler/core/ids.ts"
import * as Result from "#compiler/core/result.ts"
import type { Grounds, Premise } from "#compiler/ir/evidence.ts"
import { type OpId, sortedOps, sortedUnique } from "#compiler/ir/expr.ts"
import type { Carrier } from "#compiler/ir/scalar.ts"

/**
 * A type, collation or coercion identity a proof depends on: a type by its label (scalar.ts typeLabel), a collation by
 * its qualified name, a native cast by its carriers, a coercion into a contract domain by the domain type's label, and an
 * index access method and operator class an approximate shape rests on.
 */
export type CoercionIdentity =
	| `type:${string}`
	| `collation:${string}`
	| `cast:${Carrier}->${Carrier}`
	| `domain:${string}`
	| `index:${string}`
	| `opclass:${string}`

/**
 * The evidence an elision certificate leads with: each multiplicity reason that explains an absent duplicate
 * elimination (analysis/certificates/reasons.ts classifies every reason).
 */
export type ElisionReason =
	| "retainedPrimaryKey"
	| "oneToOneJoin"
	| "combinedJoinKeys"
	| "groupedOutputKey"
	| "fixedKeyComponent"
	| "existentialObservation"
	| "globalRecursiveClosure"
	| "perParentAttachment"
	| "inheritedDerivedKey"
	| "deduplicatedInput"
	| "finiteFacts"
	| "exactDeduplication"
	| "atMostOneRow"
	| "disjointArms"
	| "injectiveRepresentation"
	| "uniqueOrdinal"

export type ElisionRule = `R17.elide.${ElisionReason}`

/**
 * The proofs physical multiplicity certifies (analysis/certificates/builder.ts), which the test kernel's verification
 * re-derives.
 */
export type MultiplicityRule =
	| "R02.existence"
	| "R17.contribution"
	| "R17.unionAll"
	| "R17.recursiveTerms"
	| "R17.placement"
	| ElisionRule

/** The rewrites of the optimizing passes (lower/optimize). */
type RewriteRule =
	| "R01.fusion"
	| "R02.semiJoin"
	| "R02.antiJoin"
	| "R03.elimination"
	| "R03.keyJoin"
	| "R06.lateFetch"
	| "R07.closedMembership"
	| "prune.heading"
	| "pushdown.project"
	| "pushdown.group"
	| "pushdown.union"
	| "pushdown.left"
	| "pushdown.source"
	| "pushdown.semiSource"
	| "pushdown.semiGroup"
	| "simplify.fold"
	| "simplify.finiteFold"
	| "simplify.empty"
	| "simplify.mergeFilters"
	| "simplify.mergeProjections"
	| "simplify.identityProjection"
	| "simplify.equality"
	| "simplify.allen"
	| "graph.seedPushdown.filter"
	| "graph.seedPushdown.constant"
	| "graph.seedPushdown.region"
	| "cte.notMaterialized"
	| "cte.materialized"
	| "cte.recursive"

/** The catalog's rewrites of aggregate and window shapes (lower/shapes/catalog). */
export type CatalogRule = "R26" | "R27" | "R28" | "R29" | "R30" | "R31" | "R41" | "R42"

/** The shape choices that rest on a proof (lower/shapes). */
type ShapeRule =
	| "R20.lateral"
	| "R20.distinctOn"
	| "R20.rowNumber"
	| "R24.conditionalCount"
	| "approximateNearest.indexed"
	| "approximateNearest.deduplicated"

/**
 * Every rule a certificate may name. The vocabulary is closed: a rule outside it is unrepresentable, so a dispatch over
 * rules is exhaustive.
 */
export type CertificateRule = MultiplicityRule | RewriteRule | CatalogRule | ShapeRule

/**
 * Rewrite certificates.
 *
 * Every nontrivial rewrite stores a compact internal certificate: the rule, the input and output nodes, the premises
 * used, the context it requires and the heading it preserves; its constraint premises name the installed constraints
 * its proof rests on. A certificate is an inspectable diagnostic and an input to the test kernel's verification, not a mechanized proof. The conservative lowering, which runs no pass, records none.
 *
 * Construction canonicalizes every set-valued field, so two certificates for the same rewrite are byte-identical
 * whatever order their premises were found in.
 */
export interface Certificate<Rule extends CertificateRule = CertificateRule> extends Grounds {
	readonly rule: Rule
	readonly inputs: ReadonlyArray<NodeId>
	readonly outputs: ReadonlyArray<NodeId>
	readonly preservedHeading: ReadonlyArray<string>
	/** The native equality operators the proof uses. */
	readonly equality: ReadonlyArray<OpId>
	/** The type and coercion identities the proof depends on, sorted and distinct; empty when it depends on none. */
	readonly coercion: ReadonlyArray<CoercionIdentity>
	/** Parameter assumptions, such as a fixed key component, when it makes any. */
	readonly params: ReadonlyArray<ParamId> | undefined
}

export const makeCertificate = <Rule extends CertificateRule>(
	input: Certificate<Rule>
): Result.Result<Certificate<Rule>, CompileError> =>
	Result.map(canonicalSortKeyed(input.premises, everyProperty), (sorted) => {
		/**
		 * Equal premises have equal canonical texts, adjacent once sorted. Each premise is frozen in place (its type is
		 * readonly already), so the certificate is frozen throughout.
		 */
		const premises: ReadonlyArray<Premise> = sorted
			.filter(({ text }, i) => text !== sorted[i - 1]?.text)
			.map(({ item }) => Object.freeze(item))
		const cert: Certificate<Rule> = {
			rule: input.rule,
			inputs: sortedUnique(input.inputs),
			outputs: sortedUnique(input.outputs),
			premises: Object.freeze(premises),
			context: input.context,
			preservedHeading: sortedUnique(input.preservedHeading),
			equality: sortedOps(input.equality),
			coercion: sortedUnique(input.coercion),
			params: input.params === undefined ? undefined : sortedUnique(input.params)
		}
		return Object.freeze(cert)
	})
