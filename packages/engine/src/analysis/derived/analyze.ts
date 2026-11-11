import { inferredFields } from "#compiler/analysis/derived/fields.ts"
import {
	type DerivedKeyLayout,
	derivedKeyLayout,
	oneColumnKeyRepresentable
} from "#compiler/analysis/derived/keys.ts"
import { inheritedKeys } from "#compiler/analysis/logical/derived.ts"
import { type AdmittedQuery, checkDefinition } from "#compiler/check/index.ts"
import type { SchemaReading } from "#compiler/check/schema.ts"
import { appendAll } from "#compiler/core/array.ts"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, derivedRefused, refused } from "#compiler/core/errors.ts"
import {
	type DeclaredName,
	DeclaredNamespace,
	identifierOf,
	identity
} from "#compiler/core/identity.ts"
import type { ConstraintName, RelationIdent } from "#compiler/core/ids.ts"
import { labeledChildLoc, type SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { InferredFieldDesc, QueryDesc } from "#compiler/ir/desc.ts"
import {
	classMembers,
	type KeyProof,
	type ViewKey,
	type ViewRead,
	viewAlternatives
} from "#compiler/ir/keys.ts"
import {
	type Card,
	type HeadingColumn,
	keptRowsOf,
	type RelNode,
	type Rooted
} from "#compiler/ir/rel.ts"
import { analyzeLogical, type LogicalAnalysis, queryEvidence } from "#compiler/logical/annotate.ts"
import { derivedKeyPremise } from "#compiler/logical/props.ts"
import type { OwnedRelation, OwnedView } from "#compiler/schema/own.ts"

export interface DerivedRelationAnalysis {
	readonly name: string
	/** Its materialized view's identifier, ownership's. */
	readonly ident: RelationIdent
	/** The derived level: 1 over base relations, n + 1 over a level-n derived relation. */
	readonly level: number
	/** The stored, closed and derived relations the definition reads, sorted. */
	readonly reads: ReadonlyArray<string>
	readonly loc: SourceLoc
	/** The checked definition, annotated with the lower levels' inherited keys. */
	readonly query: AdmittedQuery
	/** The definition's heading: the relation's columns, in canonical order, at least one (an empty heading is
	 * refused), each a declared name of the view (`declaredHeading`) with its inferred field descriptor. */
	readonly heading: NonEmptyReadonlyArray<DerivedColumn>
	/** The inherited keys, narrowest first, each with its unique index's B-tree layout and name. */
	readonly keys: ReadonlyArray<DerivedKey>
	/** Whether the one key is the whole heading because nothing narrower is proven. */
	readonly wholeHeading: boolean
	/** The definition's cardinality: at most one fact for an aggregate over no group key. */
	readonly card: Card
	/** The view as a Base over it reads it: the definition's heading and the inherited keys, each resting on its unique
	 * index, which the checker stamps on every Base over it. */
	readonly read: ViewRead
}

/**
 * An inherited key with its unique index's B-tree layout, its name, which the naming door gives the view's key over
 * its fields (core/identity.ts derivedKey), and the proof the definition gives it: the one name every reader gives the
 * view's key index, and what the index rests on, which the snapshot records.
 */
interface DerivedKey extends DerivedKeyLayout {
	readonly index: ConstraintName
	readonly proof: KeyProof
}

/**
 * A derived relation's inherited keys as a Base over its view reads them: each resting on its view's unique index, with
 * the columns its definition makes equal to its fields.
 */
const viewKeysOf = (relation: string, keys: ReadonlyArray<DerivedKey>): ReadonlyArray<ViewKey> =>
	keys.map((k) => ({
		fields: k.fields,
		premises: [derivedKeyPremise(relation, k.fields)],
		context: "immediate",
		members: classMembers(k.proof),
		alternatives: viewAlternatives(k.proof)
	}))

/** A derived relation as ownership resolved it. */
type OwnedDerived = Extract<OwnedRelation, { readonly kind: "derived" }>
/** A materialized derived relation's view, which its analysis names its rows by. */
type MaterializedView = Extract<OwnedView, { readonly kind: "materialized" }>

/** What a materialized view's definition cannot have on its delivered rows. */
type Obstacle = "attachment" | "headingGroups"

/**
 * Each obstacle's refusal of a definition of `relation` at `at`: an attachment, a derived refusal of its own; a union of
 * several heading groups, a rule the types name too.
 */
const obstacleRefusals: {
	readonly [O in Obstacle]: (at: SourceLoc, relation: string) => CompileError
} = {
	attachment: (at, relation) => derivedRefused(at, { kind: "attachment", relation }),
	headingGroups: (at) =>
		refused(
			at,
			"a derived definition has one heading: a materialized view stores one heading group"
		)
}

/**
 * The first attachment, or union of several heading groups, on the delivered rows of `root`: the spine of nodes whose
 * rows are their input's rows under the same heading (rel.ts keptRowsOf, the spine lower/conservative/deliver.ts
 * delivers), and every arm of a union of one heading group. An attachment off the spine is read as its parent, whose
 * heading is the consumer's, so it changes nothing the view stores.
 */
const spineObstacle = (root: RelNode): Obstacle | undefined => {
	const seen = new Set<RelNode>()
	const queue: Array<RelNode> = [root]
	for (let node = queue.pop(); node !== undefined; node = queue.pop()) {
		if (seen.has(node)) {
			continue
		}
		seen.add(node)
		if (node.kind === "Attach") {
			return "attachment"
		}
		if (node.kind === "Union" && node.groups.length > 1) {
			return "headingGroups"
		}
		if (node.kind === "Union") {
			appendAll(
				queue,
				node.groups.flatMap((g) => g.arms)
			)
		}
		const kept = keptRowsOf(node)
		if (kept !== undefined) {
			queue.push(kept.input)
		}
	}
	return undefined
}

/** A column of a view's heading whose name is a declared name of the view, its column's. */
export type DeclaredColumn = HeadingColumn & { readonly name: DeclaredName }

/** A column of a derived relation's heading, with its inferred field descriptor. */
export type DerivedColumn = DeclaredColumn & { readonly desc: InferredFieldDesc }

/**
 * A view's heading declared into its namespace of columns (core/identity.ts DeclaredNamespace): a derived relation's or
 * a role query entry's fields are declared names, each its view column's identifier, so a name the rule refuses
 * (MalformedDescription) and two that convert alike (IdentifierCollision) are refused, each at its field of `relation`.
 */
const declaredHeading = (
	relation: string,
	heading: NonEmptyReadonlyArray<HeadingColumn>,
	loc: SourceLoc
): Result.Result<NonEmptyReadonlyArray<DeclaredColumn>, CompileError> =>
	catchRefusal(() => {
		const columns = new DeclaredNamespace(`relation ${relation}'s field`)
		return mapNonEmpty(heading, (c): DeclaredColumn => {
			const name = columns.declare(
				c.name,
				"field",
				labeledChildLoc(loc, c.name, `field ${relation}.${c.name}`)
			)
			if (!name.ok) {
				throw new Refusal(name.error)
			}
			return { ...c, name: name.value }
		})
	})

/** A definition checked and analyzed, its rows one heading of declared names. */
export interface AnalyzedDefinition {
	readonly checked: AdmittedQuery
	readonly root: RelNode
	readonly analyzed: LogicalAnalysis<Rooted>
	readonly heading: NonEmptyReadonlyArray<HeadingColumn>
	readonly declared: NonEmptyReadonlyArray<DeclaredColumn>
}

/**
 * The definition `query` of the relation `relation` (a derived relation's or a world entry's, `label` naming it to the
 * checker), refused at `at` where its delivered rows carry an attachment or several heading groups (spineObstacle) or
 * its heading is empty: checked, analyzed under the evidence a view's keys give (queryEvidence), and its heading
 * declared (declaredHeading).
 */
export const analyzedDefinition = (
	schema: SchemaReading,
	label: string,
	query: QueryDesc,
	relation: string,
	at: SourceLoc
): Result.Result<AnalyzedDefinition, CompileError> => {
	const checkedResult = checkDefinition(schema, label, query)
	if (!checkedResult.ok) {
		return checkedResult
	}
	const checked = checkedResult.value
	const root = checked.dag.roots[0]
	const obstacle = spineObstacle(root)
	if (obstacle !== undefined) {
		return Result.err(obstacleRefusals[obstacle](at, relation))
	}
	const analyzed = analyzeLogical(checked.dag, queryEvidence)
	if (!analyzed.ok) {
		return analyzed
	}
	const heading = root.heading
	if (!isNonEmpty(heading)) {
		return Result.err(refused(at, "a derived definition has at least one field"))
	}
	return Result.map(declaredHeading(relation, heading, at), (declared) => ({
		checked,
		root,
		analyzed: analyzed.value,
		heading,
		declared
	}))
}

/**
 * One derived relation of a checked schema, analyzed against the relations it holds so far, or the first refusal.
 *
 * Derived relation analysis: each definition checked, its fields inferred and its keys inherited.
 *
 * A derived relation is a stored query. The checked schema analyzes its derived relations in level order when it is
 * built (analysis/schema.ts), so a definition that reads a lower level sees that level's inherited keys, stamped on each
 * Base over it, and the analysis records:
 *
 * - its checked definition (check/), a parameterless Query over the levels below it whose root is one heading group:
 *   ownership refuses a parameter and a definition over its own level or above, and the analysis a heterogeneous
 *   union (below).
 *   The definition is annotated under the evidence that keys a Base over a view by its stamped keys
 *   (logical/annotate.ts queryEvidence), so a Base over a lower derived relation is keyed as its unique indexes are;
 * - its heading and the inferred field descriptor of each column (fields.ts);
 * - its inherited keys: the root's minimal candidate keys, each in heading order, narrowest first and then by heading
 *   position, none implied by a narrower one, or the whole heading when nothing narrower is proven
 *   (analysis/logical/derived.ts inheritedKeys), each passing
 *   the B-tree representability check of its unique index (keys.ts). A definition of at most one fact proves the
 *   empty key, so its one key is its first representable column in heading order, never the whole heading;
 * - the view as a Base over it reads it (`read`): the definition's heading and the inherited keys.
 *
 * It refuses, each at the derived relation's location:
 *
 * - an attachment on the definition's delivered rows (UnsupportedOperation, attachment): an attached relation is a
 *   nested set per fact, and a materialized view stores flat facts, so the heading the view would hold is not the
 *   query's;
 * - a union of several heading groups as the definition (Refused, as the types refuse it): a view has one heading,
 *   and a union of different headings is delivered one statement per group;
 * - a definition with an empty heading (Refused, as the types refuse it): its relation is the unit relation, true or
 *   false, and a unique index, which REFRESH MATERIALIZED VIEW CONCURRENTLY needs, has at least one column;
 * - a heading whose names are no declared names of one view (`declaredHeading`): a name the declared-name rule refuses
 *   (MalformedDescription), or two that convert to one column (IdentifierCollision), each at its field;
 * - an inherited key, or the full-heading fallback, whose unique index entry can exceed PostgreSQL's B-tree limit
 *   (UnrepresentableKey: inheritedKey, wholeHeading, oneFact).
 *
 * Definitions outside the levels below (MalformedDescription) are refused by ownership (schema/own.ts), before any
 * definition is read. A rule over a derived relation reads its definition live, never its view
 * (analysis/theory/query.ts).
 *
 * Derived relations: field inference and key inheritance. The keys a query over a derived relation relies on are the
 * same ones (ir/rel.ts ViewBase view).
 */
export const analyzeDerivedRelation = (
	schema: SchemaReading,
	owned: OwnedDerived,
	view: MaterializedView
): Result.Result<DerivedRelationAnalysis, CompileError> => {
	const { name, loc } = owned
	const at = loc
	const definition = analyzedDefinition(schema, `derived ${name}`, owned.desc.query, name, at)
	if (!definition.ok) {
		return definition
	}
	const { checked, root, analyzed, heading, declared } = definition.value
	const { props } = analyzed.of(root)
	const all = mapNonEmpty(heading, (c) => c.name)
	const described = inferredFields(name, declared, schema.owned.contracts)
	if (!described.ok) {
		return described
	}
	const columns = described.value
	const keySets = inheritedKeys(columns, props.keys, props.prove, oneColumnKeyRepresentable)
	/** At most one fact: any one field is a key, and the first representable one was chosen (keys.ts). */
	const oneFact = props.keys.some((k) => k.key.length === 0)
	if (oneFact) {
		const first = derivedKeyLayout([columns[0]])
		if (!first.ok && !columns.some(oneColumnKeyRepresentable)) {
			return Result.err(
				derivedRefused(at, {
					kind: "oneFact",
					relation: name,
					fields: all,
					fault: first.error
				})
			)
		}
	}
	const wholeHeading =
		!oneFact && keySets.length === 1 && keySets[0]?.columns.length === columns.length
	const keys: Array<DerivedKey> = []
	for (const key of keySets) {
		const k = mapNonEmpty(key.columns, (c) => c.name)
		const layout = derivedKeyLayout(key.columns)
		if (!layout.ok) {
			return Result.err(
				derivedRefused(at, {
					kind: wholeHeading ? "wholeHeading" : "inheritedKey",
					relation: name,
					key: k,
					fault: layout.error
				})
			)
		}
		keys.push({
			...layout.value,
			index: identifierOf(identity.derivedKey(name, k)),
			proof: key.proof
		})
	}
	return Result.ok({
		name,
		ident: view.ident,
		level: owned.desc.level,
		reads: owned.reads,
		loc,
		query: { ...checked, dag: analyzed.dag },
		heading: described.value,
		keys,
		wholeHeading,
		card: props.card,
		read: { heading, keys: viewKeysOf(name, keys) }
	})
}
