import { type CheckedSchema, checkedSchema } from "#compiler/analysis/schema.ts"
import { ViolationBuilder } from "#compiler/analysis/theory/build.ts"
import { lawDescription } from "#compiler/analysis/theory/description.ts"
import type { TheoryLaw } from "#compiler/analysis/theory/laws.ts"
import {
	buildTheory,
	type PrimaryKeyLaw,
	provisionalTheory,
	type Theory,
	typingEnv
} from "#compiler/analysis/theory/theory.ts"
import { sameMembers, sameOrder } from "#compiler/core/array.ts"
import { catchRefusal, encode, everyProperty, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import {
	type Identity,
	identifierOf,
	identity,
	type KeyColumnName,
	type KeySide,
	type LawEvent
} from "#compiler/core/identity.ts"
import {
	type ColumnIdent,
	type ConstraintName,
	type DomainName,
	type Identifier,
	type IdentityKind,
	type LawId,
	makeIdSupply,
	type NodeId,
	type RelationIdent
} from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import { mergeDags } from "#compiler/ir/dag.ts"
import { descText, type ExprDesc, type Located } from "#compiler/ir/desc.ts"
import { type ExprSpec, identityValueOf, type ScalarExpr } from "#compiler/ir/expr.ts"
import {
	type AlternativesParticipant,
	type DomainCheck,
	type DomainCheckTerm,
	type DomainNative,
	type EventsOf,
	type EventUnit,
	type FamilyDetail,
	fieldNames,
	headingColumns,
	type Images,
	type KeyImage,
	type LawColumnValue,
	type LawField,
	type LawLowering,
	type LawRelation,
	mapEvents,
	type NativeColumn,
	type NativeObject,
	type NativeOf,
	plainFields,
	type Participant,
	type RelationInfo,
	type ResidualLaw,
	type SpanKeyScalars,
	type TheoryRelation,
	type UpdateOf,
	withParticipants
} from "#compiler/ir/law.ts"
import type { ConstraintLaws } from "#compiler/ir/products.ts"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import { type ContractInfo, contractOf, textOf } from "#compiler/ir/scalar.ts"

import {
	type AlternativesPlan,
	type CheckPredicate,
	type CheckRefs,
	type CheckTerm,
	type ImagePlan,
	type LawColumnPlan,
	type LawPlan,
	type NativePlan,
	type ParticipantPlan,
	type PlannedColumn,
	type PrimaryKeyPlan,
	primaryKeyPlan,
	Recognizer
} from "#compiler/laws/model/plan.ts"
import { type RelationLaws, relationLaws } from "#compiler/laws/model/uniques.ts"
import {
	type LeafDesc,
	lowerPredicate,
	lowerTerm,
	noParams
} from "#compiler/scalar/compute/lower.ts"
import { guardedTerm } from "#compiler/scalar/natural.ts"
import type { Owned } from "#compiler/schema/own.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"

/** The native objects installed as a table constraint: keys, CHECKs and references. */
export type ConstraintNativeKind =
	| "PrimaryKey"
	| "Unique"
	| "WithoutOverlaps"
	| "TemporalUnique"
	| "TableCheck"
	| "FiniteCheck"
	| "ForeignKey"
	| "PeriodForeignKey"

/** A native object with the identity its installed name was minted from, its namespace, and its owner: the table
 * identifier, or a contract domain's identifier. Each namespace holds exactly its kinds of object: a table constraint, a
 * law column, a contract's domain, or an object the law model names nothing for. A table constraint carries the
 * description of the law its violation reports. */
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
			readonly owner: RelationIdent
	  }
	| {
			readonly object: DomainNative
			readonly namespace: "domain"
			readonly owner: DomainName
			readonly check: NamedDomainCheck
	  }
	| { readonly object: NativeOf<"Enum" | "ReverseIndex">; readonly namespace: "unnamed" }

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

/** A primary key's planned object as the model holds it, discharging `lawIds`. */
const primaryNative = (
	plan: PrimaryKeyPlan,
	lawIds: NonEmptyReadonlyArray<LawId>
): PrimaryNative => ({
	...plan,
	lawIds
})

/** A primary key named by the identity ownership named it by. */
const namedPrimaryKey = (object: PrimaryNative, described: Law): NamedPrimaryKey => ({
	object,
	named: object.named,
	namespace: "constraint",
	owner: object.relation.ident,
	described
})

/** A contract domain's CHECK as installed: none, or its constraint's identifier in the domain's constraint namespace
 * with the terms it conjoins (`DomainCheck`). */
export type NamedDomainCheck =
	| { readonly kind: "unchecked" }
	| {
			readonly kind: "checked"
			readonly ident: ConstraintName
			readonly terms: NonEmptyReadonlyArray<DomainCheckTerm>
	  }

/** One entry of the constraint-to-LawId map: the identifier a violation reports (a table constraint or a domain
 * constraint), the table or domain that owns it, the law it reports and that law's description. */
export type ConstraintLaw =
	| {
			readonly kind: "constraint"
			readonly name: ConstraintName
			readonly owner: RelationIdent
			readonly law: LawId
			readonly described: Law
	  }
	| {
			readonly kind: "domainConstraint"
			readonly name: ConstraintName
			readonly owner: DomainName
			readonly law: LawId
			readonly described: Law
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

/** The constraint map of a list of entries, by owner and name. A constraint name is scoped to its table or domain, so
 * each owner and name is one entry. */
export const constraintLawMap = (entries: ReadonlyArray<ConstraintLaw>): ConstraintLaws => {
	const tables = new Map<string, Map<string, LawId>>()
	const domains = new Map<string, Map<string, LawId>>()
	for (const c of entries) {
		const byOwner = c.kind === "domainConstraint" ? domains : tables
		const named = byOwner.get(c.owner) ?? new Map<string, LawId>()
		named.set(c.name, c.law)
		byOwner.set(c.owner, named)
	}
	return Object.freeze({ tables: frozenOwners(tables), domains: frozenOwners(domains) })
}

export interface LawModel {
	/** The owned schema the model specializes: every installed identifier a law reads (a table, a column, an enum type, a
	 * declared key or check) is the one ownership registered there. */
	readonly owned: Owned
	/** The theory with every law's lowering, and its DAG extended. */
	readonly theory: Theory
	/** Every native object of the schema's laws, once each, in law order. */
	readonly natives: ReadonlyArray<NamedNative>
	readonly residuals: ReadonlyArray<ResidualLaw>
	readonly constraints: ReadonlyArray<ConstraintLaw>
	readonly constraintToLaw: ConstraintLaws
	/** Every identity the law model mints beyond ownership's: its laws', its natives' and tags', its residual laws'
	 * functions' and triggers'. */
	readonly identities: ReadonlyArray<Identity<IdentityKind>>
	/** The laws whose containment evidence holds at every statement (an immediate foreign key or a CHECK). */
	readonly immediate: ReadonlySet<LawId>
	/** Each ordinary relation by name, with its primary key and the unique objects its natives install (uniques.ts
	 * relationLaws): one per primary key the model seeds, so one per ordinary relation. */
	readonly relations: ReadonlyMap<string, RelationLaws>
	/** The checker's reading of the owned schema, whose relation handles the theory's laws read. */
	readonly checked: CheckedSchema
}

/** A participant's events, each with the images it checks, before its units are named. */
type PlannedEvents = EventsOf<Images, UpdateOf>

/** A participant as planned, with its events before its units are named. */
interface Planned<P extends ParticipantPlan> {
	readonly plan: P
	readonly events: PlannedEvents
}

const unwrap = <A>(r: Result.Result<A, CompileError>): A => {
	if (!r.ok) {
		throw new Refusal(r.error)
	}
	return r.value
}

/** The law a violation of a native object reports: the first it discharges. */
const reportedLaw = (object: NativeObject): LawId => object.lawIds[0]

/** A native object as its structural identity reads it, every law it discharges left out: each handle by its name, so
 * two plans of one object are one object. */
const nativeIdentity = (object: NativeObject): unknown => {
	const { lawIds: _ignored, ...rest } = object
	switch (rest.kind) {
		case "PrimaryKey":
			return { ...rest, relation: rest.relation.name, columns: fieldNames(rest.columns) }
		case "Unique":
		case "ReverseIndex":
			return { ...rest, relation: rest.relation.name, columns: columnNames(rest.columns) }
		case "LawColumn":
			return { kind: rest.kind, relation: rest.relation.name, column: rest.column }
		case "PeriodForeignKey":
			return {
				...rest,
				relation: rest.relation.name,
				columns: columnNames(rest.columns),
				span: rest.span.name,
				target: rest.target.name,
				targetColumns: columnNames(rest.targetColumns),
				targetSpan: rest.targetSpan.name
			}
		case "WithoutOverlaps":
			return {
				...rest,
				relation: rest.relation.name,
				span: rest.span.name,
				key: { kind: rest.key.kind, scalars: fieldNames(rest.key.scalars) }
			}
		case "TemporalUnique":
			return {
				...rest,
				relation: rest.relation.name,
				columns: fieldNames(rest.columns),
				span: rest.span.name
			}
		case "TableCheck":
			return { ...rest, relation: rest.relation.name }
		case "FiniteCheck":
			return {
				...rest,
				relation: rest.relation.name,
				facts: rest.facts.map((fact) => fact.map((v) => ({ field: v.field.name, value: v.value })))
			}
		case "ForeignKey":
			return {
				...rest,
				relation: rest.relation.name,
				columns: columnNames(rest.columns),
				target: rest.target.name,
				targetColumns: columnNames(rest.targetColumns)
			}
		case "Domain":
		case "Enum":
			return rest
	}
}

/** The names of a native's columns: a field's name, a law column's identifier. */
const columnNames = (columns: ReadonlyArray<NativeColumn>): ReadonlyArray<string> =>
	columns.map((c) => (c.kind === "field" ? c.field.name : c.column))

const structuralKey = (object: unknown): string => {
	const text = encode(object, everyProperty)
	if (!text.ok) {
		throw new Refusal(text.error)
	}
	return text.value
}

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

/** Strongly connected relations of the foreign key graph (iterative Tarjan); an edge whose ends share a component, a
 * self-reference included, lies on a cycle. */
const cycleEdges = (
	edges: ReadonlyArray<readonly [string, string]>
): ((from: string, to: string) => boolean) => {
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
	return (from, to) => component.get(from) === component.get(to)
}

/** A plain foreign key as the deferral asks about it: its relation, its target and the target's fields it references
 * as plain columns. */
interface DeferralQuery {
	readonly relation: TheoryRelation
	readonly target: TheoryRelation
	readonly targetFields: ReadonlyArray<LawField>
}

/** A plan's native object as the specializer materializes it: a generated CHECK with its predicate lowered into the
 * extension DAG (`#lowerCheck`), a law column with its value lowered there (`#lowerColumn`), every other as its plan
 * states it. */
type PlacedNative =
	| Exclude<NativePlan, { readonly kind: "GeneratedCheck" | "LawColumn" }>
	| {
			readonly kind: "LoweredCheck"
			readonly relation: TheoryRelation
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

/**
 * The law columns' values lowered into the extension DAG in "check" mode, where no operation raises, over one scan of
 * each relation's row: each guard conjunct once per relation, by its canonical text, so two columns of one guard read
 * one expression and a UNIQUE over them states it once (uniques.ts); each column's value once per relation and
 * identity, reached from a root of its own. A term's column is guarded by its side's selection's conjuncts, then by
 * its term's own guard (scalar/natural.ts guardedTerm: pred(x) above zero); a constant is its literal under no guard.
 */
class ColumnLowering {
	readonly #ext: ViolationBuilder
	readonly #typing: ReturnType<typeof typingEnv>
	readonly #roots: Array<RelNode>
	readonly #rows = new Map<string, ColumnRow>()

	constructor(ext: ViolationBuilder, typing: ReturnType<typeof typingEnv>, roots: Array<RelNode>) {
		this.#ext = ext
		this.#typing = typing
		this.#roots = roots
	}

	value(plan: LawColumnPlan, named: Identity<"lawColumn">, loc: SourceLoc): LawColumnValue {
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

	#lower(row: ColumnRow, plan: LawColumnPlan, loc: SourceLoc): LawColumnValue {
		switch (plan.kind) {
			case "constant":
				return { guard: [], term: this.#ext.typed(plan.value, plan.field.type) }
			case "term": {
				const own = guardedTerm(plan.term)
				return {
					guard: [
						...plan.selection.conjuncts.map((c) => this.#guard(row, c.predicate, c.text, loc)),
						...own.guard.map((g) => this.#guard(row, g, unwrap(descText(g)), loc))
					],
					term: unwrap(lowerTerm(own.term, this.#env(row, loc))).expr
				}
			}
		}
	}

	#guard(row: ColumnRow, predicate: ExprDesc, text: string, loc: SourceLoc): ScalarExpr {
		const known = row.guards.get(text)
		if (known !== undefined) {
			return known
		}
		const lowered = unwrap(lowerPredicate(predicate, this.#env(row, loc))).expr
		row.guards.set(text, lowered)
		return lowered
	}

	#env(row: ColumnRow, loc: SourceLoc) {
		return {
			...this.#typing,
			mode: "check" as const,
			loc,
			emit: (spec: ExprSpec) => this.#ext.expr(spec),
			params: noParams,
			leaf: row.leaf
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
	readonly recognizer: Recognizer
	/** The typing environment every lowering of the model reads, each text pattern analyzed once in it. */
	readonly #typing: ReturnType<typeof typingEnv>
	readonly #minted: Array<Identity<IdentityKind>> = []
	/** Each law column's identity, which names its native once it is merged, by its relation and identifier. */
	readonly #lawColumns = new Map<string, Map<ColumnIdent, Identity<"lawColumn">>>()

	constructor(theory: Theory, checked: CheckedSchema) {
		this.theory = theory
		this.checked = checked
		this.owned = checked.owned
		this.recognizer = new Recognizer(theory.laws)
		this.#typing = typingEnv(checked.owned)
	}

	/** The identifier of a law column, its identity kept to name its native. */
	#lawColumn(plan: LawColumnPlan): ColumnIdent {
		const named = this.#named(lawColumnIdentity(plan))
		const column = identifierOf(named)
		const own =
			this.#lawColumns.get(plan.relation.name) ?? new Map<ColumnIdent, Identity<"lawColumn">>()
		own.set(column, named)
		this.#lawColumns.set(plan.relation.name, own)
		return column
	}

	/** The identity of the law column `column` of `relation`, which every law column the model names was minted with. */
	#lawColumnNamed(relation: LawRelation, column: ColumnIdent): Identity<"lawColumn"> {
		const named = this.#lawColumns.get(relation.name)?.get(column)
		if (named === undefined) {
			throw defect(`the law column ${column} of ${relation.name}, minted as it is planned`)
		}
		return named
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

	/** The identifier of an identity the law model mints, kept for the installation's census and comments. */
	#mint<K extends IdentityKind>(named: Identity<K>): Identifier<K> {
		return identifierOf(this.#named(named))
	}

	/** An identity the law model mints, kept for the installation's census and comments. */
	#named<K extends IdentityKind>(named: Identity<K>): Identity<K> {
		this.#minted.push(named)
		return named
	}

	run(): LawModel {
		const plans = this.theory.laws.map((law) => this.recognizer.plan(law))
		const deferred = this.#deferral(plans)

		/** The extension DAG: generated CHECK predicates and the residual laws' affected-key extraction. */
		const ext = new ViolationBuilder(SourceLoc(`schema ${this.owned.name}`, []))
		const roots: Array<RelNode> = []
		const columns = new ColumnLowering(ext, this.#typing, roots)
		/** Each plan with its native objects, a generated CHECK's predicate and a law column's value lowered into the
		 * extension DAG. */
		const placed = plans.map((plan) => ({
			plan,
			natives: plan.natives.map((n): PlacedNative => {
				if (n.kind === "GeneratedCheck") {
					const { filter, predicate } = this.#lowerCheck(ext, n.relation, n.predicate, plan.law.loc)
					roots.push(filter)
					return { kind: "LoweredCheck", relation: n.relation, predicate }
				}
				if (n.kind === "LawColumn") {
					return {
						kind: "LoweredColumn",
						column: n.column,
						value: columns.value(n.column, lawColumnIdentity(n.column), plan.law.loc)
					}
				}
				return n
			})
		}))
		/** Each row image's anchor key, read from a Delta of the participant, of its added facts for an INSERT's image on
		 * NEW and its removed facts for a DELETE's on OLD, and made reachable by a ProjectSet named by the anchor key's
		 * fields. */
		const keyImage = (
			relation: TheoryRelation,
			image: ImagePlan,
			event: "INSERT" | "DELETE"
		): KeyImage => {
			const delta = ext.node({
				kind: "Delta",
				relation: relation.name,
				side: event === "INSERT" ? "added" : "removed",
				keys: [relation.primaryKey, ...relation.keys],
				heading: headingColumns(relation.fields),
				meta: conservativeMeta,
				loc: undefined
			})
			const key = mapNonEmpty(image.key, (c) => ({
				field: c.field,
				pair: c.pair,
				expr: ext.col(delta, c.field)
			}))
			roots.push(
				ext.project(
					delta,
					key.map((c) => [c.pair.anchor.name, c.expr] as const)
				)
			)
			return { key, guard: image.guard }
		}
		/** The participants with their events, each image's anchor key read from the DAG. */
		const planned = <P extends ParticipantPlan>(
			participants: NonEmptyReadonlyArray<P>
		): NonEmptyReadonlyArray<Planned<P>> =>
			mapNonEmpty(participants, (plan) => ({
				plan,
				events: mapEvents(
					plan.events,
					(images, event) => mapNonEmpty(images, (i) => keyImage(plan.relation, i, event)),
					(of): UpdateOf => ({ of })
				)
			}))
		/** Each residual law's plan with its participants' events, their units to be named, in plan order. */
		const extracted: Array<{
			readonly plan: LawPlan
			readonly residual: Exclude<LawPlan["residual"], undefined>
			readonly participants: FamilyDetail<
				NonEmptyReadonlyArray<Planned<ParticipantPlan>>,
				NonEmptyReadonlyArray<Planned<AlternativesPlan>>
			>
		}> = []
		for (const plan of plans) {
			const residual = plan.residual
			if (residual === undefined) {
				continue
			}
			extracted.push({
				plan,
				residual,
				participants: withParticipants(residual.checks, planned, planned)
			})
		}
		/** A schema with no residual law and no generated CHECK adds nothing to the DAG. */
		const merged =
			roots.length === 0
				? { dag: this.theory.dag, expr: (e: ScalarExpr) => e }
				: mergeDags(this.theory.dag, ext.b.build(roots))

		/** Native objects, merged: each first seen with its law list, which every later plan of the same object extends,
		 * so the object holds every law it discharges once all plans are read. Each ordinary relation's primary key is
		 * seen first, with its own law: a primary key merges only with a plan of the same key. */
		const byKey = new Map<string, Merged>()
		for (const pk of this.theory.primaryKeys) {
			this.#seed(byKey, pk)
		}
		const immediate = new Set<LawId>()
		/** Key laws first, so an object a key law and another law both plan reports the key's law. */
		const keysFirst = [
			...placed.filter((p) => isKeyLaw(p.plan.law)),
			...placed.filter((p) => !isKeyLaw(p.plan.law))
		]
		const nativeObjects = keysFirst.map(({ plan, natives: placedNatives }) => {
			const objects: Array<NativeObject> = []
			for (const n of placedNatives) {
				const object = this.#materialize(n, plan, deferred, (e) => merged.expr(e))
				if (
					(object.kind === "ForeignKey" && !object.deferrable) ||
					object.kind === "FiniteCheck" ||
					(object.kind === "TableCheck" && plan.law.detail.kind === "containment")
				) {
					immediate.add(plan.law.id)
				}
				const key = structuralKey(nativeIdentity(object))
				const known = byKey.get(key)
				if (known === undefined) {
					const laws: [LawId, ...Array<LawId>] = [plan.law.id]
					const seen: NativeObject = { ...object, lawIds: laws }
					byKey.set(key, { kind: "native", object: seen, laws, law: plan.law })
					objects.push(seen)
					continue
				}
				if (!known.laws.includes(plan.law.id)) {
					known.laws.push(plan.law.id)
				}
				objects.push(known.object)
			}
			return { plan, objects }
		})

		/** Names and the constraint map, each object once, in the order it was first seen; each primary key with its
		 * relation. */
		const natives: Array<NamedNative> = []
		const keyed: Array<KeyedRelation> = []
		const constraints: Array<ConstraintLaw> = []
		for (const entry of byKey.values()) {
			const object = entry.object
			const described = lawDescription(entry.law)
			const named = this.#nameMerged(entry, described, keyed)
			natives.push(named)
			if (named.namespace === "constraint") {
				constraints.push({
					kind: named.namespace,
					name: identifierOf(named.named),
					owner: named.owner,
					law: reportedLaw(object),
					described
				})
			} else if (named.namespace === "domain" && named.check.kind === "checked") {
				constraints.push({
					kind: "domainConstraint",
					name: named.check.ident,
					owner: named.owner,
					law: reportedLaw(object),
					described
				})
			}
		}

		/** Residual laws, each participant's event units named for the law, the relation and the event. */
		const residuals: Array<ResidualLaw> = []
		const residualOf = new Map<LawId, ResidualLaw>()
		for (const { plan, residual: r, participants: extractedParticipants } of extracted) {
			const lawId = plan.law.id
			const renamed = (image: KeyImage): KeyImage => ({
				key: mapNonEmpty(image.key, (c) => ({
					field: c.field,
					pair: c.pair,
					expr: merged.expr(c.expr)
				})),
				guard: image.guard
			})
			const unit = <E>(relation: TheoryRelation, event: LawEvent, on: E): EventUnit<E> => ({
				on,
				trigger: this.#named(identity.lawTrigger(plan.law.named, relation.name, event)),
				function: this.#named(identity.lawFunction(plan.law.named, relation.name, event))
			})
			const participant = (p: Planned<ParticipantPlan>): Participant => ({
				relation: p.plan.relation,
				events: mapEvents(
					p.events,
					(images, event) => unit(p.plan.relation, event, mapNonEmpty(images, renamed)),
					(update) => unit(p.plan.relation, "UPDATE", update)
				)
			})
			const family = withParticipants(
				extractedParticipants,
				(ps) => mapNonEmpty(ps, participant),
				(ps) =>
					mapNonEmpty(ps, (p): AlternativesParticipant => ({
						...participant(p),
						check: p.plan.check
					}))
			)
			const residual: ResidualLaw = {
				...family,
				lawId,
				anchor: r.anchor,
				violation: r.violation,
				indexes: mapNonEmpty(r.indexes, (i) => ({
					...i,
					justification: { kind: "law" as const, law: lawId }
				})),
				detail: r.detail
			}
			residuals.push(residual)
			residualOf.set(lawId, residual)
		}

		const lowered: Record<LawId, LawLowering> = {}
		for (const { plan, objects } of nativeObjects) {
			const unique = [...new Set(objects)]
			const residual = residualOf.get(plan.law.id)
			lowered[plan.law.id] = Object.freeze({ natives: unique, residual })
		}
		return {
			owned: this.owned,
			theory: Object.freeze({ ...this.theory, dag: merged.dag, lowerings: Object.freeze(lowered) }),
			natives,
			residuals,
			constraints,
			constraintToLaw: constraintLawMap(constraints),
			identities: [...this.theory.laws.map((law) => law.named), ...this.#minted],
			immediate,
			relations: relationLaws(keyed, natives),
			checked: this.checked
		}
	}

	/** Seeds `byKey` with the primary key of `pk`'s relation, planned from its key and discharging its law. */
	#seed(byKey: Map<string, Merged>, pk: PrimaryKeyLaw): void {
		const laws: [LawId, ...Array<LawId>] = [pk.law.id]
		const object = primaryNative(
			primaryKeyPlan(pk.relation, pk.relation.keyNames[0], pk.law.loc),
			laws
		)
		byKey.set(structuralKey(nativeIdentity(object)), {
			kind: "primary",
			relation: pk.relation,
			object,
			laws,
			law: pk.law
		})
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

	/** Which plain foreign keys are deferred (see `compileLaws`). */
	#deferral(plans: ReadonlyArray<LawPlan>): (fk: DeferralQuery) => boolean {
		const edges = plans.flatMap((plan) =>
			plan.natives.flatMap((n): ReadonlyArray<readonly [string, string]> =>
				n.kind === "ForeignKey" || n.kind === "PeriodForeignKey"
					? [[n.relation.name, n.target.name]]
					: []
			)
		)
		const onCycle = cycleEdges(edges)
		return (fk) =>
			onCycle(fk.relation.name, fk.target.name) ||
			fk.target.fields.some((c) => !fk.targetFields.includes(c))
	}

	/** A generated CHECK predicate lowered in "check" mode over a scan of its table. Each field is
	 * read at its own type, so a literal bound adopts the field's contract as in a declared row check;
	 * when that adoption refuses (a bound outside the contract, or two contracts compared), the comparison is made over
	 * the base types instead, which is the same predicate on every stored value. */
	#lowerCheck(
		ext: ViolationBuilder,
		r: TheoryRelation,
		predicate: CheckPredicate,
		loc: SourceLoc
	): { readonly filter: RelNode; readonly predicate: ScalarExpr } {
		const env = this.#typing
		const attempt = (
			desc: ExprDesc<Located, CheckRefs>,
			emit: (spec: ExprSpec) => ScalarExpr,
			node: NodeId
		) =>
			lowerPredicate(desc, {
				...env,
				mode: "check",
				loc,
				emit,
				params: noParams,
				leaf: (leaf) => Result.ok(columnLeaf(node, leaf.column))
			})
		const trial = new DagBuilder(makeIdSupply())
		const placeholder = trial.reserve()
		const plain = attempt(predicate, (spec) => trial.expr(spec), placeholder)
		const desc = plain.ok ? predicate : baseFields(predicate)
		const region = ext.scan(r, r.fields, [])
		const lowered = unwrap(attempt(desc, (spec) => ext.expr(spec), region.id)).expr
		return { filter: ext.filter(region, lowered), predicate: lowered }
	}

	#materialize(
		n: PlacedNative,
		plan: LawPlan,
		deferred: (fk: DeferralQuery) => boolean,
		renamed: (e: ScalarExpr) => ScalarExpr
	): NativeObject {
		const lawIds: NonEmptyReadonlyArray<LawId> = [plan.law.id]
		switch (n.kind) {
			case "PrimaryKey":
			case "WithoutOverlaps":
			case "Enum":
			case "FiniteCheck":
			case "TemporalUnique":
				return { ...n, lawIds }
			case "ReverseIndex":
				return {
					kind: "ReverseIndex",
					relation: n.relation,
					columns: mapNonEmpty(n.columns, (c) => this.#column(c)),
					lawIds
				}
			case "Unique": {
				/** A generated unique over the column set of a declared scalar key is that key; a span key is WITHOUT
				 * OVERLAPS, not a B-tree uniqueness, so its exact-repeat arbiter stays its own object. */
				const target = n.relation
				const fields = plainFields(n.columns)
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
					named: n.contract.named,
					domain: n.contract.domain,
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
					predicate: n.predicate,
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
					field: c.kind === "constant" ? c.field : c.term.column,
					value: { guard: n.value.guard.map(renamed), term: renamed(n.value.term) },
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
					deferrable: deferred({
						relation: n.relation,
						target: n.target,
						targetFields: n.targetColumns.flatMap((c) => (c.kind === "field" ? [c.field] : []))
					}),
					lawIds
				}
			case "PeriodForeignKey":
				return {
					kind: "PeriodForeignKey",
					relation: n.relation,
					columns: n.columns.map((c) => this.#column(c)),
					span: n.span,
					target: n.target,
					targetColumns: n.targetColumns.map((c) => this.#column(c)),
					targetSpan: n.targetSpan,
					lawIds
				}
		}
	}

	/** The installed identifier of one native object, minted at the naming door (see `compileLaws`). `reported` is the
	 * identity of the law it reports, its first (`reportedLaw`): the law of the plan that first built it, `described`. */
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
		/** A native's columns as its name reads them: a field by its name, a law column by its identity. */
		const named = (relation: LawRelation, columns: ReadonlyArray<NativeColumn>) =>
			columns.map((c): KeyColumnName =>
				c.kind === "field" ? c.field.name : this.#lawColumnNamed(relation, c.column)
			)
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
								identity.key(object.relation.name, named(object.relation, object.columns))
							)
						: k.named
				)
			}
			case "WithoutOverlaps":
				return constraint(object, object.named)
			case "TemporalUnique":
				return constraint(
					object,
					this.#named(
						identity.key(object.relation.name, [...fieldNames(object.columns), object.span.name])
					)
				)
			case "TableCheck":
				return constraint(
					object,
					object.check.kind === "declared"
						? object.check.named
						: this.#named(identity.generatedCheck(object.relation.name, reported))
				)
			case "FiniteCheck":
				return constraint(
					object,
					this.#named(identity.generatedCheck(object.relation.name, reported))
				)
			case "ForeignKey":
				return foreignKey(
					object,
					side(object.relation, named(object.relation, object.columns)),
					side(object.target, named(object.target, object.targetColumns)),
					false
				)
			case "PeriodForeignKey":
				return foreignKey(
					object,
					side(object.relation, [...named(object.relation, object.columns), object.span.name]),
					side(object.target, [
						...named(object.target, object.targetColumns),
						object.targetSpan.name
					]),
					true
				)
			case "LawColumn":
				return {
					object,
					named: this.#lawColumnNamed(object.relation, object.column),
					namespace: "column",
					owner: object.relation.ident
				}
			case "Domain": {
				const check = object.check
				if (check.kind === "unchecked") {
					return { object, namespace: "domain", owner: object.domain, check }
				}
				return {
					object,
					namespace: "domain",
					owner: object.domain,
					check: {
						kind: "checked",
						ident: this.#mint(identity.domainCheck(object.named)),
						terms: check.terms
					}
				}
			}
			case "Enum":
			case "ReverseIndex":
				return { object, namespace: "unnamed" }
		}
	}
}

/** Whether a law is a key, a declared one or one over a projected side, whose violation an object it plans reports. */
const isKeyLaw = (law: TheoryLaw): boolean =>
	law.detail.kind === "key" || law.detail.kind === "projectedKey"

/** A law column's identity at the naming door, by what it is (core/identity.ts LawColumnStatement): a constant by
 * its target, field and value; a term by its kind, its field and its selection's conjuncts' canonical texts. */
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
	}
}

const columnLeaf = (node: NodeId, field: LawField): ExprSpec => ({
	kind: "column",
	column: { node, name: field.name },
	args: [],
	type: field.type,
	nonNull: "storage"
})

/** The predicate with every field of a contract type read as its base (Compute.base). */
const baseFields = (predicate: CheckPredicate): ExprDesc<Located, CheckRefs> => {
	const term = (t: CheckTerm): ExprDesc<Located, CheckRefs> => {
		switch (t.kind) {
			case "field":
				return contractOf(t.column.type) === undefined ? t : { kind: "base", arg: t }
			case "literal":
				return t
			case "compute":
				return { ...t, args: t.args.map(term) }
		}
	}
	const wrap = (p: CheckPredicate): ExprDesc<Located, CheckRefs> => {
		switch (p.kind) {
			case "compare":
				return { ...p, left: term(p.left), right: term(p.right) }
			case "and":
			case "or":
				return { ...p, args: mapNonEmpty(p.args, wrap) }
			case "not":
				return { ...p, arg: wrap(p.arg) }
		}
	}
	return wrap(predicate)
}

const specialize = (
	theory: Theory,
	checked: CheckedSchema
): Result.Result<LawModel, CompileError> =>
	catchRefusal(() => new Specializer(theory, checked).run())

/** Law specialization: an owned schema's CheckedTheory with every law's LawLowering. It runs theory normalization with
 * the law identities the naming door gives (theory.ts lawIdentityOf), recognizes every normalized law (`Recognizer`), and settles what depends on the whole schema at once:
 *
 * - Law columns: each term of a selected side and each pred term is a STORED generated column of its relation, and a
 *   constant selection of a target a STORED constant column of its source, each named once by what it is
 *   (identity.lawColumn) and lowered once over its table's row. The generated UNIQUE a reference needs is over exactly
 *   the target's columns, a constant selection's the target's fields then its selector fields, and the generated
 *   temporal unique the scalars, then the selector, then the span. A generated unique whose column set is a declared
 *   key of the target is that key.
 * - Foreign key deferral: an arm or PERIOD foreign key is always DEFERRABLE INITIALLY DEFERRED. Any other foreign key
 *   is deferred exactly when a lawful final-state ChangeSet could break it in passing: when its target can be replaced
 *   at the referenced key, because the target has a field it does not reference as a plain column, so a put or a
 *   deletion and an addition at that key deletes the referenced row before inserting its replacement; or when it lies
 *   on a cycle of foreign keys, where neither side can be inserted first. Any role over the schema may write any
 *   ordinary relation, and roles are defined beside the schema, never in it, so the schema's own laws are the same
 *   whoever writes. Otherwise it is immediate, and so is the evidence it gives, which the theory is rebuilt with.
 * - Naming and the constraint-to-LawId map: every native object's installed identifier, minted at the naming door
 *   from its identity, and for each constraint and domain constraint the law a violation of it reports; a law column
 *   reports no violation, and an unnamed native has no identifier to report. A primary key native is the
 *   relation's declared primary key, which ownership named. A generated CHECK, finite membership or a capacity's row
 *   check, is named for its table and the law it specializes (identity.generatedCheck). A native object that
 *   discharges several laws is one object listing them all; its violation reports the first, a key law's when one
 *   plans it, since key laws are merged first.
 * - The DAG: the theory's violation queries plus each residual law's affected-key extraction and each generated
 *   CHECK's predicate.
 *
 * The law model of an owned schema, or the first refusal: a theory refusal, a law shape the compiler does not
 * admit (UnsupportedLawFamily), a law over a derived relation (LawOnDerived) or an unrepresentable key. A first
 * normalization settles foreign key deferral, and the second rebuilds the theory with the immediate evidence that
 * deferral gives. */
export const compileLaws = (owned: Owned): Result.Result<LawModel, CompileError> =>
	Result.flatMap(checkedSchema(owned), (checked) =>
		Result.flatMap(buildTheory(checked, provisionalTheory), (first) =>
			Result.flatMap(specialize(first, checked), (model) =>
				Result.flatMap(
					buildTheory(checked, {
						containmentContext: (law) =>
							model.immediate.has(law.id) ? "immediate" : "committedSnapshot"
					}),
					(theory) => specialize(theory, checked)
				)
			)
		)
	)
