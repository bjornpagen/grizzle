import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { inferredFields } from "#compiler/analysis/derived/fields.ts"
import {
	type DerivedKeyLayout,
	derivedKeyLayout,
	oneColumnKeyRepresentable
} from "#compiler/analysis/derived/keys.ts"
import { inheritedKeys } from "#compiler/analysis/logical/derived.ts"
import { type AdmittedQuery, checkDefinition } from "#compiler/check/index.ts"
import type { SchemaReading } from "#compiler/check/schema.ts"
import { CheckSession } from "#compiler/check/session.ts"
import { catchRefusal, unwrap } from "#compiler/core/canonical.ts"
import { type CompileError, derivedRefused, ruleRefused } from "#compiler/core/errors.ts"
import {
	type DeclaredName,
	DeclaredNamespace,
	identifierOf,
	identity
} from "#compiler/core/identity.ts"
import type { ConstraintName, RelationIdent } from "#compiler/core/ids.ts"
import { labeledChildLoc, type SourceLoc } from "#compiler/core/loc.ts"
import type { FieldDesc, QueryDesc } from "#compiler/ir/desc.ts"
import {
	classMembers,
	type KeyProof,
	type ViewAlternative,
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
import {
	analyzeLogical,
	keptNodes,
	type LogicalAnalysis,
	queryEvidence
} from "#compiler/logical/annotate.ts"
import { derivedKeyPremise } from "#compiler/logical/props.ts"
import type { OwnedRelation, OwnedView } from "#compiler/schema/own.ts"

export interface DerivedRelationAnalysis {
	readonly name: string
	/** Its stored table's identifier, ownership's. */
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
	/**
	 * The alternatives a Base over the view states beside the key (ir/keys.ts ViewKey alternatives): its proof's, and,
	 * where it is one alternative from its root's own key, an unrepresentable one no index holds, its root's too, so
	 * that key is a key of the view through this key's index.
	 */
	readonly alternatives: ReadonlyArray<ViewAlternative>
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
		alternatives: k.alternatives
	}))

/** A derived relation as ownership resolved it. */
type OwnedDerived = Extract<OwnedRelation, { readonly kind: "derived" }>
/** A stored derived relation's table, which its analysis names its rows by. */
type StoredView = Extract<OwnedView, { readonly kind: "stored" }>

/** What a stored table's definition cannot have on its delivered rows. */
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
		ruleRefused(at, "a derived definition has one heading: a stored table holds one heading group")
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
export type DerivedColumn = DeclaredColumn & { readonly desc: FieldDesc }

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
		const columns = DeclaredNamespace.columns(`relation ${relation}'s field`)
		return mapNonEmpty(heading, (c): DeclaredColumn => {
			const name = unwrap(
				columns.declare(
					c.name,
					"field",
					labeledChildLoc(loc, c.name, `field ${relation}.${c.name}`)
				)
			)
			return { ...c, name }
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
 * The definition `query` of the relation `relation` (a derived relation's, live or stored, or a world entry's, `label`
 * naming it to the checker), checked, and refused at `at` where its delivered rows carry an attachment or several
 * heading groups (spineObstacle) or its heading is empty: the shape every derived definition has, as its type says
 * (types/derived/derived.ts DefinitionShape), whether or not anything stores its rows.
 */
export const shapedDefinition = (
	schema: SchemaReading,
	label: string,
	query: QueryDesc,
	relation: string,
	at: SourceLoc
): Result.Result<
	{
		readonly checked: AdmittedQuery
		readonly root: RelNode
		readonly heading: NonEmptyReadonlyArray<HeadingColumn>
	},
	CompileError
> => {
	const checkedResult = checkDefinition(schema, label, query, new CheckSession(schema.patterns))
	if (!checkedResult.ok) {
		return checkedResult
	}
	const checked = checkedResult.value
	const root = checked.dag.roots[0]
	const obstacle = spineObstacle(root)
	if (obstacle !== undefined) {
		return Result.err(obstacleRefusals[obstacle](at, relation))
	}
	const heading = root.heading
	if (!isNonEmpty(heading)) {
		return Result.err(ruleRefused(at, "a derived definition has at least one field"))
	}
	return Result.ok({ checked, root, heading })
}

/**
 * The definition `query` of the relation `relation` shaped (`shapedDefinition`), analyzed under the evidence a view's
 * keys give (queryEvidence), and its heading declared (declaredHeading).
 */
export const analyzedDefinition = (
	schema: SchemaReading,
	label: string,
	query: QueryDesc,
	relation: string,
	at: SourceLoc
): Result.Result<AnalyzedDefinition, CompileError> => {
	const shaped = shapedDefinition(schema, label, query, relation, at)
	if (!shaped.ok) {
		return shaped
	}
	const { checked, root, heading } = shaped.value
	const analyzed = analyzeLogical(checked.dag, queryEvidence, keptNodes([root]))
	if (!analyzed.ok) {
		return analyzed
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
 *   nested set per fact, and a stored table holds flat facts, so the heading the view would hold is not the
 *   query's;
 * - a union of several heading groups as the definition (Refused, as the types refuse it): a view has one heading,
 *   and a union of different headings is delivered one statement per group;
 * - a definition with an empty heading (Refused, as the types refuse it): its relation is the unit relation, true or
 *   false, and its table's primary key has at least one column;
 * - a heading whose names are no declared names of one view (`declaredHeading`): a name the declared-name rule refuses
 *   (MalformedDescription), or two that convert to one column (IdentifierCollision), each at its field;
 * - an inherited key, or the full-heading fallback, whose unique index entry can exceed PostgreSQL's B-tree limit
 *   (UnrepresentableKey: inheritedKey, wholeHeading, oneFact), but one an indexed key listed from the same root proof
 *   stands one alternative from (analysis/logical/derived.ts InheritedKey root), which needs no index of its own: a
 *   Base over the view states it beside that key (ir/keys.ts ViewKey alternatives, DerivedKey alternatives), on that
 *   key's index, as the texts a key's generated digests read (ir/keys.ts GeneratedRead) are a key of the view through
 *   the digests' index.
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
	view: StoredView
): Result.Result<DerivedRelationAnalysis, CompileError> => {
	const { name, loc } = owned
	const at = loc
	const definition = analyzedDefinition(schema, `derived ${name}`, owned.desc.query, name, at)
	if (!definition.ok) {
		return definition
	}
	const { checked, root, analyzed, heading, declared } = definition.value
	const props = defined(analyzed.props.get(root), "a definition's root, kept")
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
	const laid = keySets.map((key) => ({ key, layout: derivedKeyLayout(key.columns) }))
	/** The roots whose own key is unrepresentable: each indexed key listed from it states the root's alternatives. */
	const skipped = new Set<KeyProof>()
	for (const { key, layout } of laid) {
		/** A key one alternative from an indexed key of its root is a key of the view through that key's index. */
		const stated = laid.some((other) => other.layout.ok && other.key.root === key.root)
		if (!layout.ok && !stated) {
			return Result.err(
				derivedRefused(at, {
					kind: wholeHeading ? "wholeHeading" : "inheritedKey",
					relation: name,
					key: mapNonEmpty(key.columns, (c) => c.name),
					fault: layout.error
				})
			)
		}
		if (!layout.ok && key.proof === key.root) {
			skipped.add(key.root)
		}
	}
	const keys: Array<DerivedKey> = laid.flatMap(({ key, layout }): ReadonlyArray<DerivedKey> => {
		if (!layout.ok) {
			return []
		}
		return [
			{
				...layout.value,
				index: identifierOf(
					identity.derivedKey(
						name,
						mapNonEmpty(key.columns, (c) => c.name)
					)
				),
				proof: key.proof,
				alternatives: skipped.has(key.root)
					? [...viewAlternatives(key.proof), ...viewAlternatives(key.root)]
					: viewAlternatives(key.proof)
			}
		]
	})
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
