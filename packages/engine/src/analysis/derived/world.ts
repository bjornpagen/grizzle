import {
	type DeclaredColumn,
	declaredHeading,
	spineObstacle
} from "#compiler/analysis/derived/analyze.ts"
import { type InheritedKey, inheritedKeys } from "#compiler/analysis/logical/derived.ts"
import { type AdmittedQuery, checkDefinition } from "#compiler/check/index.ts"
import type { SchemaReading } from "#compiler/check/schema.ts"
import { compareText } from "#compiler/core/canonical.ts"
import { type CompileError, derivedRefused } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import { classMembers, type ViewRead, viewAlternatives } from "#compiler/ir/keys.ts"
import { analyzeLogical, queryEvidence } from "#compiler/logical/annotate.ts"
import type { WholeKey } from "#compiler/logical/props.ts"

/** A query entry of a role, as the role's Description records it. */
export interface WorldEntry {
	readonly name: string
	readonly query: QueryDesc
	readonly loc: SourceLoc
}

export interface WorldAnalysis {
	readonly name: string
	readonly loc: SourceLoc
	/** The checked definition, annotated with the base's derived keys. */
	readonly query: AdmittedQuery
	/** The definition's heading: the view's columns, in canonical order, each a declared name of the view. */
	readonly heading: NonEmptyReadonlyArray<DeclaredColumn>
	/** The keys, narrowest first, each with its proof; the first is the primary one. */
	readonly keys: NonEmptyReadonlyArray<InheritedKey<DeclaredColumn>>
	/** The relations of the base the definition reads, sorted. */
	readonly reads: ReadonlyArray<string>
	/** The contexts the definition matches, by declared name, sorted. */
	readonly contexts: ReadonlyArray<string>
	/** The view as a Base over it reads it: the definition's heading and its keys, each resting on the definition's
	 * proof, which the checker stamps on every Base over it. */
	readonly read: ViewRead
}

/** The whole heading as the one key of a definition of one heading group; undefined for several groups. */
const wholeHeadingKey = (
	whole: WholeKey,
	heading: NonEmptyReadonlyArray<DeclaredColumn>
): NonEmptyReadonlyArray<InheritedKey<DeclaredColumn>> | undefined =>
	whole.kind === "set" ? [{ columns: heading, proof: whole.key }] : undefined

/**
 * The analysis of one query entry over its base's checked schema.
 *
 * World relation analysis: a role's query entry, checked over its base, with its heading and its keys.
 *
 * A query entry is a definition, as a derived relation's is (analyze.ts), installed as a plain view in the role's
 * schema instead of a materialized one (physical/ddl/roles.ts). A role's checked schema analyzes each of its query
 * entries when it is built (analysis/schema.ts): analyzeWorld checks the definition over the base's checked schema, where
 * it may match a context, annotates it under the evidence that keys each Base over a derived relation by its view's
 * keys (logical/annotate.ts queryEvidence), and reads:
 *
 * - its heading, the view's columns in canonical order;
 * - its keys: the root's minimal candidate keys (analysis/logical/derived.ts inheritedKeys), narrowest first, or the
 *   whole heading when nothing narrower is proven, since a query is a set. A view's keys rest on its definition's
 *   evidence and no index states them, so no key is refused for its B-tree entry, and a definition of at most one
 *   fact is keyed by its first column;
 * - what it reads: the stored, closed and derived relations of the base its Bases and Closed sources name, and the
 *   contexts it matches;
 * - the view as a Base over it reads it (`read`): its heading and its keys.
 *
 * It refuses, at the entry's location, a definition whose delivered rows carry an attachment or are a union of several
 * heading groups, and one with an empty heading (UnsupportedOperation), exactly as a derived relation's: a view has one
 * flat heading of at least one column; and, at its field, a heading name the declared-name rule refuses
 * (MalformedDescription) or two that convert to one column (IdentifierCollision), as a derived relation's
 * (analyze.ts declaredHeading). What role admission refuses before (a parameter, an attachment on the
 * definition's own heading, an approximate search, a relation outside the base) is schema/world.ts's. A world view
 * evaluates its own expressions on facts outside the world, which is safe because no expression raises
 * (scalar/compute/registry.ts Totality).
 */
export const analyzeWorld = (
	base: SchemaReading,
	entry: WorldEntry
): Result.Result<WorldAnalysis, CompileError> => {
	const checkedResult = checkDefinition(base, `world ${entry.name}`, entry.query)
	if (!checkedResult.ok) {
		return checkedResult
	}
	const checked = checkedResult.value
	const root = checked.dag.roots[0]
	const obstacle = spineObstacle(root)
	if (obstacle !== undefined) {
		return Result.err(derivedRefused(entry.loc, { kind: obstacle, relation: entry.name }))
	}
	const analyzedResult = analyzeLogical(checked.dag, queryEvidence)
	if (!analyzedResult.ok) {
		return analyzedResult
	}
	const analyzed = analyzedResult.value
	const heading = root.heading
	if (!isNonEmpty(heading)) {
		return Result.err(
			derivedRefused(entry.loc, {
				kind: "emptyHeading",
				relation: entry.name
			})
		)
	}
	const declared = declaredHeading(entry.name, heading, entry.loc)
	if (!declared.ok) {
		return declared
	}
	const { props } = analyzed.of(root)
	const inherited = inheritedKeys(declared.value, props.keys, props.prove, () => true)
	/** A definition of one heading group is a set, so its whole heading is always a key. */
	const keys = isNonEmpty(inherited) ? inherited : wholeHeadingKey(props.whole(), declared.value)
	if (keys === undefined) {
		return Result.err(derivedRefused(entry.loc, { kind: "headingGroups", relation: entry.name }))
	}
	const reads = new Set<string>()
	const contexts = new Set<string>()
	for (const node of topoOrder(analyzed.dag)) {
		if (node.kind === "Base") {
			reads.add(node.relation)
		}
		if (node.kind === "Closed") {
			reads.add(node.closed)
		}
		if (node.kind === "Context") {
			contexts.add(node.context)
		}
	}
	return Result.ok({
		name: entry.name,
		loc: entry.loc,
		query: { ...checked, dag: analyzed.dag },
		heading: declared.value,
		keys,
		reads: [...reads].toSorted(compareText),
		contexts: [...contexts].toSorted(compareText),
		read: {
			heading,
			keys: keys.map((k) => ({
				fields: mapNonEmpty(k.columns, (c) => c.name),
				premises: k.proof.premises,
				context: k.proof.context,
				members: classMembers(k.proof),
				alternatives: viewAlternatives(k.proof)
			}))
		}
	})
}
