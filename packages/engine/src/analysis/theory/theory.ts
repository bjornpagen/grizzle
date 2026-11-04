import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { ViolationBuilder } from "#compiler/analysis/theory/build.ts"
import { type FieldClass, FieldClasses } from "#compiler/analysis/theory/classes.ts"
import {
	type AlternativesFamily,
	type ContractUse,
	type FamilyMember,
	type KeptLaw,
	type LawIdentity,
	Normalizer,
	type PrimaryKeyKept,
	type TheoryLaw
} from "#compiler/analysis/theory/laws.ts"
import { catchRefusal, compareText, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import {
	type Identity,
	identifierOf,
	identity,
	type LawStatement,
	type Part
} from "#compiler/core/identity.ts"

import {
	type ConstraintName,
	FieldId,
	fieldIdSpellingParts,
	type LawId
} from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { BoundValueDesc, FieldDesc } from "#compiler/ir/desc.ts"
import type { EvidenceContext } from "#compiler/ir/evidence.ts"
import { identityValueOf } from "#compiler/ir/expr.ts"
import {
	fieldNames,
	type LawField,
	type LawSide,
	type RelationInfo,
	type TheoryRelation
} from "#compiler/ir/law.ts"
import type { CheckedTheory } from "#compiler/ir/products.ts"
import type { HeadingColumn, KeySet, ValidDag } from "#compiler/ir/rel.ts"
import {
	baseOf,
	type ContractInfo,
	contractOf,
	rosterOf,
	type ScalarType,
	spanOf
} from "#compiler/ir/scalar.ts"
import type { RegexMember } from "#compiler/scalar/compute/evaluate.ts"
import { contractPredicateTable } from "#compiler/scalar/compute/total.ts"
import { contractInfoOf, type ScalarEnv, scalarTypeOf } from "#compiler/scalar/registry.ts"
import type { Owned } from "#compiler/schema/own.ts"
import { analyzeText, regexMember, textInfo } from "#compiler/text/refinement.ts"

export interface TheoryOptions {
	/**
	 * The validity context of a containment's evidence beyond a closed roster's descriptor fact: committedSnapshot
	 * until law specialization proves a containment immediate (see the header).
	 */
	readonly containmentContext: (law: TheoryLaw) => EvidenceContext
}

/** A key of a relation as immediate evidence: the PRIMARY KEY or UNIQUE that holds at every statement. */
interface KeyEvidence {
	readonly relation: string
	readonly fields: KeySet
	/** The span fields of a nonoverlap key, compared WITHOUT OVERLAPS; none for a scalar key. */
	readonly spans: KeySet
	readonly primary: boolean
	/** The constraint identifier ownership derived. */
	readonly constraint: ConstraintName
	readonly law: LawId
	readonly context: "immediate"
}

interface CheckEvidence {
	readonly relation: string
	readonly name: string
	readonly law: LawId
	readonly context: "immediate"
}

/**
 * A containment as evidence: every `from` projection, selection applied, has a matching `to` fact. A span coverage law
 * is marked: it proves coverage, not scalar existence.
 */
interface ContainmentEvidence {
	readonly law: LawId
	readonly from: LawSide
	readonly to: LawSide
	readonly coverage: boolean
	/**
	 * The statement that declares it: a `contained` (an alternatives head included), or a `mirrors` half, an
	 * alternatives arm's either direction included. attach reads only declared containments.
	 */
	readonly statement: "contained" | "mirrors"
	readonly context: EvidenceContext
}

interface TheoryEvidence {
	readonly keys: ReadonlyArray<KeyEvidence>
	readonly checks: ReadonlyArray<CheckEvidence>
	readonly containments: ReadonlyArray<ContainmentEvidence>
}

/**
 * Theory normalization: an owned schema to its CheckedTheory.
 *
 * The pass after ownership and before law specialization. It produces:
 *
 * - field-compatibility classes over the admitted containment pairings (classes.ts), refusing a pairing of fields of
 *   different identity;
 * - the normalized laws, each with its source identity and its violation query as a Forbid node in one DAG
 *   (laws.ts): mirrors as its two containments, an alternatives expansion recognized as one family;
 * - the relation dependency graph: each relation and the relations its laws read;
 * - the evidence each law gives queries, with its validity context: keys and row checks are
 *   validated immediate storage facts; a containment into a closed roster that its source field is already typed by is
 *   an unconditional descriptor fact; every other containment holds in lawful committed snapshots only, unless law
 *   specialization proves it immediate (a non-deferred native FK), which it states through the
 *   containmentContext option;
 * - the capability obligations the laws carry (btree_gist for span keys and coverage with scalar parts, the vector
 *   extension for vector fields).
 *
 * lowerings is empty here: law specialization (laws/) recognizes each normalized law and fills it. A law's identity
 * is the naming door's (core/identity.ts), minted from what the law is (lawIdentityOf), so every build of a schema names
 * its laws alike.
 */
/** An ordinary relation with the law of its primary key. */
export interface PrimaryKeyLaw {
	readonly relation: RelationInfo
	readonly law: TheoryLaw
}

export interface Theory extends CheckedTheory {
	readonly name: string
	/** The relations and closed relations the laws read, typed; derived relations carry no law. */
	readonly relations: Readonly<Record<string, TheoryRelation>>
	readonly classes: ReadonlyArray<FieldClass>
	readonly laws: ReadonlyArray<TheoryLaw>
	/** Each ordinary relation with its primary key's law, a law of `laws`, in relation order: the theory states one
	 * primary key per ordinary relation. */
	readonly primaryKeys: ReadonlyArray<PrimaryKeyLaw>
	readonly families: ReadonlyArray<AlternativesFamily<LawId>>
	readonly evidence: TheoryEvidence
}

const sidePart = (side: LawSide): Part => [
	side.relation,
	side.fields,
	side.selection.map((s) => [s.column, identityValueOf(s.value).part])
]

const sideStem = (side: LawSide): ReadonlyArray<string> => [
	side.relation,
	...side.selection.flatMap((s) => [s.column, identityValueOf(s.value).stem])
]

const sideDisplay = (side: LawSide): string =>
	`${side.relation}(${side.fields.join(", ")})${
		side.selection.length === 0
			? ""
			: ` where ${side.selection.map((s) => `${s.column} = ${identityValueOf(s.value).display}`).join(", ")}`
	}`

const boundPart = (bound: BoundValueDesc | "*"): Part =>
	bound === "*"
		? ["unbounded"]
		: typeof bound === "bigint"
			? ["int", `${bound}`]
			: ["ref", bound.ref]

const boundDisplay = (bound: BoundValueDesc | "*"): string =>
	bound === "*" ? "*" : typeof bound === "bigint" ? `${bound}` : bound.ref

/** A contract's law: its name, which one contract has wherever its domain is installed. */
const contractStatement = (contract: string): LawStatement => ({
	parts: ["contract", contract],
	stem: [contract],
	display: `contract ${contract}`
})

/**
 * What a law is, independent of where its statement sits among the others, as the naming door states it: a key by its
 * relation and fields, a check by its relation and name, a contract by its name, a containment by its sides (selections
 * included) and, for a mirrors half, its direction, a family by its origin marker, a capacity by its sides, weight and
 * bounds, each led by the law's shape. Adding or removing an unrelated statement never changes it. A mirrors half is
 * marked as one, not as which: mirrors(a, b) and mirrors(b, a) state one law, whose halves the sides tell apart. A
 * count, a statement that weighs nothing, weighs nothing in it.
 */
const lawStatement = (law: LawIdentity): LawStatement => {
	const d = law.detail
	switch (d.kind) {
		case "key": {
			const fields = fieldNames(d.key.fields)
			return {
				parts: [law.shape, d.relation, fields],
				stem: [d.relation, law.shape === "pk" ? "pk" : "key", ...fields],
				display: `${law.shape === "pk" ? "primary key" : "key"} ${d.relation}(${fields.join(", ")})`
			}
		}
		case "check":
			return {
				parts: [law.shape, d.relation, d.name],
				stem: [d.relation, "check", d.name],
				display: `check ${d.name} of ${d.relation}`
			}
		case "contract":
			return contractStatement(d.contract)
		case "containment": {
			const mirrors = d.stated.kind === "mirrors"
			return {
				parts: [law.shape, sidePart(d.from), sidePart(d.to), mirrors ? "mirrors" : "contained"],
				stem: [...sideStem(d.from), "in", d.to.relation],
				display: `${sideDisplay(d.from)} ${law.shape === "coverage" ? "covered by" : "in"} ${sideDisplay(d.to)}${mirrors ? ", a mirrors half" : ""}`
			}
		}
		case "alternatives": {
			const { relation, field } = fieldIdSpellingParts(d.family)
			return {
				parts: [law.shape, d.family],
				stem: [relation, field, "alternatives"],
				display: `alternatives of ${relation}.${field}`
			}
		}
		case "capacity": {
			const weight: ReadonlyArray<string> =
				d.weight.kind === "count" ? [] : [d.weight.kind, d.weight.field]
			return {
				parts: [
					law.shape,
					sidePart(d.target),
					sidePart(d.from),
					weight,
					[boundPart(d.within.low), boundPart(d.within.high)]
				],
				stem: [...sideStem(d.target), "capacity", d.from.relation],
				display: `capacity of ${sideDisplay(d.target)} over ${sideDisplay(d.from)}${
					d.weight.kind === "count" ? "" : ` weighing ${d.weight.kind} ${d.weight.field}`
				} within ${boundDisplay(d.within.low)}..${boundDisplay(d.within.high)}`
			}
		}
	}
}

/** A law's identity at the naming door: its LawId is the identity's identifier. */
export const lawIdentityOf = (law: LawIdentity): Identity<"law"> => identity.law(lawStatement(law))

/** A contract's law at the naming door, a context field's contract's included, which no theory of the base states. */
export const contractLawIdentity = (contract: string): Identity<"law"> =>
	identity.law(contractStatement(contract))

/** Where a field of `rel` uses the contract `name`: its own type, and both endpoints of its span's. */
const contractUses = (
	rel: TheoryRelation,
	field: LawField,
	name: string
): ReadonlyArray<ContractUse> => {
	const relation = rel.name
	const endpoint = spanOf(baseOf(field.type))?.endpoint
	return [
		...(contractNames(field.type).includes(name)
			? [{ relation, rel, field, at: "column" as const }]
			: []),
		...(endpoint !== undefined && contractNames(endpoint).includes(name)
			? [
					{ relation, rel, field, at: "lower" as const },
					{ relation, rel, field, at: "upper" as const }
				]
			: [])
	]
}

/** Each contract a type is, from the outside in. */
const contractNames = (t: ScalarType): ReadonlyArray<string> => {
	const names: Array<string> = []
	for (let contract = contractOf(t); contract !== undefined; contract = contractOf(contract.base)) {
		names.push(contract.name)
	}
	return names
}

/**
 * The typing environment of an owned schema's laws: the descriptor registry's reading with the text package's
 * canonical refinements, its closed relations' rosters, each contract's predicate table, and the text package's regex
 * membership. Theory normalization types its laws in it, and law specialization its generated CHECK predicates.
 */
export const typingEnv = (
	owned: Owned
): {
	readonly fieldType: (desc: FieldDesc, loc: SourceLoc) => Result.Result<ScalarType, CompileError>
	readonly contractInfo: (
		desc: Extract<FieldDesc, { readonly kind: "contract" }>,
		loc: SourceLoc
	) => Result.Result<ContractInfo, CompileError>
	readonly regexMember: RegexMember
} => {
	const rosters = new Map<string, NonEmptyReadonlyArray<string>>()
	for (const r of Object.values(owned.relations)) {
		if (r.desc.kind === "closed") {
			rosters.set(r.name, r.desc.handles)
		}
	}
	const fieldType = (desc: FieldDesc, loc: SourceLoc): Result.Result<ScalarType, CompileError> =>
		scalarTypeOf(desc, schemaEnv(loc), loc)
	/** The registry's environment of the owned schema, its refusals at `loc`. */
	const schemaEnv = (loc: SourceLoc): ScalarEnv => ({
		kind: "schema",
		roster: (name) => rosters.get(name),
		text: (source, flags) => Result.map(analyzeText(source, flags, loc), textInfo),
		contractPredicate: (predicate, base, contract, facts) =>
			contractPredicateTable(predicate, base, contract, facts, { loc, fieldType, regexMember })
	})
	return {
		fieldType,
		contractInfo: (desc, loc) => contractInfoOf(desc, schemaEnv(loc), loc),
		regexMember
	}
}

class Builder {
	readonly owned: Owned
	readonly options: TheoryOptions
	readonly fieldType: (desc: FieldDesc, loc: SourceLoc) => Result.Result<ScalarType, CompileError>
	/** The stored relations' handles the checked schema minted, in name order. */
	readonly stored: ReadonlyArray<TheoryRelation>
	readonly relations: ReadonlyMap<string, TheoryRelation>

	constructor(checked: CheckedSchema, options: TheoryOptions) {
		this.owned = checked.owned
		this.options = options
		this.fieldType = typingEnv(checked.owned).fieldType
		this.stored = checked.stored
		this.relations = new Map(checked.stored.map((r) => [r.name, r] as const))
	}

	#type(desc: FieldDesc, loc: SourceLoc): ScalarType {
		const t = this.fieldType(desc, loc)
		if (!t.ok) {
			throw new Refusal(t.error)
		}
		return t.value
	}

	/**
	 * Primary keys, in relation order.
	 *
	 * Contracts, in name order, with every column and span endpoint that stores their values.
	 */
	run(): Theory {
		const normalizer = new Normalizer({
			relations: this.relations,
			named: lawIdentityOf,
			lowerEnv: { fieldType: this.fieldType, regexMember }
		})
		for (const [index, r] of this.stored.entries()) {
			if (r.kind === "relation") {
				normalizer.primaryKey(r, index)
			}
		}
		/** Statements, in canonical order; an alternatives expansion as one family, at its first statement. */
		const expansions = new Map<string, [FamilyMember, ...Array<FamilyMember>]>()
		const order: Array<
			| { readonly kind: "statement"; readonly member: FamilyMember }
			| {
					readonly kind: "family"
					readonly id: string
					readonly members: NonEmptyReadonlyArray<FamilyMember>
			  }
		> = []
		for (const [index, s] of this.owned.statements.entries()) {
			const id = s.kind === "contained" || s.kind === "mirrors" ? s.origin?.alternatives : undefined
			if (id === undefined) {
				order.push({ kind: "statement", member: { s, index } })
				continue
			}
			const members = expansions.get(id)
			if (members === undefined) {
				const first: [FamilyMember, ...Array<FamilyMember>] = [{ s, index }]
				expansions.set(id, first)
				order.push({ kind: "family", id, members: first })
			} else {
				members.push({ s, index })
			}
		}
		for (const item of order) {
			if (item.kind === "statement") {
				normalizer.statement(item.member.s, item.member.index)
			} else {
				normalizer.alternatives(item.id, item.members)
			}
		}
		const contracts = Object.entries(this.owned.contracts).toSorted(([a], [b]) => compareText(a, b))
		for (const [index, [name, contract]] of contracts.entries()) {
			const uses = [...this.relations.values()].flatMap((r) =>
				r.kind === "relation" ? r.fields.flatMap((f) => contractUses(r, f, name)) : []
			)
			normalizer.contract(
				contract,
				contract.desc.predicate,
				index,
				uses,
				() => this.#type(contract.desc.base, contract.loc),
				contract.loc
			)
		}
		const kept = normalizer.laws
		const classes = this.#classes(kept)
		const { laws, primaryKeys, dag } = this.#violations(normalizer.primaryKeys, kept)
		const families: ReadonlyArray<AlternativesFamily<LawId>> = normalizer.families.map((f) =>
			Object.freeze({
				id: f.id,
				containment: identifierOf(f.containment.named),
				reverse: identifierOf(f.reverse.named),
				arms: mapNonEmpty(f.arms, (a) => ({
					handle: a.handle,
					forward: identifierOf(a.forward.named)
				}))
			})
		)
		return Object.freeze({
			schema: this.owned.fingerprint,
			name: this.owned.name,
			relations: Object.freeze(Object.fromEntries(this.relations)),
			classes,
			laws,
			primaryKeys,
			lowerings: Object.freeze({}),
			dag,
			dependencies: this.#dependencies(laws),
			capabilities: this.#capabilities(laws),
			families,
			evidence: this.#evidence(laws)
		})
	}

	/**
	 * Each law, its violation query under a Forbid node of its identity, in law order, as one DAG: each primary key's law
	 * with its relation, then every other law. The kept laws and their identities are a pure function of the owned
	 * schema, and the builder allocates its identifiers in the same order for the same laws, so every build of an owned
	 * schema builds one DAG.
	 */
	#violations(
		primary: ReadonlyArray<PrimaryKeyKept>,
		kept: ReadonlyArray<KeptLaw>
	): {
		readonly laws: ReadonlyArray<TheoryLaw>
		readonly primaryKeys: ReadonlyArray<PrimaryKeyLaw>
		readonly dag: ValidDag
	} {
		const vb = new ViolationBuilder(SourceLoc(`schema ${this.owned.name}`, []))
		const write = (k: KeptLaw): TheoryLaw => {
			const id = identifierOf(k.named)
			const written = k.draft.write(vb)
			return Object.freeze({
				id,
				named: k.named,
				...k.identity,
				detail: written.detail,
				violation: vb.forbid(id, written.violation),
				loc: k.loc
			})
		}
		const primaryKeys = primary.map((p): PrimaryKeyLaw =>
			Object.freeze({ relation: p.relation, law: write(p.kept) })
		)
		const laws = [...primaryKeys.map((p) => p.law), ...kept.map(write)]
		return { laws, primaryKeys, dag: vb.b.build(laws.map((law) => law.violation)) }
	}

	#classes(kept: ReadonlyArray<KeptLaw>): ReadonlyArray<FieldClass> {
		const classes = new FieldClasses()
		for (const r of this.relations.values()) {
			for (const c of r.fields) {
				classes.add(FieldId(r.name, c.name), c.type)
			}
		}
		/** The field `f` of `a` paired with the field `g` of `b`, each at its column's type. */
		const pair = (
			a: string,
			f: HeadingColumn,
			b: string,
			g: HeadingColumn,
			loc: SourceLoc
		): void => {
			const problem = classes.union(
				{ field: FieldId(a, f.name), type: f.type },
				{ field: FieldId(b, g.name), type: g.type }
			)
			if (problem !== undefined) {
				throw new Refusal(
					malformedDescription(loc, `${a}.${f.name} paired with ${b}.${g.name} between ${problem}`)
				)
			}
		}
		for (const k of kept) {
			const detail = k.draft.identity.detail
			const loc = k.tracked
			switch (detail.kind) {
				case "containment":
					for (const p of detail.pairs) {
						pair(detail.from.relation, p.fromColumn, detail.to.relation, p.toColumn, loc)
					}
					break
				case "capacity":
					for (const p of detail.pairs) {
						pair(detail.target.relation, p.targetColumn, detail.from.relation, p.fromColumn, loc)
					}
					break
				case "key":
				case "check":
				case "contract":
				case "alternatives":
					break
			}
		}
		return classes.classes()
	}

	#dependencies(laws: ReadonlyArray<TheoryLaw>): Readonly<Record<string, ReadonlyArray<string>>> {
		const deps = new Map<string, Set<string>>()
		for (const name of this.relations.keys()) {
			deps.set(name, new Set())
		}
		const reads = laws.flatMap((law) => {
			const read = [...new Set(law.sides.map((s) => s.relation))]
			return read.flatMap((r) =>
				read.filter((other) => other !== r).map((other) => [r, other] as const)
			)
		})
		for (const [reader, read] of reads) {
			deps.get(reader)?.add(read)
		}
		return Object.freeze(
			Object.fromEntries(
				[...deps].map(([r, set]) => [r, Object.freeze([...set].toSorted(compareText))])
			)
		)
	}

	/** A nonoverlap key or a PERIOD reference with scalar equality components needs btree_gist. */
	#capabilities(laws: ReadonlyArray<TheoryLaw>): ReadonlyArray<string> {
		const caps = new Set<string>()
		for (const law of laws) {
			if (
				law.detail.kind === "key" &&
				law.detail.key.span !== undefined &&
				law.detail.key.fields.length > 1
			) {
				caps.add("extension:btree_gist")
			}
			if (
				law.detail.kind === "containment" &&
				law.detail.pairing.kind === "span" &&
				law.detail.from.fields.length > 1
			) {
				caps.add("extension:btree_gist")
			}
		}
		if (
			[...this.relations.values()].some((r) =>
				r.fields.some((c) => baseOf(c.type).carrier === "vector")
			)
		) {
			caps.add("extension:vector")
		}
		return Object.freeze([...caps].toSorted(compareText))
	}

	/** A family law's reverse obligation per arm: a parent selecting the handle has its arm row. */
	#evidence(laws: ReadonlyArray<TheoryLaw>): TheoryEvidence {
		const keys: Array<KeyEvidence> = []
		const checks: Array<CheckEvidence> = []
		const containments: Array<ContainmentEvidence> = []
		for (const law of laws) {
			const d = law.detail
			if (d.kind === "key") {
				keys.push({
					relation: d.relation,
					fields: fieldNames(d.key.fields),
					spans: d.key.span === undefined ? [] : [d.key.span.name],
					primary: d.key.primary,
					constraint: identifierOf(d.key.named),
					law: law.id,
					context: "immediate"
				})
			} else if (d.kind === "check") {
				checks.push({ relation: d.relation, name: d.name, law: law.id, context: "immediate" })
			} else if (d.kind === "containment") {
				containments.push({
					law: law.id,
					from: d.from,
					to: d.to,
					coverage: d.pairing.kind === "span",
					statement: d.stated.kind,
					context: this.#containmentContext(law, d)
				})
			}
		}
		for (const law of laws) {
			const f = law.detail
			if (f.kind !== "alternatives") {
				continue
			}
			for (const h of f.handles) {
				if (h.kind === "unarmed") {
					continue
				}
				const arm = h.arm
				containments.push({
					law: law.id,
					from: {
						relation: f.parent,
						fields: f.parentKey,
						selection: [{ column: f.discriminator, value: { kind: "enum", handle: arm.handle } }]
					},
					to: {
						relation: arm.relation,
						fields: mapNonEmpty(arm.key, (p) => p.arm),
						selection: []
					},
					coverage: false,
					statement: "mirrors",
					context: this.options.containmentContext(law)
				})
			}
		}
		return Object.freeze({ keys, checks, containments })
	}

	/**
	 * A containment into a closed roster whose source field is already of that roster's handle type is a descriptor
	 * fact ("finite closed roster"); any other is a deferred native reference or a residual law, which holds in lawful
	 * committed snapshots, unless the option says otherwise.
	 */
	#containmentContext(
		law: TheoryLaw,
		d: Extract<TheoryLaw["detail"], { readonly kind: "containment" }>
	): EvidenceContext {
		const [only, ...more] = d.pairs
		if (
			d.to.rel.kind === "closed" &&
			more.length === 0 &&
			only.to === "id" &&
			d.to.selection.length === 0 &&
			rosterOf(baseOf(only.fromColumn.type))?.closed === d.to.relation
		) {
			return "descriptor"
		}
		return this.options.containmentContext(law)
	}
}

/**
 * The CheckedTheory of an owned schema, or the first refusal: a pairing of incompatible fields or a malformed
 * alternatives expansion (MalformedDescription), pointwise capacity or multi-span coverage (UnsupportedLawFamily), a
 * literal or operator the catalogue does not admit, or the violation DAG's own validation.
 *
 * Theory normalization: field-compatibility classes, normalized laws with their
 * violation queries, alternatives families, relation dependencies, and evidence with its validity context.
 */
export const buildTheory = (
	checked: CheckedSchema,
	options: TheoryOptions
): Result.Result<Theory, CompileError> => catchRefusal(() => new Builder(checked, options).run())

/**
 * The options of a theory built before law specialization: every containment that is no descriptor fact holds in
 * lawful committed snapshots.
 */
export const provisionalTheory: TheoryOptions = Object.freeze({
	containmentContext: () => "committedSnapshot"
})

const admitted = (c: EvidenceContext): boolean => c === "immediate" || c === "descriptor"

/** The evidence valid at every statement of a write transaction: what a read inside one, such as a read-back, may rely on. */
export const immediateEvidence = (evidence: TheoryEvidence): TheoryEvidence =>
	Object.freeze({
		keys: evidence.keys,
		checks: evidence.checks,
		containments: evidence.containments.filter((c) => admitted(c.context))
	})
