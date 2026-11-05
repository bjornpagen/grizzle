import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { ViolationBuilder } from "#compiler/analysis/theory/build.ts"
import { type FieldClass, FieldClasses } from "#compiler/analysis/theory/classes.ts"
import {
	type AlternativesFamily,
	type ContractUse,
	type FamilyMember,
	fixedSelection,
	type KeptLaw,
	type LawIdentity,
	Normalizer,
	type PrimaryKeyKept,
	type ResolvedSide,
	selectorsOf,
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
import { type BoundValueDesc, type FieldDesc, fieldTermsOf, termText } from "#compiler/ir/desc.ts"
import type { EvidenceContext } from "#compiler/ir/evidence.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import {
	type EvidenceSide,
	fieldNames,
	type LawField,
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
import { regexMember } from "#compiler/scalar/regex/nfa.ts"
import { contractInfoOf, type ScalarEnv, scalarTypeOf } from "#compiler/scalar/registry.ts"
import type { Owned } from "#compiler/schema/own.ts"
import { textLookupOnce } from "#compiler/text/refinement.ts"

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
 * is marked: it proves coverage, not scalar existence. Only a containment between sides of fields selected by literal
 * conjunctions gives evidence.
 */
interface ContainmentEvidence {
	readonly law: LawId
	readonly from: EvidenceSide
	readonly to: EvidenceSide
	readonly coverage: boolean
	/**
	 * What states it: a `contained` statement (an alternatives head included), or an alternatives family, an arm's
	 * either direction. attach reads only declared containments.
	 */
	readonly statement: "contained" | "alternatives"
	readonly context: EvidenceContext
}

/**
 * The two sides of a containment as evidence states them (`EvidenceSide`): each side's fields, and the selectors of its
 * fixed conjuncts, or none when a side has a pred term. A source's selection is read whole, every conjunct fixed, or
 * the containment gives no evidence, since a source read with fewer conjuncts would claim more of its facts than the
 * law does. A target's fixed conjuncts are read and its others dropped: a target with fewer conjuncts holds more facts,
 * so the evidence claims less than the law and is sound.
 */
const evidenceSides = (
	from: ResolvedSide,
	to: ResolvedSide
): { readonly from: EvidenceSide; readonly to: EvidenceSide } | undefined => {
	const fromFields = fieldTermsOf(from.terms)
	const toFields = fieldTermsOf(to.terms)
	const fromSelection = fixedSelection(from.selection)
	if (fromFields === undefined || toFields === undefined || fromSelection === undefined) {
		return undefined
	}
	const side = (
		s: ResolvedSide,
		fields: NonEmptyReadonlyArray<{ readonly field: string }>,
		selectors: ReadonlyArray<{ readonly column: string; readonly value: TypedLiteral }>
	): EvidenceSide => ({
		relation: s.relation,
		fields: mapNonEmpty(fields, (f) => f.field),
		selection: selectors.map((x) => ({ column: x.column, value: x.value }))
	})
	return {
		from: side(from, fromFields, selectorsOf(fromSelection)),
		to: side(
			to,
			toFields,
			selectorsOf({
				conjuncts: to.selection.conjuncts.flatMap((c) => (c.kind === "fixed" ? [c] : []))
			})
		)
	}
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
 *   (laws.ts): a key, a containment and a capacity over partial projections, an alternatives expansion recognized as
 *   one family;
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

/** A side as a law's identity states it: its relation, its terms, and its conjuncts by their canonical texts. */
const sidePart = (side: ResolvedSide): Part => [
	side.relation,
	side.terms.map((t) => [t.kind, t.field]),
	side.selection.conjuncts.map((c) => c.text)
]

/** A side as a law's stem spells it: its relation, then the fields each conjunct reads. */
const sideStem = (side: ResolvedSide): ReadonlyArray<string> => [
	side.relation,
	...side.selection.conjuncts.flatMap((c) => c.reads.map((f) => f.name))
]

/** A side as a law's display spells it: its relation and terms, then each conjunct by its canonical text. */
const sideDisplay = (side: ResolvedSide): string => {
	const conjuncts = side.selection.conjuncts
	return `${side.relation}(${side.terms.map(termText).join(", ")})${
		conjuncts.length === 0 ? "" : ` where ${conjuncts.map((c) => c.text).join(" and ")}`
	}`
}

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
 * relation and fields, a key over a projected side by that side, a check by its relation and name, a contract by its
 * name, a containment by its sides (terms and selections included), a family by its origin marker, a capacity by its
 * sides, weight and bounds, each led by the law's shape. Adding or removing an unrelated statement never changes it. A
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
		case "projectedKey":
			return {
				parts: [law.shape, sidePart(d.side)],
				stem: [...sideStem(d.side), "key", ...d.side.terms.map(termText)],
				display: `key ${sideDisplay(d.side)}`
			}
		case "containment":
			return {
				parts: [law.shape, sidePart(d.from), sidePart(d.to), "contained"],
				stem: [...sideStem(d.from), "in", d.to.relation],
				display: `${sideDisplay(d.from)} ${law.shape === "coverage" ? "covered by" : "in"} ${sideDisplay(d.to)}`
			}
		case "alternatives": {
			const { relation, field } = fieldIdSpellingParts(d.family)
			return {
				parts: [law.shape, d.family],
				stem: [relation, field, "alternatives"],
				display: `alternatives of ${relation}.${field}`
			}
		}
		case "alternativesArm": {
			const { relation, field } = fieldIdSpellingParts(d.family)
			return {
				parts: [law.shape, d.family, d.arm, d.handles],
				stem: [d.arm, "arm", relation, field],
				display: `${d.arm} the arm of ${relation}.${field} at ${d.handles.join(", ")}`
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
	/** Each text pattern's analysis, read once for every field and contract of the pattern. */
	const texts = textLookupOnce()
	/** The registry's environment of the owned schema, its refusals at `loc`. */
	const schemaEnv = (loc: SourceLoc): ScalarEnv => ({
		kind: "schema",
		roster: (name) => rosters.get(name),
		text: texts,
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
			const id = s.kind === "contained" ? s.origin?.alternatives : undefined
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
				reverse: identifierOf(f.reverse.named),
				arms: mapNonEmpty(f.arms, (a) => ({
					relation: a.relation,
					handles: a.handles,
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
						pair(detail.from.relation, p.from.column, detail.to.relation, p.to.column, loc)
					}
					break
				case "capacity":
					for (const p of detail.pairs) {
						pair(detail.target.relation, p.targetColumn, detail.from.relation, p.fromColumn, loc)
					}
					break
				case "alternativesArm":
					for (const p of detail.key) {
						pair(detail.arm, p.armColumn, detail.parent, p.parentColumn, loc)
					}
					break
				case "key":
				case "projectedKey":
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
				law.detail.from.terms.length > 1
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

	/**
	 * Each key, row check and containment's evidence; an alternatives arm relation's law, each row of it a payload of a
	 * parent, selected by the discriminator when the relation is the arm of one handle, since a row of an arm of several
	 * handles may belong to a parent of any of them; and a family law's reverse obligation per arm: a parent selecting
	 * the handle has its arm row.
	 */
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
				const sides = evidenceSides(d.from, d.to)
				if (sides !== undefined) {
					containments.push({
						law: law.id,
						from: sides.from,
						to: sides.to,
						coverage: d.pairing.kind === "span",
						statement: "contained",
						context: this.#containmentContext(law, d)
					})
				}
			} else if (d.kind === "alternativesArm") {
				const [only, ...more] = d.handles
				containments.push({
					law: law.id,
					from: {
						relation: d.arm,
						fields: mapNonEmpty(d.key, (p) => p.arm),
						selection: []
					},
					to: {
						relation: d.parent,
						fields: mapNonEmpty(d.key, (p) => p.parent),
						selection:
							more.length === 0
								? [{ column: d.discriminator, value: { kind: "enum", handle: only } }]
								: []
					},
					coverage: false,
					statement: "alternatives",
					context: this.options.containmentContext(law)
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
					statement: "alternatives",
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
			only.from.kind === "field" &&
			only.to.kind === "field" &&
			only.to.field === "id" &&
			d.to.selection.conjuncts.length === 0 &&
			rosterOf(baseOf(only.from.column.type))?.closed === d.to.relation
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
