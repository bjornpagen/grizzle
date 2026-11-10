import { type CheckedSchema, checkedSchema } from "#compiler/analysis/schema.ts"
import { ViolationBuilder } from "#compiler/analysis/theory/build.ts"
import { lawDescription } from "#compiler/analysis/theory/description.ts"
import type { ResolvedConjunct, TheoryLaw } from "#compiler/analysis/theory/laws.ts"
import { type QueryRule, type Touches, touches } from "#compiler/analysis/theory/query.ts"
import {
	buildTheory,
	type EvidencedTheory,
	type PrimaryKeyLaw,
	type Theory,
	theoryEvidence,
	typingEnv
} from "#compiler/analysis/theory/theory.ts"
import { sameMembers, sameOrder } from "#compiler/core/array.ts"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { CompileError, malformedDescription, prose } from "#compiler/core/errors.ts"
import {
	type Identity,
	identifierOf,
	identity,
	type KeyColumnName,
	type KeySide
} from "#compiler/core/identity.ts"
import {
	type ColumnIdent,
	type ConstraintName,
	type DomainName,
	type IdentityKind,
	type LawId,
	makeIdSupply,
	type NodeId,
	type RelationIdent
} from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import { heapTupleMaxBytes } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import type { CellSide } from "#compiler/ir/cells.ts"
import { mergeDags } from "#compiler/ir/dag.ts"
import { descText, type ExprDesc } from "#compiler/ir/desc.ts"
import type { ExistenceConstraint } from "#compiler/ir/evidence.ts"
import {
	type ExprSpec,
	identityValueOf,
	predicateTable,
	type ScalarExpr,
	type TypedLiteral
} from "#compiler/ir/expr.ts"
import type { Family } from "#compiler/ir/family.ts"
import {
	type DomainCheck,
	type DomainCheckTerm,
	type DomainNative,
	familyKey,
	fieldNames,
	type LawColumnValue,
	type LawField,
	type LawRelation,
	type NativeColumn,
	type NativeObject,
	type NativeOf,
	plainFields,
	type RelationInfo,
	type RowGuard,
	type SpanKeyScalars,
	type TheoryRelation
} from "#compiler/ir/law.ts"
import type { ConstraintLaws } from "#compiler/ir/products.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import {
	type ContractInfo,
	contractOf,
	type PatternSource,
	type ScalarType,
	textOf
} from "#compiler/ir/scalar.ts"

import { existenceConstraints } from "#compiler/laws/model/catalog.ts"
import { keyOf } from "#compiler/laws/model/names.ts"
import {
	type CheckPredicate,
	type LawColumnPlan,
	type LawPlan,
	type NativePlan,
	type PlannedColumn,
	type PlannedSpanKey,
	type PrimaryKeyPlan,
	primaryKeyPlan,
	Recognizer,
	type RuleDischarge
} from "#compiler/laws/model/plan.ts"
import { rowColumn, wideRow } from "#compiler/laws/model/rows.ts"
import { type RelationLaws, relationLaws } from "#compiler/laws/model/uniques.ts"
import {
	admittedReads,
	type ClosedRelations,
	type LeafDesc,
	lowerPredicate,
	lowerTerm,
	noParams
} from "#compiler/scalar/compute/lower.ts"
import { guardedTerm } from "#compiler/scalar/natural.ts"
import { ProgramPatterns, tablePatterns, typePatterns } from "#compiler/scalar/regex/patterns.ts"
import type { Owned } from "#compiler/schema/own.ts"
import type { Slice } from "#compiler/schema/reach.ts"
import { exprPatternReads } from "#compiler/schema/walk.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"

/** The native objects installed as a table constraint: keys, CHECKs and references. */
export type ConstraintNativeKind =
	| "PrimaryKey"
	| "Unique"
	| "WithoutOverlaps"
	| "TableCheck"
	| "ClosedCheck"
	| "ForeignKey"
	| "PeriodForeignKey"

/** A law column as the law model plans it, and the identity it is minted with. */
interface PlannedLawColumn {
	readonly named: Identity<"lawColumn">
	readonly plan: LawColumnPlan
}

/** A native object with the identity its installed name was minted from, its namespace, and its owner: the table
 * identifier. Each namespace holds exactly its kinds of object: a table constraint, a law column, a contract's domain,
 * which the installation names by its definition, or an object the law model names nothing for. A table constraint
 * carries the description of the law its violation reports. */
export type NamedNative =
	| {
			readonly object: NativeOf<ConstraintNativeKind>
			readonly namespace: "constraint"
			readonly named: Identity<"primaryKey" | "key" | "check" | "generatedCheck" | "foreignKey">
			readonly owner: RelationIdent
			readonly described: Law
	  }
	| {
			readonly object: NativeOf<"LawColumn">
			readonly namespace: "column"
			readonly named: Identity<"lawColumn">
			/** What the column is, as the law model planned it, which its identity is minted from (lawColumnIdentity) and a
			 * draft restates under the previous snapshot's names (restate.ts). */
			readonly plan: LawColumnPlan
			readonly owner: RelationIdent
	  }
	| { readonly object: DomainNative; readonly namespace: "domain" }
	| { readonly object: NativeOf<"RosterDomain" | "ReverseIndex">; readonly namespace: "unnamed" }

/** A primary key's native object: a PRIMARY KEY, or a primary key WITHOUT OVERLAPS. */
export type PrimaryNative =
	| NativeOf<"PrimaryKey">
	| (NativeOf<"WithoutOverlaps"> & {
			readonly key: Extract<SpanKeyScalars, { readonly kind: "primary" }>
	  })

/** A relation's primary key as installed: its native object, named by the identity ownership named it by, and the
 * description of the law its violation reports. */
export interface NamedPrimaryKey {
	readonly object: PrimaryNative
	readonly namespace: "constraint"
	readonly named: Identity<"primaryKey" | "key">
	readonly owner: RelationIdent
	readonly described: Law
}

/** An ordinary relation with its primary key as installed. */
export interface KeyedRelation {
	readonly relation: RelationInfo
	readonly primaryKey: NamedPrimaryKey
}

/** A native object as the model's dedup holds it, with every law it discharges and the law that first planned it: an
 * ordinary relation's primary key, seeded before every plan, or any other object. */
type Merged =
	| {
			readonly kind: "primary"
			readonly relation: RelationInfo
			readonly object: PrimaryNative
			readonly laws: [LawId, ...Array<LawId>]
			readonly law: TheoryLaw
	  }
	| {
			readonly kind: "native"
			readonly object: NativeObject
			readonly laws: [LawId, ...Array<LawId>]
			readonly law: TheoryLaw
	  }

/** A primary key's planned object as the model holds it, discharging `lawIds`, each column a field. */
const primaryNative = (
	plan: PrimaryKeyPlan,
	lawIds: NonEmptyReadonlyArray<LawId>
): PrimaryNative => {
	if (plan.kind === "PrimaryKey") {
		return { ...plan, lawIds }
	}
	const field = (c: PlannedColumn): NativeColumn =>
		c.kind === "field" ? c : missing("a primary key's columns, each a field")
	return {
		kind: "WithoutOverlaps",
		relation: plan.relation,
		span: field(plan.span),
		key: { kind: "primary", scalars: mapNonEmpty(plan.key.scalars, field) },
		named: plan.named,
		lawIds
	}
}

/** What the model always holds where it reads it: its absence is a defect. */
const missing = (what: string): never => {
	throw defect(what)
}

/** A primary key named by the identity ownership named it by. */
const namedPrimaryKey = (object: PrimaryNative, described: Law): NamedPrimaryKey => ({
	object,
	named: object.named,
	namespace: "constraint",
	owner: object.relation.ident,
	described
})

/** A law a constraint discharges, with the description its violation reports. */
export interface ConstraintLawOf {
	readonly law: LawId
	readonly described: Law
}

/**
 * One column of a stored table a domain types, with the law its field states of it, described: a contract's domain's
 * the law of the contract down the field's chain whose domain it is, a text domain's the field's own pattern law. The
 * use carries its law whole, so whoever judges the column names the law without looking one up.
 */
export interface DomainUse {
	readonly table: RelationIdent
	readonly column: ColumnIdent
	readonly law: ConstraintLawOf
}

/**
 * One entry of the constraint-to-LawId map: the identifier a violation reports (a table constraint, a rule's constraint
 * trigger or a domain constraint), the table or domain that owns it, and every law it discharges with its description,
 * in its native's order (`NativeObject.lawIds`): the first is the one it reports when nothing narrows it, a key law's
 * where a key plans the object, and a merged family axis lists its former's law and every containment that rides it.
 * A rule's trigger is one per table the rule reads, each its one law, and no native object: its violation is the rule's
 * query, which no host judges. A domain constraint also lists each column its domain types with that use's law, since
 * PostgreSQL's report of a domain violation names no table or column: a text domain one law per stored field it types,
 * so its laws are its uses'. The law model emits table constraints and rule triggers; the installation, which names
 * each domain by its definition, emits the domain constraints.
 */
export type ConstraintLaw =
	| {
			readonly kind: "constraint"
			readonly name: ConstraintName
			readonly owner: RelationIdent
			readonly laws: NonEmptyReadonlyArray<ConstraintLawOf>
	  }
	| {
			readonly kind: "trigger"
			readonly name: ConstraintName
			readonly owner: RelationIdent
			readonly laws: readonly [ConstraintLawOf]
	  }
	| {
			readonly kind: "domainConstraint"
			readonly name: ConstraintName
			readonly owner: DomainName
			readonly laws: NonEmptyReadonlyArray<ConstraintLawOf>
			readonly uses: ReadonlyArray<DomainUse>
	  }

/** One kind of owner's constraint names to laws, frozen as the map holds them. */
const frozenOwners = (
	byOwner: ReadonlyMap<string, ReadonlyMap<string, LawId>>
): Readonly<Record<string, Readonly<Record<string, LawId>>>> =>
	Object.freeze(
		Object.fromEntries(
			[...byOwner].map(([owner, named]) => [owner, Object.freeze(Object.fromEntries(named))])
		)
	)

/** The constraint map of a list of entries, by owner and name, each to the law it reports when nothing narrows it,
 * its first. A constraint name is scoped to its table or domain, so each owner and name is one entry. */
export const constraintLawMap = (entries: ReadonlyArray<ConstraintLaw>): ConstraintLaws => {
	const tables = new Map<string, Map<string, LawId>>()
	const domains = new Map<string, Map<string, LawId>>()
	for (const c of entries) {
		const byOwner = c.kind === "domainConstraint" ? domains : tables
		const named = byOwner.get(c.owner) ?? new Map<string, LawId>()
		named.set(c.name, c.laws[0].law)
		byOwner.set(c.owner, named)
	}
	return Object.freeze({ tables: frozenOwners(tables), domains: frozenOwners(domains) })
}

/**
 * A rule over a query and the deferred constraint triggers that hold it (analysis/theory/query.ts): its law, its
 * triggers' one name, minted from its law, which PostgreSQL scopes to each table, and each ordinary relation it reads,
 * what that relation's writes can break of it and the function its trigger there runs. A closed relation it reads
 * changes with no write, so it carries none.
 */
export interface RuleTrigger {
	readonly law: TheoryLaw
	readonly rule: QueryRule
	readonly named: Identity<"lawTrigger">
	readonly tables: NonEmptyReadonlyArray<RuleTable>
}

/** One table a rule over a query reads, with what its writes can break of the rule and its trigger's function. */
export interface RuleTable {
	readonly relation: RelationInfo
	readonly touches: Touches
	readonly function: Identity<"lawFunction">
}

export interface LawModel {
	/** The owned schema the model specializes: every installed identifier a law reads (a table, a column, a roster's
	 * domain, a declared key or check) is the one ownership registered there. */
	readonly owned: Owned
	/** The theory with its DAG extended, and the evidence the laws it plans give, each containment's
	 * validity context the one its plans prove. */
	readonly theory: EvidencedTheory
	/** Every native object the model holds of the laws it plans (`compileLaws`), once each, in law order. */
	readonly natives: ReadonlyArray<NamedNative>
	/**
	 * Every family of the schema, a tree's included, with its axes and folds resolved (analysis/theory Theory.families):
	 * what the write planner draws and fills, the column order places, and the shell's apply reads. Each drawn law column
	 * it names (its ‹n›, a counted index, a tree's ‹ps›, a hidden accumulator) is a LawColumn native of `natives` under
	 * the same identifier.
	 */
	readonly families: ReadonlyArray<Family>
	/** Each table constraint's identifier with every law it discharges. */
	readonly constraints: ReadonlyArray<ConstraintLaw>
	readonly constraintToLaw: ConstraintLaws
	/** Every identity the law model mints beyond ownership's: its laws', its natives' and its law columns'. */
	readonly identities: ReadonlyArray<Identity<IdentityKind>>
	/** The laws whose containment evidence holds at every statement (an immediate foreign key or a CHECK). */
	readonly immediate: ReadonlySet<LawId>
	/** The cycles of the foreign key graph its deferral reads (FkCycles), names only: what generate records for a layer
	 * that plans only a slice. */
	readonly fkCycles: FkCycles
	/** Each containment's existence evidence a query may rely on, with the native object that enforces it (catalog.ts
	 * existenceConstraints): what every evidence catalog over the model reads. */
	readonly existence: ReadonlyArray<ExistenceConstraint>
	/**
	 * The laws that read closed relations only, in law order, discharged once by the migration that installs them: each
	 * runs as its theory law's violation query (NormalizedLaw.violation), which reads the closed relations' rows and no
	 * installed constant, and installs nothing.
	 */
	readonly migrationLaws: ReadonlyArray<LawId>
	/** The rules over queries, in law order, with the triggers that discharge them at every COMMIT. */
	readonly rules: ReadonlyArray<RuleTrigger>
	/** Each ordinary relation its slice writes by name, with its primary key and the unique objects its natives install
	 * (uniques.ts relationLaws): one per primary key the model seeds, so one per relation its slice writes. */
	readonly relations: ReadonlyMap<string, RelationLaws>
	/** The checker's reading of the owned schema, whose relation handles the theory's laws read. */
	readonly checked: CheckedSchema
	/**
	 * Every admitted pattern the host evaluates against over the model (lawPatterns), each parsed once, where the model
	 * compiles: what a write's host fill and its refusal's witness read per row, parsing none.
	 */
	readonly patterns: ProgramPatterns
}

/**
 * The admitted patterns the host's evaluation of a write reads over the model: the field types and generated
 * expressions of every stored relation its slice writes, which are the relations a write's rows are of, every family
 * fold's selections, and every constraint native's predicates the witness judges (runtime/write/fill.ts hostEvaluator,
 * runtime/write/witness.ts).
 */
const lawPatterns = (
	stored: ReadonlyArray<TheoryRelation>,
	families: ReadonlyArray<Family>,
	natives: ReadonlyArray<NamedNative>
): ProgramPatterns => {
	const exprPatterns = (e: ScalarExpr): ReadonlyArray<PatternSource> =>
		tablePatterns(predicateTable(e))
	const nativePatterns = (n: NamedNative): ReadonlyArray<PatternSource> => {
		switch (n.object.kind) {
			case "TableCheck":
				return exprPatterns(n.object.predicate)
			case "ClosedCheck":
				return n.object.guard.flatMap((g) => exprPatterns(g.predicate))
			case "PrimaryKey":
			case "Unique":
			case "WithoutOverlaps":
			case "ForeignKey":
			case "PeriodForeignKey":
			case "LawColumn":
			case "Domain":
			case "RosterDomain":
			case "ReverseIndex":
				return []
		}
	}
	return ProgramPatterns.of([
		...stored.flatMap((r) =>
			r.fields.flatMap((f) => [
				...typePatterns(f.type),
				...(f.writing.kind === "generated" ? exprPatterns(f.writing.expr) : [])
			])
		),
		...families.flatMap((f) => f.folds.flatMap((fold) => fold.where.flatMap(exprPatterns))),
		...natives.flatMap(nativePatterns)
	])
}

const unwrap = <A>(r: Result.Result<A, CompileError>): A => {
	if (!r.ok) {
		throw new Refusal(r.error)
	}
	return r.value
}

/**
 * A native object's identity as the model's merge reads it, every law it discharges left out, so two plans of one object
 * are one object: its kind and what of it the database states, each handle by its name, each column by its name (a
 * field's, or a law column's identifier), an identity by its canonical text, a lowered predicate by its expression's
 * label, which names exactly one expression, a closed side by its number among the sides the recognizer built, one per
 * content (`sideOrdinal`, plan.ts closedSidesOf), and a contract's domain by its contract's name, whose base and check
 * it is.
 */
const nativeKey = (
	object: NativeObject,
	sideOrdinal: (side: CellSide<TypedLiteral>) => number
): string => {
	switch (object.kind) {
		case "PrimaryKey":
			return keyOf(
				object.kind,
				object.relation.name,
				fieldNames(object.columns),
				object.named.canonical
			)
		case "Unique":
			return keyOf(object.kind, object.relation.name, columnNames(object.columns))
		case "ReverseIndex":
			return keyOf(object.kind, object.relation.name, object.method, columnNames(object.columns))
		case "LawColumn":
			return keyOf(object.kind, object.relation.name, object.column)
		case "PeriodForeignKey":
			return keyOf(
				object.kind,
				object.relation.name,
				columnNames(object.columns),
				columnNames([object.span]),
				object.target.name,
				columnNames(object.targetColumns),
				columnNames([object.targetSpan]),
				String(object.deferrable)
			)
		case "WithoutOverlaps":
			return keyOf(
				object.kind,
				object.relation.name,
				columnNames([object.span]),
				object.key.kind,
				columnNames(object.key.scalars)
			)
		case "TableCheck":
			return object.check.kind === "declared"
				? keyOf(
						object.kind,
						object.relation.name,
						object.check.kind,
						object.check.name,
						object.check.named.canonical,
						object.predicate.id
					)
				: keyOf(
						object.kind,
						object.relation.name,
						object.check.kind,
						object.check.law,
						object.predicate.id
					)
		case "ClosedCheck":
			return keyOf(
				object.kind,
				object.relation.name,
				object.target.name,
				String(sideOrdinal(object.side)),
				object.pairs.map((p) => keyOf(columnNames([p.source]), p.target.name)),
				object.guard.map((g) => g.predicate.id)
			)
		case "ForeignKey":
			return keyOf(
				object.kind,
				object.relation.name,
				columnNames(object.columns),
				object.target.name,
				columnNames(object.targetColumns),
				String(object.deferrable),
				object.onUpdate
			)
		case "Domain":
		case "RosterDomain":
			return keyOf(object.kind, object.name)
	}
}

/** The names of a native's columns: a field's name, a law column's identifier. */
const columnNames = (columns: ReadonlyArray<NativeColumn>): ReadonlyArray<string> =>
	columns.map((c) => (c.kind === "field" ? c.field.name : c.column))

/** A contract's domain CHECK (`DomainCheck`): its base's refined text pattern, when the base is no contract, and
 * its predicate. */
export const domainCheck = (info: ContractInfo): DomainCheck => {
	const regex = contractOf(info.base) === undefined ? textOf(info.base)?.regex : undefined
	const pattern: ReadonlyArray<DomainCheckTerm> =
		regex === undefined || regex === "wildcard" ? [] : [{ kind: "pattern", regex }]
	const predicate: ReadonlyArray<DomainCheckTerm> =
		info.predicate === undefined ? [] : [{ kind: "predicate", predicate: info.predicate }]
	const terms = [...pattern, ...predicate]
	return isNonEmpty(terms) ? { kind: "checked", terms } : { kind: "unchecked" }
}

/**
 * The cycles of the foreign keys that order a write's statements (`#deferral`): each strongly connected component of
 * more than one relation, its relations' names in code point order, the components in the order of their first names.
 * A foreign key lies on a cycle exactly when it references its own relation or its two ends are in one of them
 * (`onCycleOf`). Names only: what generate records in the snapshot for a layer that plans only a slice of the laws.
 */
export type FkCycles = ReadonlyArray<NonEmptyReadonlyArray<string>>

/** The cycles of the foreign key graph of `edges` (FkCycles): its strongly connected components (iterative Tarjan) of
 * more than one relation. */
const fkCyclesOf = (edges: ReadonlyArray<readonly [string, string]>): FkCycles => {
	const next = new Map<string, Array<string>>()
	for (const [a, b] of edges) {
		next.set(a, [...(next.get(a) ?? []), b])
		if (!next.has(b)) {
			next.set(b, [])
		}
	}
	/** Each visited node's discovery index and low link. */
	const visited = new Map<string, { readonly index: number; low: number }>()
	const component = new Map<string, number>()
	const stack: Array<string> = []
	const onStack = new Set<string>()
	let counter = 0
	let components = 0
	const visit = (node: string) => {
		const link = { index: counter, low: counter }
		visited.set(node, link)
		counter++
		stack.push(node)
		onStack.add(node)
		return link
	}
	/** Pops the component rooted at `node` off the stack. */
	const popComponent = (node: string): void => {
		for (let popped = stack.pop(); popped !== undefined; popped = stack.pop()) {
			onStack.delete(popped)
			component.set(popped, components)
			if (popped === node) {
				break
			}
		}
		components++
	}
	/** Every component reachable from `root`, walked depth first on a work stack of frames, each a node, its next
	 * successor's position and its link. */
	const strongConnect = (root: string): void => {
		const work: Array<{
			readonly node: string
			i: number
			readonly link: { readonly index: number; low: number }
		}> = [{ node: root, i: 0, link: visit(root) }]
		/** A successor's step: one not yet visited is pushed and lowers nothing yet; one on the stack lowers its
		 * predecessor's link to its index; one in a finished component lowers nothing. */
		const stepTo = (w: string): number | undefined => {
			const seen = visited.get(w)
			if (seen === undefined) {
				work.push({ node: w, i: 0, link: visit(w) })
				return undefined
			}
			return onStack.has(w) ? seen.index : undefined
		}
		for (let frame = work.at(-1); frame !== undefined; frame = work.at(-1)) {
			const w = next.get(frame.node)?.[frame.i]
			if (w !== undefined) {
				frame.i++
				const lowered = stepTo(w)
				if (lowered !== undefined) {
					frame.link.low = Math.min(frame.link.low, lowered)
				}
				continue
			}
			work.pop()
			const parent = work.at(-1)
			if (parent !== undefined) {
				parent.link.low = Math.min(parent.link.low, frame.link.low)
			}
			if (frame.link.low === frame.link.index) {
				popComponent(frame.node)
			}
		}
	}
	for (const root of next.keys()) {
		if (!visited.has(root)) {
			strongConnect(root)
		}
	}
	const members = Map.groupBy(component.keys(), (relation) => component.get(relation))
	return [...members.values()]
		.flatMap((relations) => {
			const sorted = relations.toSorted(compareStrings)
			return isNonEmpty(sorted) && sorted.length > 1 ? [sorted] : []
		})
		.toSorted((a, b) => compareStrings(a[0], b[0]))
}

/**
 * Whether a foreign key from `from` into `to` lies on one of `cycles`: it references its own relation, or both its ends
 * are in one component. Every foreign key the deferral asks about is an edge of the graph the cycles are of, so a
 * self-reference is a cycle of its own, which no component of more than one relation lists.
 */
const onCycleOf = (cycles: FkCycles): ((from: string, to: string) => boolean) => {
	const cycleOf = new Map(cycles.flatMap((c, i) => c.map((relation) => [relation, i] as const)))
	return (from, to) => {
		const own = cycleOf.get(from)
		return from === to || (own !== undefined && own === cycleOf.get(to))
	}
}

/**
 * Where a law model's foreign key cycles (FkCycles) come from: planned from every law of the schema, which the model
 * then plans whatever its slice names, or recorded by generate in the snapshot (snapshot.json derived.fkCycles), which
 * a login's compile reads so that its model plans only the laws a compile over its slice reads (`plannedLaws`).
 */
export type CycleSource =
	| { readonly kind: "planned" }
	| { readonly kind: "recorded"; readonly cycles: FkCycles }

/**
 * The laws a model plans: every law of the theory when it plans its cycles, which every law's plan settles; under
 * recorded cycles, the laws a compile over its slice reads (`readBySlice`), and every contract, whose domain types its
 * values wherever a role's context field or a parameter names it, beyond any relation.
 */
const plannedLaws = (
	laws: ReadonlyArray<TheoryLaw>,
	slice: Slice,
	cycles: CycleSource
): ReadonlyArray<TheoryLaw> =>
	cycles.kind === "planned"
		? laws
		: laws.filter((l) => l.detail.kind === "contract" || readBySlice(l, slice))

/**
 * Whether a compile over `slice` reads a law: one that reads a relation the slice writes, whose natives a write of it
 * can break, is ordered by or refuses by; one every relation of which the slice names, whose evidence a query over them
 * relies on; or a containment into a selected side of a named relation, whose UNIQUE over the side's law columns is a
 * selection key a query's probe of that relation reads (physical/ddl/names.ts selectionKeysOf). Any other law reads a
 * relation the slice neither names nor writes beside the ones it names: no write of the slice meets its natives, and
 * no query over the slice reads its evidence, which joins a relation the query never reads.
 */
const readBySlice = (law: TheoryLaw, slice: Slice): boolean =>
	law.reads.some((r) => slice.writes.has(r)) ||
	law.reads.every((r) => slice.names.has(r)) ||
	(law.detail.kind === "containment" &&
		slice.names.has(law.detail.to.relation) &&
		law.detail.to.selection.conjuncts.length > 0)

/** The edges of the foreign key graph `plans` order a write's statements by (`#deferral`): every foreign key its family
 * does not fix deferred, and every PERIOD foreign key, from its relation to its target. */
const fkEdges = (plans: ReadonlyArray<LawPlan>): ReadonlyArray<readonly [string, string]> =>
	plans.flatMap((plan) =>
		plan.natives.flatMap((n): ReadonlyArray<readonly [string, string]> =>
			(n.kind === "ForeignKey" && n.deferral !== "deferred") || n.kind === "PeriodForeignKey"
				? [[n.relation.name, n.target.name]]
				: []
		)
	)

/** A foreign key the schema-wide deferral rule decides, as the rule asks about it: its relation, its target and the
 * target's fields it references as plain columns. */
interface DeferralQuery {
	readonly relation: TheoryRelation
	readonly target: TheoryRelation
	readonly targetFields: ReadonlyArray<LawField>
}

/**
 * The schema-wide deferral (`Recognizer.#deferral`): whether a foreign key lies on a cycle of the foreign keys that order
 * a write's statements, and whether the rule defers a foreign key it decides, on such a cycle or into a replaceable
 * target.
 */
interface Deferral {
	readonly onCycle: (from: string, to: string) => boolean
	readonly rule: (fk: DeferralQuery) => boolean
}

/** Whether a planned foreign key is installed deferrable: as its plan states, or as the schema-wide rule decides it. */
const deferrable = (
	n: Extract<NativePlan, { readonly kind: "ForeignKey" }>,
	deferral: Deferral
): boolean => {
	switch (n.deferral) {
		case "rule":
			return deferral.rule({
				relation: n.relation,
				target: n.target,
				targetFields: n.targetColumns.flatMap((c) => (c.kind === "field" ? [c.field] : []))
			})
		case "cycle":
			return deferral.onCycle(n.relation.name, n.target.name)
		case "immediate":
			return false
		case "deferred":
			return true
	}
}

/**
 * The laws whose containment evidence holds at every statement: each a plan discharges by an immediate foreign key, a
 * ClosedCheck or a table CHECK of a containment, declared or generated. It reads the plans and the deferral alone.
 */
const immediateOf = (plans: ReadonlyArray<LawPlan>, deferred: Deferral): ReadonlySet<LawId> =>
	new Set(
		plans.flatMap((plan) =>
			plan.natives.some(
				(n) =>
					(n.kind === "ForeignKey" && !deferrable(n, deferred)) ||
					n.kind === "ClosedCheck" ||
					((n.kind === "TableCheck" || n.kind === "GeneratedCheck") &&
						plan.law.detail.kind === "containment")
			)
				? [plan.law.id]
				: []
		)
	)

/** A plan's native object as the specializer materializes it: a declared row check with its predicate lowered into the
 * extension DAG over its relation's row (`ColumnLowering`), a generated CHECK with its predicate lowered there
 * (`#lowerCheck`), a law column with its value lowered there, a ClosedCheck with its guard lowered, every other as its
 * plan states it. */
type PlacedNative =
	| Exclude<
			NativePlan,
			{ readonly kind: "TableCheck" | "GeneratedCheck" | "LawColumn" | "ClosedCheck" }
	  >
	| (Omit<Extract<NativePlan, { readonly kind: "TableCheck" }>, "predicate"> & {
			readonly predicate: ScalarExpr
	  })
	| (Omit<NativeOf<"ClosedCheck">, "lawIds" | "pairs"> & {
			readonly pairs: Extract<NativePlan, { readonly kind: "ClosedCheck" }>["pairs"]
	  })
	| {
			readonly kind: "LoweredCheck"
			readonly relation: RelationInfo
			readonly predicate: ScalarExpr
	  }
	| {
			readonly kind: "LoweredColumn"
			readonly column: LawColumnPlan
			readonly value: LawColumnValue
	  }

/** One relation's row as the law columns on it read it: one scan, its leaf reader, and what is lowered over it. */
interface ColumnRow {
	readonly region: RelNode
	readonly leaf: (desc: LeafDesc, at: SourceLoc) => Result.Result<ExprSpec, CompileError>
	/** Each guard conjunct lowered, by its canonical text. */
	readonly guards: Map<string, ScalarExpr>
	/** Each law column's value, by its identity's canonical text. */
	readonly values: Map<string, LawColumnValue>
}

/** A column of a scan region at `type`, read by its name: a field's, or a law column's identifier. */
const regionColumn = (node: NodeId, name: string, type: ScalarType): ExprSpec => ({
	kind: "column",
	column: { node, name },
	args: [],
	type,
	nonNull: "storage"
})

/**
 * The law columns' values lowered into the extension DAG in "check" mode, where no operation raises, over one scan of
 * each relation's row: each guard conjunct once per relation, by its canonical text, so two columns of one guard read
 * one expression and a UNIQUE over them states it once (uniques.ts); each column's value once per relation and
 * identity, reached from a root of its own. A term's column is guarded by its side's selection's conjuncts, then by
 * its term's own guard (scalar/natural.ts guardedTerm: pred(x) above zero); a constant is its literal under no guard; a
 * counted family's ‹p› is pred of its drawn index, read as that column by its identifier; a drawn column is the host's,
 * and lowers nothing.
 */
/** The expressions a law column's value lowers: its selection's conjuncts, an index predecessor's index's. */
const lawColumnExprs = (column: LawColumnPlan): ReadonlyArray<ExprDesc> => {
	switch (column.kind) {
		case "term":
			return column.selection.conjuncts.map((c) => c.predicate)
		case "indexPred":
			return lawColumnExprs(column.index)
		case "constant":
		case "drawn":
			return []
	}
}

/**
 * The expressions the law model lowers for a native: a declared or generated CHECK's predicate, a ClosedCheck's
 * guards, a law column's value; no other native lowers one.
 */
const nativeExprs = (n: NativePlan): ReadonlyArray<ExprDesc> => {
	switch (n.kind) {
		case "TableCheck":
			return [n.predicate]
		case "GeneratedCheck":
			return [n.check.predicate]
		case "ClosedCheck":
			return n.guard.map((c) => c.predicate)
		case "LawColumn":
			return lawColumnExprs(n.column)
		case "PrimaryKey":
		case "Unique":
		case "Domain":
		case "RosterDomain":
		case "ForeignKey":
		case "WithoutOverlaps":
		case "PeriodForeignKey":
		case "ReverseIndex":
			return []
	}
}

class ColumnLowering {
	readonly #ext: ViolationBuilder
	readonly #typing: ReturnType<typeof typingEnv>
	/**
	 * The closed relations a guard or a term may apply (CheckedSchema.closedReads), each pattern the held natives read
	 * admitted for the law model's lowering (nativeExprs).
	 */
	readonly #closed: ClosedRelations
	readonly #roots: Array<RelNode>
	/** The identifier of a law column, which a value reading another law column reads it by. */
	readonly #identifier: (plan: LawColumnPlan) => ColumnIdent
	readonly #rows = new Map<string, ColumnRow>()

	constructor(
		ext: ViolationBuilder,
		typing: ReturnType<typeof typingEnv>,
		closed: ClosedRelations,
		roots: Array<RelNode>,
		identifier: (plan: LawColumnPlan) => ColumnIdent
	) {
		this.#ext = ext
		this.#typing = typing
		this.#closed = closed
		this.#roots = roots
		this.#identifier = identifier
	}

	/**
	 * A ClosedCheck's guards: each conjunct of its source's selection lowered over the source's row, once per relation by
	 * its canonical text as a law column's guard is, with the fields it reads, reached from a root of their own.
	 */
	guards(
		relation: TheoryRelation,
		conjuncts: ReadonlyArray<ResolvedConjunct>,
		loc: SourceLoc
	): ReadonlyArray<RowGuard> {
		const row = this.#row(relation)
		const guards = conjuncts.map((c): RowGuard => ({
			predicate: this.#guard(row, c.predicate, c.text, loc),
			reads: c.reads
		}))
		if (isNonEmpty(guards)) {
			this.#roots.push(
				this.#ext.project(
					row.region,
					guards.map((g, i) => [`guard${i}`, g.predicate] as const)
				)
			)
		}
		return guards
	}

	/**
	 * A declared row check's predicate lowered over its relation's row, total, as its violation query lowers it, reached
	 * from a root of its own.
	 */
	check(relation: TheoryRelation, predicate: ExprDesc, loc: SourceLoc): ScalarExpr {
		const row = this.#row(relation)
		const lowered = unwrap(lowerPredicate(predicate, this.#env(row, loc, new Map()))).expr
		this.#roots.push(this.#ext.project(row.region, [["check", lowered]]))
		return lowered
	}

	value(plan: LawColumnPlan, named: Identity<"lawColumn">, loc: SourceLoc): LawColumnValue {
		if (plan.kind === "drawn") {
			return { kind: "drawn", draws: plan.draws }
		}
		const row = this.#row(plan.relation)
		const known = row.values.get(named.canonical)
		if (known !== undefined) {
			return known
		}
		const value = this.#lower(row, plan, loc)
		row.values.set(named.canonical, value)
		this.#roots.push(
			this.#ext.project(row.region, [
				...value.guard.map((g, i) => [`guard${i}`, g] as const),
				["term", value.term]
			])
		)
		return value
	}

	#lower(
		row: ColumnRow,
		plan: Exclude<LawColumnPlan, { readonly kind: "drawn" }>,
		loc: SourceLoc
	): Extract<LawColumnValue, { readonly kind: "generated" }> {
		switch (plan.kind) {
			case "constant":
				return {
					kind: "generated",
					guard: [],
					term: this.#ext.typed(plan.value, plan.field.type)
				}
			case "term": {
				const own = guardedTerm(plan.term)
				return {
					kind: "generated",
					guard: [
						...plan.selection.conjuncts.map((c) => this.#guard(row, c.predicate, c.text, loc)),
						...own.guard.map((g) => this.#guard(row, g, unwrap(descText(g)), loc))
					],
					term: unwrap(lowerTerm(own.term, this.#env(row, loc, new Map()))).expr
				}
			}
			case "indexPred": {
				const index = this.#identifier(plan.index)
				const own = guardedTerm({ kind: "pred", field: index })
				const env = this.#env(row, loc, new Map([[index, plan.field.type]]))
				return {
					kind: "generated",
					guard: own.guard.map((g) => unwrap(lowerPredicate(g, env)).expr),
					term: unwrap(lowerTerm(own.term, env)).expr
				}
			}
		}
	}

	#guard(row: ColumnRow, predicate: ExprDesc, text: string, loc: SourceLoc): ScalarExpr {
		const known = row.guards.get(text)
		if (known !== undefined) {
			return known
		}
		const lowered = unwrap(lowerPredicate(predicate, this.#env(row, loc, new Map()))).expr
		row.guards.set(text, lowered)
		return lowered
	}

	/** The lowering environment over `row`, which also reads each law column of `lawColumns` by its identifier at the type
	 * of the values it holds. */
	#env(row: ColumnRow, loc: SourceLoc, lawColumns: ReadonlyMap<string, ScalarType>) {
		return {
			...this.#typing,
			closed: this.#closed,
			mode: "check" as const,
			loc,
			emit: (spec: ExprSpec) => this.#ext.expr(spec),
			params: noParams,
			leaf: (desc: LeafDesc, at: SourceLoc): Result.Result<ExprSpec, CompileError> => {
				const type = desc.kind === "field" ? lawColumns.get(desc.field) : undefined
				return desc.kind === "field" && type !== undefined
					? Result.ok(regionColumn(row.region.id, desc.field, type))
					: row.leaf(desc, at)
			}
		}
	}

	#row(r: TheoryRelation): ColumnRow {
		const known = this.#rows.get(r.name)
		if (known !== undefined) {
			return known
		}
		const region = this.#ext.scan(r, r.fields, [])
		const row: ColumnRow = {
			region,
			leaf: (desc, at) => {
				const field =
					desc.kind === "field" ? r.fields.find((f) => f.name === desc.field) : undefined
				return field === undefined
					? Result.err(
							malformedDescription(at, `a field of ${r.name}, not a ${desc.kind} reference`)
						)
					: Result.ok(columnLeaf(region.id, field))
			},
			guards: new Map(),
			values: new Map()
		}
		this.#rows.set(r.name, row)
		return row
	}
}

class Specializer {
	readonly theory: Theory
	readonly checked: CheckedSchema
	readonly owned: Owned
	/** The ordinary relations whose writes the model serves (schema/reach.ts Slice.writes). */
	readonly writes: ReadonlySet<string>
	/** The laws the model plans (`plannedLaws`), in law order. */
	readonly planned: ReadonlyArray<TheoryLaw>
	readonly cycles: CycleSource
	/** The recognizer over every law of the theory, planned or not: a planned containment into a relation its slice
	 * does not name finds its target's projected keys and family laws there. */
	readonly recognizer: Recognizer
	/** The typing environment every lowering of the model reads, each text pattern analyzed once in it. */
	readonly #typing: ReturnType<typeof typingEnv>
	readonly #minted: Array<Identity<IdentityKind>> = []
	/** Each law column's identity, which names its native once it is merged, by its relation and identifier. */
	readonly #lawColumns = new Map<string, Map<ColumnIdent, PlannedLawColumn>>()
	/** Every law by its id, a primary key's included: what a constraint's every law is described by. */
	readonly #laws: ReadonlyMap<LawId, TheoryLaw>

	constructor(
		theory: Theory,
		checked: CheckedSchema,
		slice: Slice,
		cycles: CycleSource,
		discharge: RuleDischarge
	) {
		this.theory = theory
		this.checked = checked
		this.owned = checked.owned
		this.writes = slice.writes
		this.planned = plannedLaws(theory.laws, slice, cycles)
		this.cycles = cycles
		this.recognizer = new Recognizer(theory.laws, theory.families, theory.relations, discharge)
		this.#typing = typingEnv(checked.owned)
		this.#laws = new Map([
			...theory.laws.map((l) => [l.id, l] as const),
			...theory.primaryKeys.map((pk) => [pk.law.id, pk.law] as const)
		])
	}

	/** The identifier of a law column, its identity kept to name its native. */
	#lawColumn(plan: LawColumnPlan): ColumnIdent {
		const named = lawColumnIdentity(plan)
		const own = this.#lawColumns.get(plan.relation.name) ?? new Map<ColumnIdent, PlannedLawColumn>()
		const column = identifierOf(named)
		if (!own.has(column)) {
			this.#named(named)
			own.set(column, { named, plan })
			this.#lawColumns.set(plan.relation.name, own)
		}
		return column
	}

	/** The law column `column` of `relation`, with the identity every law column the model names was minted with. */
	#planned(relation: LawRelation, column: ColumnIdent): PlannedLawColumn {
		const planned = this.#lawColumns.get(relation.name)?.get(column)
		if (planned === undefined) {
			throw defect(`the law column ${column} of ${relation.name}, minted as it is planned`)
		}
		return planned
	}

	/** The identity of the law column `column` of `relation`. */
	#lawColumnNamed(relation: LawRelation, column: ColumnIdent): Identity<"lawColumn"> {
		return this.#planned(relation, column).named
	}

	/** A planned column as its native reads it: a field, or a law column by its identifier. */
	#column(c: PlannedColumn): NativeColumn {
		switch (c.kind) {
			case "field":
				return c
			case "law":
				return { kind: "law", column: this.#lawColumn(c.column) }
		}
	}

	/** A native's columns as its name reads them: a field by its name, a law column by its identity. */
	#keyNames(
		relation: LawRelation,
		columns: ReadonlyArray<NativeColumn>
	): ReadonlyArray<KeyColumnName> {
		return columns.map((c): KeyColumnName =>
			c.kind === "field" ? c.field.name : this.#lawColumnNamed(relation, c.column)
		)
	}

	/** An identity the law model mints, kept for the installation's census and comments. */
	#named<K extends IdentityKind>(named: Identity<K>): Identity<K> {
		this.#minted.push(named)
		return named
	}

	run(): LawModel {
		const plans = this.planned.map((law) => this.recognizer.plan(law))
		const fkCycles =
			this.cycles.kind === "planned" ? fkCyclesOf(fkEdges(plans)) : this.cycles.cycles
		const deferred = this.#deferral(fkCycles)
		const immediate = immediateOf(plans, deferred)
		const held = this.#held(plans)

		/** The extension DAG: each declared and generated CHECK's predicate and each law column's value. */
		const ext = new ViolationBuilder(SourceLoc(`schema ${this.owned.name}`, []))
		const roots: Array<RelNode> = []
		/** The closed relations the held natives' predicates and values apply, each pattern they read admitted once. */
		const closed = admittedReads(
			this.checked.closedReads,
			exprPatternReads(plans.flatMap((plan) => plan.natives.filter(held).flatMap(nativeExprs)))
		)
		const columns = new ColumnLowering(ext, this.#typing, closed, roots, (plan) =>
			this.#lawColumn(plan)
		)
		/** Each plan with its native objects, a generated CHECK's predicate and a law column's value lowered into the
		 * extension DAG. */
		const place = (n: NativePlan, plan: LawPlan): PlacedNative => {
			switch (n.kind) {
				case "GeneratedCheck": {
					const { filter, predicate } = this.#lowerCheck(
						ext,
						closed,
						n.relation,
						n.check,
						plan.law.loc
					)
					roots.push(filter)
					return { kind: "LoweredCheck", relation: n.relation, predicate }
				}
				case "LawColumn":
					return {
						kind: "LoweredColumn",
						column: n.column,
						value: columns.value(n.column, lawColumnIdentity(n.column), plan.law.loc)
					}
				case "ClosedCheck":
					return { ...n, guard: columns.guards(n.relation, n.guard, plan.law.loc) }
				case "TableCheck":
					return { ...n, predicate: columns.check(n.relation, n.predicate, plan.law.loc) }
				case "PrimaryKey":
				case "Unique":
				case "Domain":
				case "RosterDomain":
				case "ForeignKey":
				case "WithoutOverlaps":
				case "PeriodForeignKey":
				case "ReverseIndex":
					return n
			}
		}
		const placed = plans.map((plan) => ({
			plan,
			natives: plan.natives.filter(held).map((n) => place(n, plan))
		}))
		/** A schema with no generated CHECK and no law column adds nothing to the DAG. */
		const merged =
			roots.length === 0
				? { dag: this.theory.dag, expr: (e: ScalarExpr) => e }
				: mergeDags(this.theory.dag, ext.b.build(roots))

		/** Native objects, merged: each first seen with its law list, which every later plan of the same object extends,
		 * so the object holds every law it discharges once all plans are read. Each ordinary relation's primary key is
		 * seen first, with its own law: a primary key merges only with a plan of the same key. */
		const byKey = new Map<string, Merged>()
		for (const pk of this.theory.primaryKeys) {
			if (this.writes.has(pk.relation.name)) {
				this.#seed(byKey, pk)
			}
		}
		const implyingKey = this.#implyingKey()
		/** Key laws first, so an object a key law and another law both plan reports the key's law. */
		const keysFirst = [
			...placed.filter((p) => isKeyLaw(p.plan.law)),
			...placed.filter((p) => !isKeyLaw(p.plan.law))
		]
		for (const { plan, natives: placedNatives } of keysFirst) {
			for (const n of placedNatives) {
				const object = this.#materialize(n, plan, deferred, (e) => merged.expr(e))
				const key = nativeKey(object, (side) => this.recognizer.closedSideOrdinal(side))
				const known = byKey.get(key)
				if (known === undefined) {
					const laws = this.#firstLaws(n, plan, implyingKey)
					byKey.set(key, {
						kind: "native",
						object: { ...object, lawIds: laws },
						laws,
						law: this.#lawOf(laws[0])
					})
					continue
				}
				if (!known.laws.includes(plan.law.id)) {
					known.laws.push(plan.law.id)
				}
			}
		}

		/** Names and the constraint map, each object once, in the order it was first seen; each primary key with its
		 * relation. */
		const natives: Array<NamedNative> = []
		const keyed: Array<KeyedRelation> = []
		const constraints: Array<ConstraintLaw> = []
		for (const entry of byKey.values()) {
			const described = lawDescription(entry.law)
			const named = this.#nameMerged(entry, described, keyed)
			natives.push(named)
			if (named.namespace === "constraint") {
				constraints.push({
					kind: "constraint",
					name: identifierOf(named.named),
					owner: named.owner,
					laws: mapNonEmpty(entry.laws, (law) => ({
						law,
						described: lawDescription(this.#lawOf(law))
					}))
				})
			}
		}

		const rules = plans.flatMap((plan) =>
			plan.discharge === "trigger" && plan.law.reads.some((r) => this.writes.has(r))
				? [this.#ruleTrigger(plan.law)]
				: []
		)
		for (const r of rules) {
			for (const t of r.tables) {
				constraints.push({
					kind: "trigger",
					name: identifierOf(r.named),
					owner: t.relation.ident,
					laws: [{ law: r.law.id, described: lawDescription(r.law) }]
				})
			}
		}
		this.#refuseWideRows(natives)
		const evidence = theoryEvidence(this.planned, immediate)
		return {
			owned: this.owned,
			theory: Object.freeze({ ...this.theory, dag: merged.dag, evidence }),
			natives,
			families: this.#plannedFamilies(),
			constraints,
			constraintToLaw: constraintLawMap(constraints),
			identities: [...this.theory.laws.map((law) => law.named), ...this.#minted],
			immediate,
			fkCycles,
			existence: existenceConstraints(evidence.containments, natives),
			migrationLaws: plans.flatMap((plan) => (plan.discharge === "migration" ? [plan.law.id] : [])),
			rules,
			relations: relationLaws(keyed, natives),
			checked: this.checked,
			patterns: lawPatterns(
				this.checked.stored.filter((r) => this.writes.has(r.name)),
				this.theory.families,
				natives
			)
		}
	}

	/** The families whose laws the model plans, a tree's included, in the theory's order: what a write of its slice
	 * draws, fills and orders by, each with its owner axis among the model's natives. */
	#plannedFamilies(): ReadonlyArray<Family> {
		const planned = new Set(
			this.planned.flatMap((law) =>
				law.detail.kind === "family" || law.detail.kind === "tree"
					? [familyKey(law.detail.family.id)]
					: []
			)
		)
		return this.theory.families.filter((f) => planned.has(familyKey(f.id)))
	}

	/**
	 * Whether the model holds a planned native, decided by what the native is, so every plan of one object decides it
	 * alike and a held object discharges every law any plan gives it, as the whole schema's model's does. It holds every
	 * native of a relation its slice writes, which a write of the slice can break or a write's statements read, and on
	 * every relation the natives a read of the schema relies on, whoever writes: each foreign key, PERIOD foreign key,
	 * CHECK of a containment into a closed relation and roster domain, the existence evidence a query's evidence catalog
	 * names (catalog.ts existenceConstraints), a foreign key into a relation the slice writes also what a delete of its
	 * rows meets; each contract's domain, which the installed names type a contract's values by; and each selection key,
	 * a law column of a field term under a selection a UNIQUE holds, with the UNIQUEs that hold one, which a query's
	 * probe reads (physical/ddl/names.ts selectionKeysOf). Any other native of a relation the slice does not write, a
	 * key, a CHECK, another law column or a reverse index, only a write of that relation can break or read, so the model
	 * holds none of it.
	 */
	#held(plans: ReadonlyArray<LawPlan>): (n: NativePlan) => boolean {
		const writes = this.writes
		const selected = (c: LawColumnPlan): boolean =>
			c.kind === "term" && c.term.kind === "field" && c.selection.conjuncts.length > 0
		const unique = new Set(
			plans.flatMap((plan) =>
				plan.natives.flatMap((n) =>
					n.kind === "Unique"
						? n.columns.flatMap((c) =>
								c.kind === "law" && selected(c.column)
									? [lawColumnIdentity(c.column).canonical]
									: []
							)
						: []
				)
			)
		)
		const selectionKey = (c: LawColumnPlan): boolean =>
			selected(c) && unique.has(lawColumnIdentity(c).canonical)
		return (n) => {
			switch (n.kind) {
				case "ForeignKey":
				case "PeriodForeignKey":
				case "ClosedCheck":
				case "RosterDomain":
				case "Domain":
					return true
				case "LawColumn":
					return writes.has(n.column.relation.name) || selectionKey(n.column)
				case "Unique":
					return (
						writes.has(n.relation.name) ||
						n.columns.some((c) => c.kind === "law" && selectionKey(c.column))
					)
				case "PrimaryKey":
				case "TableCheck":
				case "GeneratedCheck":
				case "WithoutOverlaps":
				case "ReverseIndex":
					return writes.has(n.relation.name)
			}
		}
	}

	/**
	 * Refuses a relation the slice writes whose rows can exceed one heap tuple (MaxHeapTupleSize, `heapTupleMaxBytes`): its
	 * fields and every law column on it, a generated one outside its guard NULL, each counted at the most it can take
	 * inline once every variable-length value that can be is moved out of line (rows.ts).
	 */
	#refuseWideRows(natives: ReadonlyArray<NamedNative>): void {
		const lawColumns = new Map<string, Array<NativeOf<"LawColumn">>>()
		for (const n of natives) {
			if (n.namespace !== "column") {
				continue
			}
			const own = lawColumns.get(n.object.relation.name) ?? []
			own.push(n.object)
			lawColumns.set(n.object.relation.name, own)
		}
		for (const r of Object.values(this.theory.relations)) {
			if (r.kind !== "relation" || !this.writes.has(r.name)) {
				continue
			}
			const columns = [
				...r.fields.map((f) => rowColumn(f.desc, false)),
				...(lawColumns.get(r.name) ?? []).map((c) =>
					rowColumn(c.field.desc, c.value.kind === "generated" && c.value.guard.length > 0)
				)
			]
			const refused = wideRow(r.name, columns, heapTupleMaxBytes.value)
			if (refused !== undefined) {
				throw new Refusal(CompileError.make(prose("UnsupportedLawFamily", r.loc, refused)))
			}
		}
	}

	/**
	 * The triggers of a rule over a query: one name for the rule, minted from its law, and on each ordinary relation it
	 * reads, a function of its own. A check's own name is no trigger's: its triggers stand on every table it reads, beside
	 * each table's own constraints, so its name is unique in no table's namespace.
	 */
	#ruleTrigger(law: TheoryLaw): RuleTrigger {
		const d = law.detail
		if (d.kind !== "rule") {
			return missing(`the rule over a query ${law.id} plans its triggers`)
		}
		const named = this.#named(identity.lawTrigger(law.named))
		const tables = law.reads.flatMap((name): ReadonlyArray<RuleTable> => {
			const relation = this.theory.relations[name]
			const touched = touches(d.rule, name)
			return relation?.kind === "relation" && touched !== undefined
				? [
						{
							relation,
							touches: touched,
							function: this.#named(identity.lawFunction(name, law.named, law.reads))
						}
					]
				: []
		})
		const [first, ...rest] = tables
		if (first === undefined) {
			return missing(`a rule over a query discharged by triggers reads an ordinary relation`)
		}
		return { law, rule: d.rule, named, tables: [first, ...rest] }
	}

	/** The law `id` names, which the theory states. */
	#lawOf(id: LawId): TheoryLaw {
		return this.#laws.get(id) ?? missing(`the law ${id}, which the theory states`)
	}

	/**
	 * The laws a native object first seen in `plan` discharges, the reported one first: a family axis's every law its
	 * plan names, its former's first; a generated UNIQUE whose fields hold a declared key, that key's law and then its
	 * own; any other, its plan's law.
	 */
	#firstLaws(
		n: PlacedNative,
		plan: LawPlan,
		implyingKey: (
			unique: Extract<PlacedNative, { readonly kind: "Unique" }>
		) => TheoryLaw | undefined
	): [LawId, ...Array<LawId>] {
		if (n.kind === "ForeignKey" && n.laws !== undefined) {
			const [first, ...rest] = n.laws
			return [
				first,
				...rest.filter((l) => l !== first),
				...(n.laws.includes(plan.law.id) ? [] : [plan.law.id])
			]
		}
		const implying = n.kind === "Unique" ? implyingKey(n) : undefined
		return implying === undefined || implying.id === plan.law.id
			? [plan.law.id]
			: [implying.id, plan.law.id]
	}

	/**
	 * The declared key a generated UNIQUE's conflicts imply, by its relation's keys in key order, the primary key first:
	 * one whose fields its compared fields contain, a law column comparing the field whose values it holds. Every two
	 * rows the UNIQUE holds apart agree at that key's fields, so a state it refuses breaks the key too, whatever index
	 * PostgreSQL checks first: the UNIQUE discharges the key's law beside its own and reports the key's, the law the
	 * state breaks (a superkey a reference's target needs, or a selected target's law columns over a key). Undefined
	 * when its fields contain no declared key.
	 */
	#implyingKey(): (
		unique: Extract<PlacedNative, { readonly kind: "Unique" }>
	) => TheoryLaw | undefined {
		const keys = new Map<
			string,
			Array<{ readonly fields: ReadonlyArray<LawField>; readonly law: TheoryLaw }>
		>()
		const add = (relation: string, fields: ReadonlyArray<LawField>, law: TheoryLaw): void => {
			keys.set(relation, [...(keys.get(relation) ?? []), { fields, law }])
		}
		for (const pk of this.theory.primaryKeys) {
			add(pk.relation.name, pk.relation.primaryFields, pk.law)
		}
		for (const law of this.theory.laws) {
			if (law.detail.kind === "key" && !law.detail.key.primary) {
				add(law.detail.relation, law.detail.key.fields, law)
			}
		}
		return (unique) => {
			const compared = unique.columns.flatMap((c): ReadonlyArray<LawField> => {
				if (c.kind === "field") {
					return [c.field]
				}
				const column = c.column
				return column.kind === "term" ? [column.term.column] : []
			})
			return keys
				.get(unique.relation.name)
				?.find((k) => k.fields.every((f) => compared.includes(f)))?.law
		}
	}

	/** Seeds `byKey` with the primary key of `pk`'s relation, planned from its key and discharging its law. */
	#seed(byKey: Map<string, Merged>, pk: PrimaryKeyLaw): void {
		const laws: [LawId, ...Array<LawId>] = [pk.law.id]
		const object = primaryNative(
			primaryKeyPlan(pk.relation, pk.relation.keyNames[0], pk.law.loc),
			laws
		)
		byKey.set(
			nativeKey(object, (side) => this.recognizer.closedSideOrdinal(side)),
			{
				kind: "primary",
				relation: pk.relation,
				object,
				laws,
				law: pk.law
			}
		)
	}

	/** The installed identifier of a merged object (`#name`), a primary key's kept with its relation in `keyed`. */
	#nameMerged(entry: Merged, described: Law, keyed: Array<KeyedRelation>): NamedNative {
		if (entry.kind === "native") {
			return this.#name(entry.object, entry.law.named, described)
		}
		const primaryKey = namedPrimaryKey(entry.object, described)
		keyed.push({ relation: entry.relation, primaryKey })
		return primaryKey
	}

	/**
	 * The schema-wide deferral (see `compileLaws`). Its cycle graph holds every foreign key that orders a write's
	 * statements: the rule's own, the PERIOD ones, and every family axis its family does not fix deferred, an owner axis
	 * among them, which orders a family's members after their owner. A law's key can close a cycle with an owner axis, so
	 * no order of the statements would keep both: every key on such a cycle is deferred, the owner axis whose deferral
	 * is the cycle's among them, and the rule's too, which also defers a key into a replaceable target. The edges depend
	 * on the plans alone, never on an evidence context.
	 */
	#deferral(cycles: FkCycles): Deferral {
		const onCycle = onCycleOf(cycles)
		return {
			onCycle,
			rule: (fk) =>
				onCycle(fk.relation.name, fk.target.name) ||
				fk.target.fields.some((c) => !fk.targetFields.includes(c))
		}
	}

	/**
	 * A generated CHECK predicate lowered in "check" mode over a scan of its table, each of its leaves read as its plan
	 * names it: a field, a law column by its identifier at the type of the values it holds, or a literal at its type.
	 * Each field is read at its own type, so a literal bound adopts the field's contract as in a declared row check;
	 * when that adoption refuses (two contracts compared, or arithmetic over a contract), the predicate is lowered over
	 * the base types of every contract-typed leaf instead, which is the same predicate on every stored value.
	 */
	#lowerCheck(
		ext: ViolationBuilder,
		closed: ClosedRelations,
		r: RelationInfo,
		check: CheckPredicate,
		loc: SourceLoc
	): { readonly filter: RelNode; readonly predicate: ScalarExpr } {
		const typeOf = (name: string): ScalarType | undefined => {
			const leaf = check.leaves.get(name)
			return leaf === undefined ? r.fields.find((f) => f.name === name)?.type : leaf.type
		}
		const attempt = (desc: ExprDesc, emit: (spec: ExprSpec) => ScalarExpr, node: NodeId) =>
			lowerPredicate(desc, {
				...this.#typing,
				closed,
				mode: "check",
				loc,
				emit,
				params: noParams,
				leaf: (leaf: LeafDesc): Result.Result<ExprSpec, CompileError> => {
					if (leaf.kind !== "field") {
						return Result.err(
							malformedDescription(loc, `a field of ${r.name}, not a ${leaf.kind} reference`)
						)
					}
					const named = check.leaves.get(leaf.field)
					if (named === undefined) {
						const field = r.fields.find((f) => f.name === leaf.field)
						return field === undefined
							? Result.err(malformedDescription(loc, `a field of ${r.name}, not ${leaf.field}`))
							: Result.ok(columnLeaf(node, field))
					}
					switch (named.kind) {
						case "law":
							return Result.ok(regionColumn(node, this.#lawColumn(named.column), named.type))
						case "literal":
							return Result.ok({
								kind: "literal",
								value: named.literal,
								args: [],
								type: named.type,
								nonNull: "literal"
							})
					}
				}
			})
		const trial = new DagBuilder(makeIdSupply())
		const placeholder = trial.reserve()
		const plain = attempt(check.predicate, (spec) => trial.expr(spec), placeholder)
		const desc = plain.ok ? check.predicate : baseLeaves(check.predicate, typeOf)
		const region = ext.scan(r, r.fields, [])
		const lowered = unwrap(attempt(desc, (spec) => ext.expr(spec), region.id)).expr
		return { filter: ext.filter(region, lowered), predicate: lowered }
	}

	#materialize(
		n: PlacedNative,
		plan: LawPlan,
		deferred: Deferral,
		renamed: (e: ScalarExpr) => ScalarExpr
	): NativeObject {
		const lawIds: NonEmptyReadonlyArray<LawId> = [plan.law.id]
		switch (n.kind) {
			case "PrimaryKey":
			case "RosterDomain":
				return { ...n, lawIds }
			case "WithoutOverlaps": {
				const span = this.#column(n.span)
				const key = this.#spanKey(n.key)
				const columns = [...key.scalars, span]
				return {
					kind: "WithoutOverlaps",
					relation: n.relation,
					span,
					key,
					named:
						n.named ??
						this.#named(identity.key(n.relation.name, this.#keyNames(n.relation, columns))),
					lawIds
				}
			}
			case "ClosedCheck":
				return {
					kind: "ClosedCheck",
					relation: n.relation,
					target: n.target,
					side: n.side,
					pairs: mapNonEmpty(n.pairs, (p) => ({
						source: this.#column(p.source),
						target: p.target
					})),
					guard: n.guard.map((g) => ({ predicate: renamed(g.predicate), reads: g.reads })),
					lawIds
				}
			case "ReverseIndex":
				return n.method === "hash"
					? {
							kind: "ReverseIndex",
							relation: n.relation,
							method: n.method,
							columns: [this.#column(n.columns[0])],
							lawIds
						}
					: {
							kind: "ReverseIndex",
							relation: n.relation,
							method: n.method,
							columns: mapNonEmpty(n.columns, (c) => this.#column(c)),
							lawIds
						}
			case "Unique": {
				/** A generated unique over the column set of a declared scalar key is that key; a span key is WITHOUT
				 * OVERLAPS, not a B-tree uniqueness, so its exact-repeat arbiter stays its own object. */
				const target = n.relation
				const fields = n.columns.every((c) => c.kind === "field")
					? plainFields(n.columns.map((c) => this.#column(c)))
					: undefined
				const declared =
					fields === undefined
						? undefined
						: target.keyNames.find(
								(k) => k.span === undefined && sameMembers<LawField>(k.fields, fields)
							)
				if (declared === undefined) {
					return {
						kind: "Unique",
						relation: target,
						columns: mapNonEmpty(n.columns, (c) => this.#column(c)),
						lawIds
					}
				}
				const columns = declared.fields
				return declared.primary
					? {
							kind: "PrimaryKey",
							relation: target,
							columns,
							named: declared.named,
							lawIds
						}
					: {
							kind: "Unique",
							relation: target,
							columns: mapNonEmpty(columns, (field): NativeColumn => ({ kind: "field", field })),
							lawIds
						}
			}
			case "Domain": {
				const info = unwrap(this.#typing.contractInfo(n.contract.desc, n.contract.loc))
				return {
					kind: "Domain",
					name: n.contract.name,
					base: info.base,
					check: domainCheck(info),
					lawIds
				}
			}
			case "TableCheck":
				return {
					kind: "TableCheck",
					relation: n.relation,
					check: { kind: "declared", name: n.name, named: n.named },
					predicate: renamed(n.predicate),
					lawIds
				}
			case "LoweredCheck":
				return {
					kind: "TableCheck",
					relation: n.relation,
					check: { kind: "generated", law: plan.law.id },
					predicate: renamed(n.predicate),
					lawIds
				}
			case "LoweredColumn": {
				const c = n.column
				return {
					kind: "LawColumn",
					relation: c.relation,
					column: this.#lawColumn(c),
					field: heldField(c),
					value:
						n.value.kind === "drawn"
							? n.value
							: {
									kind: "generated",
									guard: n.value.guard.map(renamed),
									term: renamed(n.value.term)
								},
					lawIds
				}
			}
			case "ForeignKey":
				return {
					kind: "ForeignKey",
					relation: n.relation,
					columns: mapNonEmpty(n.columns, (c) => this.#column(c)),
					target: n.target,
					targetColumns: mapNonEmpty(n.targetColumns, (c) => this.#column(c)),
					deferrable: deferrable(n, deferred),
					onUpdate: n.onUpdate,
					lawIds
				}
			case "PeriodForeignKey":
				return {
					kind: "PeriodForeignKey",
					relation: n.relation,
					columns: n.columns.map((c) => this.#column(c)),
					span: this.#column(n.span),
					target: n.target,
					targetColumns: n.targetColumns.map((c) => this.#column(c)),
					targetSpan: this.#column(n.targetSpan),
					deferrable: deferred.rule({
						relation: n.relation,
						target: n.target,
						targetFields: n.targetColumns.flatMap((c) => (c.kind === "field" ? [c.field] : []))
					}),
					lawIds
				}
		}
	}

	/** A planned span key's scalar columns as the native reads them. */
	#spanKey(key: PlannedSpanKey): SpanKeyScalars {
		switch (key.kind) {
			case "primary":
				return { kind: "primary", scalars: mapNonEmpty(key.scalars, (c) => this.#column(c)) }
			case "unique":
				return { kind: "unique", scalars: key.scalars.map((c) => this.#column(c)) }
		}
	}

	/** The installed identifier of one native object, minted at the naming door (see `compileLaws`). `reported` is the
	 * identity of the law it reports, its first: the law of the plan that first built it, `described`. */
	#name(object: NativeObject, reported: Identity<"law">, described: Law): NamedNative {
		const ownedKey = (relation: LawRelation, columns: ReadonlyArray<LawField>) =>
			relation.keyNames.find((k) => !k.primary && sameOrder<LawField>(k.fields, columns))
		const constraint = (
			on: NativeOf<ConstraintNativeKind>,
			named: Identity<"primaryKey" | "key" | "check" | "generatedCheck" | "foreignKey">
		): NamedNative => ({
			object: on,
			named,
			namespace: "constraint",
			owner: on.relation.ident,
			described
		})
		const side = (relation: LawRelation, fields: ReadonlyArray<KeyColumnName>): KeySide => ({
			relation: relation.name,
			fields
		})
		const foreignKey = (
			on: NativeOf<"ForeignKey" | "PeriodForeignKey">,
			from: KeySide,
			to: KeySide,
			period: boolean
		): NamedNative => constraint(on, this.#named(identity.foreignKey(from, to, period)))
		switch (object.kind) {
			case "PrimaryKey":
				return constraint(object, object.named)
			case "Unique": {
				const fields = plainFields(object.columns)
				const k = fields === undefined ? undefined : ownedKey(object.relation, fields)
				return constraint(
					object,
					k === undefined
						? this.#named(
								identity.key(object.relation.name, this.#keyNames(object.relation, object.columns))
							)
						: k.named
				)
			}
			case "WithoutOverlaps":
				return constraint(object, object.named)
			case "TableCheck":
				return constraint(
					object,
					object.check.kind === "declared"
						? object.check.named
						: this.#named(identity.generatedCheck(object.relation.name, reported))
				)
			case "ClosedCheck":
				return constraint(
					object,
					this.#named(identity.generatedCheck(object.relation.name, reported))
				)
			case "ForeignKey":
				return foreignKey(
					object,
					side(object.relation, this.#keyNames(object.relation, object.columns)),
					side(object.target, this.#keyNames(object.target, object.targetColumns)),
					false
				)
			case "PeriodForeignKey":
				return foreignKey(
					object,
					side(object.relation, this.#keyNames(object.relation, [...object.columns, object.span])),
					side(
						object.target,
						this.#keyNames(object.target, [...object.targetColumns, object.targetSpan])
					),
					true
				)
			case "LawColumn": {
				const { named, plan } = this.#planned(object.relation, object.column)
				return { object, named, plan, namespace: "column", owner: object.relation.ident }
			}
			case "Domain":
				return { object, namespace: "domain" }
			case "RosterDomain":
			case "ReverseIndex":
				return { object, namespace: "unnamed" }
		}
	}
}

/** Whether a law is a key, a declared one or one over a projected side, whose violation an object it plans reports. */
const isKeyLaw = (law: TheoryLaw): boolean =>
	law.detail.kind === "key" || law.detail.kind === "projectedKey"

/** The field whose values a law column holds, its type the column's and an index entry over it sized as one of the
 * field's: a term's own field, a constant's target field, a drawn column's or a counted predecessor's count. */
const heldField = (c: LawColumnPlan): LawField => {
	switch (c.kind) {
		case "constant":
		case "drawn":
		case "indexPred":
			return c.field
		case "term":
			return c.term.column
	}
}

/** A law column's identity at the naming door, by what it is (core/identity.ts LawColumnStatement): a constant by
 * its target, field and value; a term by its kind, its field and its selection's conjuncts' canonical texts; a drawn
 * column as its plan states it, by its family and what it draws, a hidden accumulator by its fold's law; a counted
 * family's ‹p› by its family. */
const lawColumnIdentity = (plan: LawColumnPlan): Identity<"lawColumn"> => {
	switch (plan.kind) {
		case "constant":
			return identity.lawColumn({
				kind: "constant",
				target: plan.target.name,
				field: plan.field.name,
				value: identityValueOf(plan.value)
			})
		case "term":
			return identity.lawColumn({
				kind: "term",
				term: { kind: plan.term.kind, field: plan.term.field },
				selection: plan.selection.conjuncts.map((c) => c.text)
			})
		case "drawn":
			return identity.lawColumn(plan.named)
		case "indexPred":
			return identity.lawColumn(plan.named)
	}
}

const columnLeaf = (node: NodeId, field: LawField): ExprSpec => ({
	kind: "column",
	column: { node, name: field.name },
	args: [],
	type: field.type,
	nonNull: "storage"
})

/** The predicate with every field leaf of a contract type read as its base (Compute.base), at any depth. A leaf already
 * under a base stays as it is. */
const baseLeaves = (
	predicate: ExprDesc,
	typeOf: (name: string) => ScalarType | undefined
): ExprDesc => {
	const walk = (d: ExprDesc): ExprDesc => {
		switch (d.kind) {
			case "field": {
				const type = typeOf(d.field)
				return type !== undefined && contractOf(type) !== undefined ? { kind: "base", arg: d } : d
			}
			case "compute":
				return { ...d, args: d.args.map(walk) }
			case "compare":
				return { ...d, left: walk(d.left), right: walk(d.right) }
			case "and":
			case "or":
				return { ...d, args: mapNonEmpty(d.args, walk) }
			case "not":
			case "cast":
			case "in":
				return { ...d, arg: walk(d.arg) }
			case "cond":
				return { ...d, pred: walk(d.pred), onTrue: walk(d.onTrue), onFalse: walk(d.onFalse) }
			case "when":
				return {
					...d,
					subject: walk(d.subject),
					proved: walk(d.proved),
					otherwise: walk(d.otherwise)
				}
			case "between":
				return { ...d, arg: walk(d.arg), low: walk(d.low), high: walk(d.high) }
			case "allen":
				return { ...d, left: walk(d.left), right: walk(d.right) }
			case "pointIn":
				return { ...d, point: walk(d.point), span: walk(d.span) }
			case "closedAt":
			case "closedHas":
				return { ...d, args: mapNonEmpty(d.args, walk) }
			case "closedRow":
				return { ...d, args: d.args.map(walk) }
			case "base":
			case "literal":
			case "param":
			case "absent":
			case "var":
			case "value":
			case "parent":
				return d
		}
	}
	return walk(predicate)
}

const specialize = (
	theory: Theory,
	checked: CheckedSchema,
	slice: Slice,
	cycles: CycleSource,
	discharge: RuleDischarge
): Result.Result<LawModel, CompileError> =>
	catchRefusal(() => new Specializer(theory, checked, slice, cycles, discharge).run())

/** Law specialization: an owned schema's CheckedTheory with every law lowered to its natives. It runs theory
 * normalization with the law identities the naming door gives (theory.ts lawIdentityOf), recognizes every normalized
 * law (`Recognizer`), and settles what depends on the whole schema at once:
 *
 * - Law columns: each term of a selected side and each pred term is a STORED generated column of its relation, a
 *   constant selection of a target a STORED constant column of its source, and a family's ‹n›, counted index, tree's
 *   ‹ps› and hidden fold accumulators plain columns the host draws, each named once by what it is
 *   (identity.lawColumn) and lowered once over its table's row. The generated UNIQUE a reference needs is over exactly
 *   the target's columns, a constant selection's the target's fields then its selector fields. A generated unique
 *   whose column set is a declared key of the target is that key.
 * - Foreign key deferral: a family axis's is its own (the owner axis deferred where its ON UPDATE CASCADE feeds its
 *   target, a tree's from its plain parent with no action and immediate, an ordered predecessor immediate, a counted
 *   predecessor and every last axis deferred), but an owner axis otherwise immediate that lies on a cycle of the
 *   foreign keys that order a write's statements is deferred, since a law's key closes that cycle with it. Any other
 *   foreign key, a PERIOD one included, is deferred exactly when a lawful final-state ChangeSet could break it in
 *   passing: when its target can be replaced at the referenced key, because the target has a field it does not
 *   reference as a plain column, so a put or a deletion and an addition at that key deletes the referenced row before
 *   inserting its replacement; or when it lies on a cycle of the foreign keys that order a write's statements, those
 *   and every family axis its family does not fix deferred, where neither side can be inserted first. A PERIOD
 *   foreign key references its target's span as a period, never as a plain column, so it is always deferred: the
 *   facts covering a referenced span can be replaced by others that still cover it, a span cut or split, and the
 *   target's WITHOUT OVERLAPS key admits the replacements only once the facts they overlap are deleted. Any role
 *   over the schema may write any ordinary relation, and roles are defined beside the schema, never in it, so the
 *   schema's own laws are the same whoever writes. Otherwise it is immediate, and so is the evidence it gives
 *   (theoryEvidence).
 * - Naming and the constraint-to-LawId map: every native object's installed identifier, minted at the naming door
 *   from its identity, and for each table constraint every law it discharges; a law column reports no violation, and
 *   an unnamed native has no identifier to report. A primary key native is the relation's declared primary key, which
 *   ownership named. A generated CHECK is named for its table and the law it specializes (identity.generatedCheck), so
 *   a law states one CHECK per table, the conjunction of every row condition it states there. A native object that
 *   discharges several laws is one object listing them all; its violation reports the first, a key law's when one
 *   plans it, since key laws are merged first, and a family axis's former's.
 * - Rules over queries: a containment into a key-shaped conjunction of stored relations (analysis/theory/laws.ts
 *   RuleLowering) is discharged by one deferred foreign key per match of its target's definition, each planned as the
 *   containment into a select() side it is (plan.ts #scalarContainment), and listed in the constraint map under the
 *   rule's law. Any other rule one of whose sides reads a derived relation is discharged by triggers, never by a native
 *   object: one deferred constraint trigger per ordinary relation it reads, all under one name, a check's own and any
 *   other rule's minted from its law (identity.lawTrigger), each running a function of its own
 *   (identity.lawFunction), and each listed in the constraint map under its table, so a violation it raises names the
 *   rule. A rule that reads closed relations alone is discharged by the migration, as every such law is.
 * - The DAG: the theory's lowered fold selections plus each declared and generated CHECK's predicate and each
 *   generated law column's value, each lowered here over its relation's row.
 *
 * - Slice: the model serves the writes of its slice (schema/reach.ts Slice), and holds exactly the natives those
 *   writes can break or read, with every native a read relies on (Specializer.#held): an installation's, writing every
 *   ordinary relation, holds them all; a login's runtime, writing the relations its roles write, holds no other native
 *   and no rule that reads none of them, each a constraint no write of the login can raise. Under planned cycles
 *   (CycleSource) the model plans every law, whose plans settle the foreign key graph's cycles; under the cycles
 *   generate recorded from every law, it plans only the laws a compile over its slice reads (readBySlice). A law's plan
 *   reads the law and the recognizer's indexes of every law, and its deferral its own plan and the cycles, so each law
 *   it plans is planned, deferred, proved immediate and gives evidence as in the whole schema's model.
 *
 * The law model of an owned schema for `slice` under `cycles`, or the first refusal: a theory refusal, a law shape the
 * compiler does not admit (UnsupportedLawFamily) or an unrepresentable key. The theory is normalized once and each law
 * it plans planned once: the cycles settle foreign key deferral and so the laws the plans prove immediate (immediateOf),
 * and specialization states the evidence each law gives with that validity context (theoryEvidence). */
export const compileLaws = (
	owned: Owned,
	slice: Slice,
	cycles: CycleSource
): Result.Result<LawModel, CompileError> => dischargedLaws(owned, slice, cycles, "native")

/**
 * The law model of an owned schema for `slice` as the law oracle's conservative installation holds it
 * (physical/install/compile.ts conservativeInstallation): compileLaws's, its cycles planned from every law, with every
 * rule over a query discharged by its triggers, a rule that lowers to foreign keys among them, so its laws are the same
 * laws under the same identities.
 */
export const conservativeLaws = (
	owned: Owned,
	slice: Slice
): Result.Result<LawModel, CompileError> =>
	dischargedLaws(owned, slice, { kind: "planned" }, "triggers")

/** The law model of `owned` for `slice` under `cycles`, its rules over queries that lower to foreign keys discharged
 * as `discharge` says. */
const dischargedLaws = (
	owned: Owned,
	slice: Slice,
	cycles: CycleSource,
	discharge: RuleDischarge
): Result.Result<LawModel, CompileError> =>
	Result.flatMap(checkedSchema(owned, slice), (checked) =>
		Result.flatMap(buildTheory(checked), (theory) =>
			specialize(theory, checked, slice, cycles, discharge)
		)
	)

/**
 * Every law the model still discharges by deferred constraint triggers, once rules that lower to foreign keys are
 * lowered, whose trigger fires on `relation` or whose query reads it: on either side, by a match or a negation, at any
 * depth of the derived relations it reads (analysis/theory/query.ts ruleReads), so a superset only of the laws a write
 * of `relation` or a read of it by a trigger can involve. Empty exactly when every law over `relation` is native, a key,
 * a CHECK, a domain or a foreign key, a lowered rule's among them, and no remaining trigger reads it. A model holds the
 * rules its slice's writes can fire (`compileLaws`), so a reader that asks about every writer, the isolation
 * certifier's, asks the installation's model, whose slice writes every ordinary relation.
 */
export const triggerLawsOver = (model: LawModel, relation: string): ReadonlyArray<LawId> =>
	model.rules.flatMap((r) =>
		r.law.reads.includes(relation) || r.tables.some((t) => t.relation.name === relation)
			? [r.law.id]
			: []
	)

/**
 * The theory an owned schema states for `slice`: its checked schema's (analysis/theory/theory.ts buildTheory), with
 * every refusal the check and the theory raise, and none of the specialization compileLaws adds. What a reader of the
 * schema's laws alone reads: a lower level's, which the snapshot records (deploy/snapshot/build.ts levelsOf).
 */
export const statedTheory = (owned: Owned, slice: Slice): Result.Result<Theory, CompileError> =>
	Result.flatMap(checkedSchema(owned, slice), buildTheory)
