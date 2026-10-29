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
import type { CompileError } from "#compiler/core/errors.ts"
import { type Identity, identifierOf, identity, type KeySide } from "#compiler/core/identity.ts"
import {
	type ConstraintName,
	type DomainName,
	type Identifier,
	type IdentityKind,
	type LawId,
	makeIdSupply,
	type NodeId,
	type RelationIdent
} from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	dedupeNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray,
	sortNonEmpty
} from "#compiler/core/nonempty.ts"
import * as Order from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import { mergeDags } from "#compiler/ir/dag.ts"
import type { ExprDesc, Located } from "#compiler/ir/desc.ts"
import {
	type ExprSpec,
	identityValueOf,
	type ScalarExpr,
	type TypedLiteral
} from "#compiler/ir/expr.ts"
import {
	type DomainCheck,
	type DomainCheckTerm,
	type DomainNative,
	fieldNames,
	headingColumns,
	type ImageGuard,
	type KeyImage,
	type LawField,
	type LawLowering,
	type LawRelation,
	mapEventImages,
	type NativeObject,
	type NativeOf,
	type Participant,
	type ParticipantEvents,
	participantEvents,
	type RelationInfo,
	type ResidualLaw,
	type SpanKeyScalars,
	type TheoryRelation
} from "#compiler/ir/law.ts"
import type { ConstraintLaws, ConstraintOwner } from "#compiler/ir/products.ts"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import { type ContractInfo, contractOf, textOf } from "#compiler/ir/scalar.ts"

import {
	type CheckPredicate,
	type CheckRefs,
	type CheckTerm,
	type ImagePlan,
	type LawPlan,
	type LeadParticipant,
	type NativePlan,
	type ParticipantPlan,
	type PrimaryKeyPlan,
	primaryKeyPlan,
	Recognizer,
	type ResidualParticipants
} from "#compiler/laws/model/plan.ts"
import { type RelationLaws, relationLaws } from "#compiler/laws/model/uniques.ts"
import { lowerPredicate, noParams } from "#compiler/scalar/compute/lower.ts"
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
	| "TaggedForeignKey"
	| "PeriodForeignKey"
	| "TaggedPeriodForeignKey"

/** A native object with the identity its installed name was minted from, its namespace, and its owner: the table
 * identifier, or a contract domain's identifier. Each namespace holds exactly its kinds of object: a table constraint, a capacity's partial
 * unique index, a stored tag column, a contract's domain, or an object the law model names nothing for. A table
 * constraint and a unique index carry the description of the law their violation reports. */
export type NamedNative =
	| {
			readonly object: NativeOf<ConstraintNativeKind>
			readonly namespace: "constraint"
			readonly named: Identity<"primaryKey" | "key" | "check" | "generatedCheck" | "foreignKey">
			readonly owner: RelationIdent
			readonly described: Law
	  }
	| {
			readonly object: NativeOf<"PartialUnique">
			readonly namespace: "index"
			readonly named: Identity<"partialUnique">
			readonly owner: RelationIdent
			readonly described: Law
	  }
	| {
			readonly object: NativeOf<"StoredTag">
			readonly namespace: "column"
			readonly named: Identity<"tag">
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

/** One entry of the constraint-to-LawId map: the identifier a violation reports (a table constraint, a unique index or
 * a domain constraint), the table or domain that owns it, the law it reports and that law's description. */
export type ConstraintLaw =
	| {
			readonly kind: "constraint" | "index"
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

/** What a constraint lives on, as PostgreSQL reports it: a table constraint's or a unique index's table, or a domain
 * constraint's domain. */
export const constraintOwner = (c: ConstraintLaw): ConstraintOwner =>
	c.kind === "domainConstraint"
		? { kind: "domain", name: c.owner }
		: { kind: "table", name: c.owner }

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

/** A participant before its trigger is named: its relation and its events. */
interface Untriggered {
	readonly relation: TheoryRelation
	readonly events: ParticipantEvents
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
		case "Unique":
		case "ReverseIndex":
			return { ...rest, relation: rest.relation.name, columns: fieldNames(rest.columns) }
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
		case "PartialUnique":
			return {
				...rest,
				relation: rest.relation.name,
				columns: fieldNames(rest.columns),
				where: rest.where.map((w) => ({ column: w.field.name, value: w.value }))
			}
		case "FiniteCheck":
			return {
				...rest,
				relation: rest.relation.name,
				facts: rest.facts.map((fact) => fact.map((v) => ({ field: v.field.name, value: v.value })))
			}
		case "ForeignKey":
		case "TaggedForeignKey":
			return {
				...rest,
				relation: rest.relation.name,
				columns: fieldNames(rest.columns),
				target: rest.target.name,
				targetColumns: fieldNames(rest.targetColumns)
			}
		case "PeriodForeignKey":
		case "TaggedPeriodForeignKey":
			return {
				...rest,
				relation: rest.relation.name,
				columns: fieldNames(rest.columns),
				span: rest.span.name,
				target: rest.target.name,
				targetColumns: fieldNames(rest.targetColumns),
				targetSpan: rest.targetSpan.name
			}
		case "StoredTag":
			return {
				...rest,
				relation: rest.relation.name,
				selector: { relation: rest.selector.relation.name, field: rest.selector.field.name }
			}
		case "Domain":
		case "Enum":
			return rest
	}
}

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
	const regex = info.base.contract === undefined ? textOf(info.base)?.regex : undefined
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

/** A plain foreign key as the deferral asks about it: its relation, its target and the target's columns it names. */
interface DeferralQuery {
	readonly relation: TheoryRelation
	readonly target: TheoryRelation
	readonly targetColumns: ReadonlyArray<LawField>
}

/** A plan's native object as the specializer materializes it: a generated CHECK with its predicate lowered into the
 * extension DAG (`#lowerCheck`), every other as its plan states it. */
type PlacedNative =
	| Exclude<NativePlan, { readonly kind: "GeneratedCheck" }>
	| {
			readonly kind: "LoweredCheck"
			readonly relation: TheoryRelation
			readonly predicate: ScalarExpr
	  }

class Specializer {
	readonly theory: Theory
	readonly checked: CheckedSchema
	readonly owned: Owned
	readonly recognizer: Recognizer
	readonly #minted: Array<Identity<IdentityKind>> = []

	constructor(theory: Theory, checked: CheckedSchema) {
		this.theory = theory
		this.checked = checked
		this.owned = checked.owned
		this.recognizer = new Recognizer()
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
		/** Each plan with its native objects, a generated CHECK's predicate lowered into the extension DAG. */
		const placed = plans.map((plan) => ({
			plan,
			natives: plan.natives.map((n): PlacedNative => {
				if (n.kind !== "GeneratedCheck") {
					return n
				}
				const { filter, predicate } = this.#lowerCheck(ext, n.relation, n.predicate, plan.law.loc)
				roots.push(filter)
				return { kind: "LoweredCheck", relation: n.relation, predicate }
			})
		}))
		/** Each row image's anchor key, read from a Delta of the participant and made reachable by a ProjectSet named by
		 * the anchor key's fields. */
		const keyImage = (relation: TheoryRelation, image: ImagePlan): KeyImage => {
			const delta = ext.node({
				kind: "Delta",
				relation: relation.name,
				side: image.side === "new" ? "added" : "removed",
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
			return { side: image.side, key, guard: image.guard }
		}
		/** A participant's DELETE and UPDATE images, each kind when it checks any. */
		const laterEvents = (p: ParticipantPlan) => {
			const del = p.delete.map((i) => keyImage(p.relation, i))
			const update =
				p.update === undefined
					? undefined
					: {
							of: p.update.of,
							images: mapNonEmpty(p.update.images, (i) => keyImage(p.relation, i))
						}
			return { delete: isNonEmpty(del) ? del : undefined, update }
		}
		/** A participant's events, each with the images it checks, each when it checks any; a participant no event
		 * threatens has no trigger. */
		const participantOf = (p: ParticipantPlan): ReadonlyArray<Untriggered> => {
			const insert = p.insert.map((i) => keyImage(p.relation, i))
			const later = laterEvents(p)
			const events = participantEvents(
				isNonEmpty(insert) ? insert : undefined,
				later.delete,
				later.update
			)
			return events === undefined ? [] : [{ relation: p.relation, events }]
		}
		/** The lead participant's events: its INSERT always threatens the law. */
		const leadOf = (p: LeadParticipant): Untriggered => {
			const insert = mapNonEmpty(p.insert, (i) => keyImage(p.relation, i))
			const later = laterEvents(p)
			return { relation: p.relation, events: { insert, ...later } }
		}
		/** Each residual law's plan with its participants' triggers to be, in plan order. */
		const extracted: Array<{
			readonly plan: LawPlan
			readonly residual: Exclude<LawPlan["residual"], undefined>
			readonly participants: NonEmptyReadonlyArray<Untriggered>
		}> = []
		for (const plan of plans) {
			const residual = plan.residual
			if (residual === undefined) {
				continue
			}
			const [lead, ...rest] = mergeParticipants(residual.participants)
			const participants: NonEmptyReadonlyArray<Untriggered> = [
				leadOf(lead),
				...rest.flatMap(participantOf)
			]
			extracted.push({ plan, residual, participants })
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
		const nativeObjects = placed.map(({ plan, natives: placedNatives }) => {
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
			if (named.namespace === "constraint" || named.namespace === "index") {
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

		/** Residual laws, each with its function and its trigger on each participating relation, named for the law. */
		const residuals: Array<ResidualLaw> = []
		const residualOf = new Map<LawId, ResidualLaw>()
		for (const { plan, residual: r, participants: untriggered } of extracted) {
			const lawId = plan.law.id
			const fn = this.#named(identity.lawFunction(plan.law.named))
			const renamed = (image: KeyImage): KeyImage => ({
				side: image.side,
				key: mapNonEmpty(image.key, (c) => ({
					field: c.field,
					pair: c.pair,
					expr: merged.expr(c.expr)
				})),
				guard: image.guard
			})
			const participants = mapNonEmpty(untriggered, (p): Participant => ({
				relation: p.relation,
				trigger: this.#named(identity.lawTrigger(plan.law.named, p.relation.name)),
				events: mapEventImages(p.events, renamed)
			}))
			const residual: ResidualLaw = {
				lawId,
				...r.checks,
				function: fn,
				anchor: r.anchor,
				participants,
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
				n.kind === "ForeignKey" ||
				n.kind === "TaggedForeignKey" ||
				n.kind === "PeriodForeignKey" ||
				n.kind === "TaggedPeriodForeignKey"
					? [[n.relation.name, n.target.name]]
					: []
			)
		)
		const onCycle = cycleEdges(edges)
		return (fk) =>
			onCycle(fk.relation.name, fk.target.name) ||
			fk.target.fields.some((c) => !fk.targetColumns.includes(c))
	}

	/** A generated CHECK predicate lowered in the total fragment over a scan of its table. Each field is
	 * read at its own type, so a literal bound adopts the field's contract as in a declared row check;
	 * when that adoption refuses (a bound outside the contract, or two contracts compared), the comparison is made over
	 * the base types instead, which is the same predicate on every stored value. */
	#lowerCheck(
		ext: ViolationBuilder,
		r: TheoryRelation,
		predicate: CheckPredicate,
		loc: SourceLoc
	): { readonly filter: RelNode; readonly predicate: ScalarExpr } {
		const env = typingEnv(this.owned)
		const attempt = (
			desc: ExprDesc<Located, CheckRefs>,
			emit: (spec: ExprSpec) => ScalarExpr,
			node: NodeId
		) =>
			lowerPredicate(desc, {
				...env,
				mode: "total",
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
			case "PartialUnique":
			case "Enum":
			case "FiniteCheck":
			case "TemporalUnique":
			case "ReverseIndex":
				return { ...n, lawIds }
			case "Unique": {
				/** A generated unique over the column set of a declared scalar key is that key; a span key is WITHOUT
				 * OVERLAPS, not a B-tree uniqueness, so its exact-repeat arbiter stays its own object. */
				const target = n.relation
				const declared = target.keyNames.find(
					(k) => k.span === undefined && sameMembers<LawField>(k.fields, n.columns)
				)
				if (declared === undefined) {
					return { kind: "Unique", relation: target, columns: n.columns, lawIds }
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
					: { kind: "Unique", relation: target, columns, lawIds }
			}
			case "Domain": {
				const info = unwrap(typingEnv(this.owned).contractInfo(n.contract.desc, n.contract.loc))
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
			case "ForeignKey":
				return {
					...n,
					deferrable: deferred({
						relation: n.relation,
						target: n.target,
						targetColumns: n.targetColumns
					}),
					lawIds
				}
			case "TaggedForeignKey":
				return {
					kind: "TaggedForeignKey",
					relation: n.relation,
					columns: n.columns,
					tag: this.#mint(tagOf(n.tag)),
					target: n.target,
					targetColumns: n.targetColumns,
					lawIds
				}
			case "StoredTag":
				return {
					kind: "StoredTag",
					relation: n.tag.relation,
					column: this.#mint(tagOf(n.tag)),
					value: n.tag.value,
					selector: { relation: n.tag.target, field: n.tag.field },
					lawIds
				}
			case "PeriodForeignKey":
				return {
					kind: "PeriodForeignKey",
					relation: n.relation,
					columns: n.columns,
					span: n.span,
					target: n.target,
					targetColumns: n.targetColumns,
					targetSpan: n.targetSpan,
					lawIds
				}
			case "TaggedPeriodForeignKey":
				return {
					kind: "TaggedPeriodForeignKey",
					relation: n.relation,
					columns: n.columns,
					tag: this.#mint(tagOf(n.tag)),
					span: n.span,
					target: n.target,
					targetColumns: n.targetColumns,
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
		const side = (relation: LawRelation, fields: ReadonlyArray<string>): KeySide => ({
			relation: relation.name,
			fields,
			selection: []
		})
		const foreignKey = (
			on: NativeOf<
				"ForeignKey" | "TaggedForeignKey" | "PeriodForeignKey" | "TaggedPeriodForeignKey"
			>,
			from: KeySide,
			to: KeySide,
			period: boolean
		): NamedNative => constraint(on, this.#named(identity.foreignKey(from, to, period)))
		switch (object.kind) {
			case "PrimaryKey":
				return constraint(object, object.named)
			case "Unique": {
				const k = ownedKey(object.relation, object.columns)
				return constraint(
					object,
					k === undefined
						? this.#named(identity.key(object.relation.name, fieldNames(object.columns)))
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
			case "PartialUnique":
				return {
					object,
					named: this.#named(
						identity.partialUnique(
							object.relation.name,
							fieldNames(object.columns),
							object.where.map((w) => ({ field: w.field.name, value: identityValueOf(w.value) }))
						)
					),
					namespace: "index",
					owner: object.relation.ident,
					described
				}
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
					side(object.relation, fieldNames(object.columns)),
					side(object.target, fieldNames(object.targetColumns)),
					false
				)
			case "TaggedForeignKey":
				return foreignKey(
					object,
					side(object.relation, [...fieldNames(object.columns), object.tag]),
					side(object.target, fieldNames(object.targetColumns)),
					false
				)
			case "PeriodForeignKey":
				return foreignKey(
					object,
					side(object.relation, [...fieldNames(object.columns), object.span.name]),
					side(object.target, [...fieldNames(object.targetColumns), object.targetSpan.name]),
					true
				)
			case "TaggedPeriodForeignKey":
				return foreignKey(
					object,
					side(object.relation, [...fieldNames(object.columns), object.tag, object.span.name]),
					side(object.target, [...fieldNames(object.targetColumns), object.targetSpan.name]),
					true
				)
			case "StoredTag":
				return {
					object,
					named: tagOf({
						target: object.selector.relation,
						field: object.selector.field,
						value: object.value
					}),
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

/** The STORED constant tag column a selected target's selection needs on its source: one per target, selector field
 * and value. */
const tagOf = (tag: {
	readonly target: { readonly name: string }
	readonly field: { readonly name: string }
	readonly value: TypedLiteral
}): Identity<"tag"> => identity.tag(tag.target.name, tag.field.name, identityValueOf(tag.value))

/** The guard of one image two sides of a relation share: always when either side's image is, else the union of their
 * selections, the earlier plan's first. */
const uniteGuards = (a: ImageGuard, b: ImageGuard): ImageGuard =>
	a.kind === "always" || b.kind === "always"
		? { kind: "always" }
		: { kind: "selected", selections: [...a.selections, ...b.selections] }

const imageKey = (i: ImagePlan) => `${i.side}\u0000${i.key.map((c) => c.field.name).join("\u0000")}`

/** An image of one plan under the union of its guard and its twin's in the other plan's `b`. */
const twinned =
	(b: ReadonlyArray<ImagePlan>) =>
	(i: ImagePlan): ImagePlan => {
		const twin = b.findLast((x) => imageKey(x) === imageKey(i))
		return twin === undefined ? i : { ...i, guard: uniteGuards(i.guard, twin.guard) }
	}

/** The images of `b` that `a` lacks. */
const fresh = (
	a: ReadonlyArray<ImagePlan>,
	b: ReadonlyArray<ImagePlan>
): ReadonlyArray<ImagePlan> => {
	const seen = new Set(a.map(imageKey))
	return b.filter((i) => !seen.has(imageKey(i)))
}

/** Two UPDATE plans of one relation as one: the fields of either in heading order (`order`), and their images united. */
const uniteUpdates = (
	a: Exclude<ParticipantPlan["update"], undefined>,
	b: Exclude<ParticipantPlan["update"], undefined>
): Exclude<ParticipantPlan["update"], undefined> => {
	const of = sortNonEmpty(
		dedupeNonEmpty([...a.of, ...b.of]),
		Order.mapInput(Order.compareNumbers, (f: LawField) => f.position)
	)
	return { of, images: [...mapNonEmpty(a.images, twinned(b.images)), ...fresh(a.images, b.images)] }
}

/** Two image lists of one event as one. */
const unite = (
	a: ReadonlyArray<ImagePlan>,
	b: ReadonlyArray<ImagePlan>
): ReadonlyArray<ImagePlan> => [...a.map(twinned(b)), ...fresh(a, b)]

/** Two plans of one relation as one: events and images united. */
const mergeTwo = (prior: ParticipantPlan, p: ParticipantPlan): ParticipantPlan => {
	const update =
		prior.update === undefined
			? p.update
			: p.update === undefined
				? prior.update
				: uniteUpdates(prior.update, p.update)
	return {
		relation: p.relation,
		insert: unite(prior.insert, p.insert),
		delete: unite(prior.delete, p.delete),
		update
	}
}

/** One trigger per participating table: the plans of one relation merged, events and images united, the lead's first.
 * Two images of one (side, fields) are one image, under the union of their guards; an image one plan has and the other
 * lacks keeps its own guard. */
const mergeParticipants = (plans: ResidualParticipants): ResidualParticipants => {
	const [first, ...rest] = plans
	let lead = first
	const byRelation = new Map<string, ParticipantPlan>()
	for (const p of rest) {
		if (p.relation.name === lead.relation.name) {
			lead = {
				...mergeTwo(lead, p),
				insert: [...mapNonEmpty(lead.insert, twinned(p.insert)), ...fresh(lead.insert, p.insert)]
			}
			continue
		}
		const prior = byRelation.get(p.relation.name)
		byRelation.set(p.relation.name, prior === undefined ? p : mergeTwo(prior, p))
	}
	return [lead, ...byRelation.values()]
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
				return { ...p, args: p.args.map(wrap) }
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
 * - Tag columns: a selected target's selection becomes a STORED constant column of its source, one per target,
 *   selector field and value (identity.tag). The generated composite UNIQUE a tagged reference needs is a key of the
 *   target's projection then the selector field, and the generated temporal unique the scalars, then the selector,
 *   then the span. A generated unique whose column set is a declared key of the target is that key.
 * - Foreign key deferral: a tagged or PERIOD foreign key is always DEFERRABLE INITIALLY DEFERRED. A plain foreign key
 *   is deferred exactly when a lawful final-state ChangeSet could break it in passing: when its target can be replaced
 *   at the referenced key, because the target has a field outside the referenced columns, so a put or a deletion and an
 *   addition at that key deletes the referenced row before inserting its replacement; or when it lies on a cycle of
 *   foreign keys, where neither side can be inserted first. Any role over the schema may write any ordinary relation,
 *   and roles are defined beside the schema, never in it, so the schema's own laws are the same whoever writes.
 *   Otherwise it is immediate, and so is the evidence it gives, which the theory is rebuilt with.
 * - Naming and the constraint-to-LawId map: every native object's installed identifier, minted at the naming door
 *   from its identity, and for each constraint, unique index and domain constraint the law a violation of it reports;
 *   a tag column reports no violation, and an unnamed native has no identifier to report. A primary key native is the
 *   relation's declared primary key, which ownership named. A generated CHECK, finite membership or a capacity's row
 *   check, is named for its table and the law it specializes (identity.generatedCheck). A native object that
 *   discharges several laws is one object listing them all; its violation reports the first, which is the declared key
 *   when there is one.
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
