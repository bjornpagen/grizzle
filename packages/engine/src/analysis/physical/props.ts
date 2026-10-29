import type { MultiplicityReason } from "#compiler/analysis/certificates/reasons.ts"
import {
	type Identification,
	type Identity,
	type Implication,
	type Justification,
	type JustifiedKey,
	ProofFds
} from "#compiler/analysis/physical/fds.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Cardinality } from "#compiler/ir/cardinality.ts"
import type { ElisionReason } from "#compiler/ir/certificate.ts"
import { lessDemanding } from "#compiler/ir/evidence.ts"
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

export interface Loss {
	readonly reason: MultiplicityReason
	/** A constant phrase naming what was lost; never a value. */
	readonly detail: string
}

/**
 * Whether the fragment is proved unique, and by what: its plain form, without its own duplicate elimination, by the key
 * that proves it (under a `distinct` realization that DISTINCT is then redundant); only its own duplicate
 * elimination, its plain form not being unique for `losses`; or nothing, for `losses`. A plain form proved unique makes
 * the fragment unique whatever its realization.
 */
export type Uniqueness =
	| {
			readonly kind: "plain"
			readonly key: JustifiedKey
			/** The most specific evidence the key's proof cites that an elision rule names. */
			readonly lead: ElisionReason
	  }
	| { readonly kind: "realized"; readonly losses: NonEmptyReadonlyArray<Loss> }
	| { readonly kind: "none"; readonly losses: NonEmptyReadonlyArray<Loss> }

/**
 * The physical properties of one fragment.
 *
 * They describe what the fragment's SQL actually delivers under its realization, not the set its logical node
 * promises: the physical candidate keys with their justifications, the columns fixed per evaluation, the dependencies
 * among its columns, the maximum cardinality where known, and, when no key proves the whole heading, why not. They are
 * kept apart from NodeMeta's logical keys and from cardinality estimates: a ProjectSet that collapses
 * equal outputs logically still repeats them physically until something deduplicates it.
 */
export interface PhysicalProps {
	readonly node: NodeId
	readonly kind: RelKind
	readonly columns: ReadonlyArray<string>
	readonly keys: ReadonlyArray<JustifiedKey>
	/**
	 * The keys proved without the node's own duplicate elimination: under a `plain` realization, the keys themselves.
	 * A proof that the node's DISTINCT is redundant may use only these, never the DISTINCT itself.
	 */
	readonly plainKeys: ReadonlyArray<JustifiedKey>
	readonly fixed: ReadonlyMap<string, FixedFact>
	/** Dependencies among the columns, equalities included (both directions), bounded (fds.ts dependencyBound). */
	readonly fds: ReadonlyArray<Implication>
	/** The most rows the fragment can have. */
	readonly maxCard: Cardinality
	readonly uniqueness: Uniqueness
	readonly realization: Realization
}

/** Whether some key proves the fragment's whole heading physically unique. */
export const isUnique = (props: PhysicalProps): boolean => props.uniqueness.kind !== "none"

/**
 * The key whose proof holds in the least demanding evidence context, the first among equals, if any: the strongest
 * proof of uniqueness, so a claim never rests on a deferrable key where an immediate one proves it.
 */
export const strongestKey = (keys: ReadonlyArray<JustifiedKey>): JustifiedKey | undefined =>
	keys.reduce<JustifiedKey | undefined>(
		(best, k) =>
			best === undefined || lessDemanding(k.just.context, best.just.context) ? k : best,
		undefined
	)

/** Why the fragment's plain form is not unique: none when it is. */
export const plainLosses = (props: PhysicalProps): ReadonlyArray<Loss> =>
	props.uniqueness.kind === "plain" ? [] : props.uniqueness.losses

/** A ProofFds over a fragment's columns carrying its fixed columns and dependencies. */
export const fdsOf = (props: PhysicalProps): ProofFds => {
	const fds = new ProofFds(props.columns)
	for (const [c, f] of props.fixed) {
		fds.fix(c, f.just)
	}
	for (const imp of props.fds) {
		fds.implyAt(imp.from, imp.at, imp.to, imp.just)
	}
	return fds
}

/** The identity a fragment's keys give its own columns: any one key. */
export const keyIdentity = (props: PhysicalProps): Identity =>
	props.keys.length === 0 ? [] : [[props.keys.map((k) => ({ columns: k.columns, just: k.just }))]]

/**
 * Whether `columns` determine a key of the fragment: then the fragment has at most one row per value of `columns`
 * ("K determines B ... exactly one contribution for each B"), and on what.
 */
export const keyedBy = (
	props: PhysicalProps,
	columns: Iterable<string>
): Identification | undefined => fdsOf(props).identifies(keyIdentity(props), columns)

/**
 * Whether `columns` determine a key proved without the fragment's own duplicate elimination: then removing that
 * elimination still leaves at most one row per value of `columns`.
 */
export const plainKeyedBy = (
	props: PhysicalProps,
	columns: Iterable<string>
): Identification | undefined =>
	fdsOf(props).identifies(keyIdentity({ ...props, keys: props.plainKeys }), columns)
