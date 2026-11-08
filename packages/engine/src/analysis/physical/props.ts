import type {
	Dependencies,
	Identification,
	Justification,
	JustifiedKey
} from "#compiler/analysis/physical/fds.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Cardinality } from "#compiler/ir/cardinality.ts"
import type { ElisionReason } from "#compiler/ir/certificate.ts"
import type { RelKind } from "#compiler/ir/rel.ts"
import type { Fixed } from "#compiler/logical/props.ts"

/**
 * How a node's semantic set boundary is realized: by its plain SQL form, or by an exact duplicate-
 * eliminating operator over its complete heading (SELECT DISTINCT, set UNION, INTERSECT, EXCEPT, recursive UNION).
 */
export type Realization = "plain" | "distinct"

/**
 * A column fixed per evaluation of the fragment. When its justification names outer columns (fds.ts Justification
 * outer), it is fixed only per row of those outer nodes, and the scope that binds them sees a dependency instead.
 */
export interface FixedFact {
	readonly fixed: Fixed
	readonly just: Justification
}

/**
 * What a fixed column is fixed to: every value a fact names, each with its justification, which are one value per
 * evaluation wherever the fragment has a row, whatever order the facts are found in; the first is the one its first
 * fixing named, which its fixing rests on. A column only computations fix holds the one fact that names no value.
 */
export type FixedFacts = NonEmptyReadonlyArray<FixedFact>

/**
 * Whether the fragment is proved unique, and by what: its plain form, without its own duplicate elimination, by the key
 * that proves it (under a `distinct` realization that DISTINCT is then redundant); only its own duplicate
 * elimination; or nothing. A plain form proved unique makes the fragment unique whatever its realization.
 */
export type Uniqueness =
	| {
			readonly kind: "plain"
			readonly key: JustifiedKey
			/** The most specific evidence the key's proof cites that an elision rule names. */
			readonly lead: ElisionReason
	  }
	| { readonly kind: "realized" }
	| { readonly kind: "none" }

/**
 * The physical properties of one fragment.
 *
 * They describe what the fragment's SQL actually delivers under its realization, not the set its logical node
 * promises: the dependencies among its columns with their justifications, its identifications of a row among them
 * (fds.ts Dependencies), the columns fixed per evaluation, the maximum cardinality where known, and, when its heading
 * identifies no row, why not. They are kept apart from NodeMeta's logical keys and from cardinality estimates: a
 * ProjectSet that collapses equal outputs logically still repeats them physically until something deduplicates it.
 *
 * No key is listed: a key is a start whose closure holds the row, asked of the table (keyedBy, keyAmong), since the
 * minimal keys of a table can be exponentially many.
 */
export interface PhysicalProps {
	readonly node: NodeId
	readonly kind: RelKind
	readonly columns: ReadonlyArray<string>
	/** What the fragment's rows determine as realized: its own exact duplicate elimination's identification included. */
	readonly dependencies: Dependencies
	/**
	 * What the fragment's rows determine without the node's own duplicate elimination: under a `plain` realization,
	 * the same table. A proof that the node's DISTINCT is redundant may use only this, never the DISTINCT itself.
	 */
	readonly plain: Dependencies
	readonly fixed: ReadonlyMap<string, FixedFacts>
	/** The most rows the fragment can have. */
	readonly maxCard: Cardinality
	readonly uniqueness: Uniqueness
	readonly realization: Realization
}

/** Whether the fragment's whole heading identifies a row physically. */
export const isUnique = (props: PhysicalProps): boolean => props.uniqueness.kind !== "none"

/**
 * Whether `columns` identify a row of the fragment: then the fragment has at most one row per value of `columns`
 * ("K determines B ... exactly one contribution for each B"), on what, and the canonical minimal key among them.
 */
export const keyedBy = (
	props: PhysicalProps,
	columns: Iterable<string>
): Identification | undefined => props.dependencies.identification(columns)

/**
 * Whether `columns` identify a row without the fragment's own duplicate elimination: then removing that elimination
 * still leaves at most one row per value of `columns`.
 */
export const plainKeyedBy = (
	props: PhysicalProps,
	columns: Iterable<string>
): Identification | undefined => props.plain.identification(columns)

/**
 * The canonical minimal key of the fragment among `columns`, with its proof, when they identify a row (fds.ts
 * Dependencies keyAmong): the one key a consumer that needs a key reads, never a list of every key.
 */
export const keyAmong = (
	props: PhysicalProps,
	columns: Iterable<string>
): JustifiedKey | undefined => props.dependencies.keyAmong(columns)
