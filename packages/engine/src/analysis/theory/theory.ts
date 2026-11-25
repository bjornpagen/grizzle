import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { ViolationBuilder } from "#compiler/analysis/theory/build.ts"
import { type FieldClass, FieldClasses } from "#compiler/analysis/theory/classes.ts"
import { knownColumns } from "#compiler/analysis/theory/columns.ts"
import { familyStated } from "#compiler/analysis/theory/families.ts"
import { fillOrder } from "#compiler/analysis/theory/fill.ts"
import { instantRoles } from "#compiler/analysis/theory/instants.ts"
import {
	type ContractUse,
	fixedSelection,
	type KeptLaw,
	type LawIdentity,
	LawSides,
	type NormalizeEnv,
	Normalizer,
	type PrimaryKeyKept,
	type ResolvedSide,
	selectorsOf,
	type SidesEnv,
	type TheoryLaw
} from "#compiler/analysis/theory/laws.ts"
import {
	type LawSide,
	liveReading,
	type QueryRule,
	type RuleLaw
} from "#compiler/analysis/theory/query.ts"
import {
	familyStatement,
	ownSpelling,
	sideDisplay,
	sidePart,
	sideStem,
	sideTerms,
	type Spelling,
	spelledSlots
} from "#compiler/analysis/theory/spelling.ts"
import { checkRelation } from "#compiler/check/index.ts"
import { CheckSession } from "#compiler/check/session.ts"
import { catchRefusal, Refusal, unwrap } from "#compiler/core/canonical.ts"
import {
	type CompileError,
	malformedDescription,
	ruleRefused,
	unsupported
} from "#compiler/core/errors.ts"
import {
	type Identity,
	identifierOf,
	identity,
	type LawStatement,
	type Part
} from "#compiler/core/identity.ts"

import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import {
	type RegionFacts,
	regionFactsOf,
	type StoredUpkeep,
	storedUpkeep
} from "#compiler/analysis/theory/unit.ts"
import { type ConstraintName, FieldId, type LawId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareNumbers, compareStrings } from "#compiler/core/order.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import { type LabelledDag, LabelSupply, topoOrder } from "#compiler/ir/dag.ts"
import { noneWritten, servedQuery } from "#compiler/ir/derived.ts"
import {
	type ContractFieldDesc,
	type FieldDesc,
	fieldTermsOf,
	type InferredQuery,
	type QueryDesc,
	termText
} from "#compiler/ir/desc.ts"
import type { EvidenceContext } from "#compiler/ir/evidence.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { FillOrder } from "#compiler/ir/fill.ts"
import type { Instants } from "#compiler/ir/instant.ts"
import {
	type EvidenceSide,
	fieldNames,
	type LawField,
	type LawSource,
	type RelationInfo,
	type StoredDerivedRelation,
	type TheoryRelation
} from "#compiler/ir/law.ts"
import type { CheckedTheory } from "#compiler/ir/products.ts"
import {
	exprsOf,
	type HeadingColumn,
	type KeySet,
	type RelNode,
	type ValidDag
} from "#compiler/ir/rel.ts"
import { baseOf, type ContractInfo, Roster, type ScalarType, spanOf } from "#compiler/ir/scalar.ts"
import type { ContainmentFact } from "#compiler/logical/attach.ts"
import { contractPredicateTable } from "#compiler/scalar/compute/total.ts"
import { compatible, sameCarrier } from "#compiler/scalar/compute/types.ts"
import type { PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import { contractInfoOf, type ScalarEnv, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { derivedStatement, mergedEntry } from "#compiler/schema/declared-entries.ts"
import type { Owned } from "#compiler/schema/own.ts"
import type { StatedEntry } from "#compiler/types/changeset/changeset.ts"

/**
 * What the statement a containment's law is from refuses two of its paired fields of other base carriers for
 * (scalar/compute/types.ts sameCarrier): an alternatives arm's key against its parent's, or the sides of a containment
 * it states.
 */
const containmentPairing = (source: LawSource): Refused => {
	switch (source.kind) {
		case "alternatives":
			return "the arm's key does not match the parent key"
		case "series":
		case "relation":
		case "key":
		case "contract":
		case "check":
		case "contained":
		case "family":
		case "tree":
		case "fold":
			return "the sides' field types differ"
	}
}

/** A key of a relation as immediate evidence: the PRIMARY KEY or UNIQUE that holds at every statement. */
interface KeyEvidence {
	readonly relation: string
	readonly fields: KeySet
	/** The span fields of a nonoverlap key, compared WITHOUT OVERLAPS; none for a scalar key. */
	readonly spans: KeySet
	/** The constraint it is installed as: its relation's primary key, or a unique. */
	readonly kind: "primaryKey" | "unique"
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
interface ContainmentEvidence extends ContainmentFact {
	readonly law: LawId
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

/** The evidence a theory's laws give queries: each key, row check and containment's, with its validity context. */
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
 * - field-compatibility classes over the admitted containment pairings and every family's (classes.ts), refusing a
 *   pairing of fields of different identity;
 * - the normalized laws, each with its source identity and its violation query as a Forbid node in one DAG
 *   (laws.ts): a key and a containment over partial projections, an alternatives statement's containments, a family,
 *   a tree and a fold;
 * - every family, a tree's included, resolved (families.ts): its axes' carried pairs and its folds, and their fill
 *   order (fill.ts), every column and relation no write fills refused;
 * - the relation dependency graph: each relation and the relations its laws read;
 * - the capability obligations the laws carry (btree_gist for span keys and coverage with scalar parts, the vector
 *   extension for vector fields).
 *
 * No evidence is stated here: law specialization (laws/) recognizes each normalized law, lowers it to its natives,
 * and states the evidence each law gives with the validity context its plans prove (theoryEvidence). A law's identity
 * is the naming door's (core/identity.ts), minted from what the law is (lawIdentityOf), so every build of a schema
 * names its laws alike.
 */
/** An ordinary relation with the law of its primary key. */
export interface PrimaryKeyLaw {
	readonly relation: RelationInfo
	readonly law: TheoryLaw
}

export interface Theory extends CheckedTheory {
	readonly name: string
	/**
	 * The relations the laws read, typed: the ordinary and closed relations, and each stored derived relation, whose
	 * admitted unit (ir/law.ts StoredDerivedRelation `unit`) its upkeep and the isolation checker read; a live derived
	 * relation is no relation of the laws, which read its definition.
	 */
	readonly relations: Readonly<Record<string, TheoryRelation>>
	readonly classes: ReadonlyArray<FieldClass>
	readonly laws: ReadonlyArray<TheoryLaw>
	/** Each ordinary relation with its primary key's law, a law of `laws`, in relation order: the theory states one
	 * primary key per ordinary relation. */
	readonly primaryKeys: ReadonlyArray<PrimaryKeyLaw>
	/** What the theory lowers, in one DAG (Builder.#written), with its label supply, which the law model's merge reads:
	 * no law's violation query (laws/model/violations.ts). */
	readonly dag: LabelledDag
	/**
	 * Every family, ordered, counted or a tree, in statement order, with its axes' carried pairs and its folds resolved
	 * (ir/family.ts): what the law model lowers to natives, the write planner draws and fills, and the shell reads counts
	 * by.
	 */
	readonly families: ReadonlyArray<Family>
	/**
	 * The families' fill order (ir/fill.ts): when a write fills each column grizzle writes, which the analysis
	 * (analysis/theory/fill.ts) built once, refusing every column and relation no write fills, and the host's filler
	 * fills by.
	 */
	readonly fill: FillOrder
	/** The containments a whole rule's region reads (unit.ts RegionFacts), which the law model's whole containments read too. */
	readonly regionFacts: RegionFacts
	/** Every instant field a clock or a reference (ir/instant.ts), as the classifier read them off the laws
	 * (analysis/theory/instants.ts), which a write stamps by. */
	readonly instants: Instants
	/** Each stored derived relation's upkeep (analysis/theory/unit.ts StoredUpkeep), level by level and in name order
	 * within one: what the judge's phase A writes at COMMIT (physical/ddl/rules.ts), each after the upkeep of every stored
	 * relation it reads. */
	readonly upkeeps: ReadonlyArray<StoredUpkeep>
}

/** A theory with the evidence its laws give queries (theoryEvidence), each containment's validity context the one law
 * specialization proves. */
export interface EvidencedTheory extends Theory {
	readonly evidence: TheoryEvidence
}

/** A contract's law: its name, which one contract has wherever its domain is installed. */
const contractStatement = (contract: string): LawStatement => ({
	parts: ["contract", contract],
	stem: [contract],
	display: `contract ${contract}`
})

/**
 * What a law is, independent of where its statement sits among the others, as the naming door states it under
 * `spell`: a key by its relation and fields, a key over a projected side by that side, a check by its relation and
 * name, a contract by its name, a containment by its sides (terms and selections included), a family by its order, its
 * slots and its member's terms, a tree by its slots and its member's terms, its root fields first (spelling.ts
 * familyStatement), and a fold by its slots, its monoid and its two sides, each led by the law's shape. Adding or
 * removing an unrelated statement never changes it: a fold's position among its family's folds is no part of it.
 */
export const lawStatement = (law: LawIdentity, spell: Spelling): LawStatement => {
	const d = law.detail
	switch (d.kind) {
		case "key": {
			const relation = spell.relation(d.relation)
			const fields = fieldNames(d.key.fields).map((f) => spell.field(d.relation, f))
			return {
				parts: [law.shape, relation, fields],
				stem: [relation, law.shape === "pk" ? "pk" : "key", ...fields],
				display: `${law.shape === "pk" ? "primary key" : "key"} ${relation}(${fields.join(", ")})`
			}
		}
		case "check": {
			const relation = spell.relation(d.relation)
			return {
				parts: [law.shape, relation, d.name],
				stem: [relation, "check", d.name],
				display: `check ${d.name} of ${relation}`
			}
		}
		case "contract":
			return contractStatement(d.contract)
		case "projectedKey":
			return {
				parts: [law.shape, sidePart(d.side, spell)],
				stem: [...sideStem(d.side, spell), "key", ...sideTerms(d.side, spell)],
				display: `key ${sideDisplay(d.side, spell)}`
			}
		case "containment":
			return {
				parts: [law.shape, sidePart(d.from, spell), sidePart(d.to, spell), "contained"],
				stem: [...sideStem(d.from, spell), "in", spell.relation(d.to.relation)],
				display: `${sideDisplay(d.from, spell)} ${law.shape === "coverage" ? "covered by" : "in"} ${sideDisplay(d.to, spell)}`
			}
		case "family":
		case "tree":
			return familyStatement(familyStated(d.family), spell)
		case "rule":
			return ruleStatement(law.shape, lawOfRule(d.rule), spell)
		case "fold": {
			const owner = spell.relation(d.family.owner)
			const count = spell.field(d.family.owner, d.family.count)
			return {
				parts: [law.shape, owner, count, d.monoid, sidePart(d.step, spell), sidePart(d.end, spell)],
				stem: [owner, count, d.monoid, "fold"],
				display: `${d.monoid} fold over ${spelledSlots(d.family, spell)} of ${sideDisplay(d.step, spell)} into ${sideDisplay(d.end, spell)}`
			}
		}
	}
}

/** The law a rule over a query states, whichever strategy judges it: its identity is the law's alone. */
const lawOfRule = (rule: QueryRule): RuleLaw<LawSide> => {
	switch (rule.kind) {
		case "contained":
		case "key":
		case "check":
			return rule
		case "whole":
			return rule.law
	}
}

/** A side of a rule over a query as its law's identity states it: its relation, its terms and its conjuncts' texts. */
const rulePart = (side: LawSide, spell: Spelling): Part => [
	spell.relation(side.relation),
	side.terms.map((t) => [t.kind, spell.field(side.relation, t.field)]),
	spell.texts(side)
]

/** A side of a rule over a query as its law's display spells it: each conjunct as its author's predicate. */
const ruleDisplay = (side: LawSide, spell: Spelling): string => {
	const texts = spell.displays(side)
	return `${spell.relation(side.relation)}(${side.terms
		.map((t) => termText({ ...t, field: spell.field(side.relation, t.field) }))
		.join(", ")})${texts.length === 0 ? "" : ` where ${texts.join(" and ")}`}`
}

/** A rule over a query as the naming door states it: a containment by its sides, a key by its side, a check by its
 * relation and name, as the same rule over stored relations is. */
const ruleStatement = (
	shape: LawIdentity["shape"],
	rule: RuleLaw<LawSide>,
	spell: Spelling
): LawStatement => {
	switch (rule.kind) {
		case "contained":
			return {
				parts: [shape, rulePart(rule.from, spell), rulePart(rule.to, spell), "contained"],
				stem: [spell.relation(rule.from.relation), "in", spell.relation(rule.to.relation)],
				display: `${ruleDisplay(rule.from, spell)} in ${ruleDisplay(rule.to, spell)}`
			}
		case "key":
			return {
				parts: [shape, rulePart(rule.side, spell)],
				stem: [
					spell.relation(rule.side.relation),
					"key",
					...rule.side.terms.map((t) => spell.field(rule.side.relation, t.field))
				],
				display: `key ${ruleDisplay(rule.side, spell)}`
			}
		case "check": {
			const relation = spell.relation(rule.side.relation)
			return {
				parts: [shape, relation, rule.name],
				stem: [relation, "check", rule.name],
				display: `check ${rule.name} of ${relation}`
			}
		}
	}
}

/** A law's identity at the naming door: its LawId is the identity's identifier. */
export const lawIdentityOf = (law: LawIdentity): Identity<"law"> =>
	identity.law(lawStatement(law, ownSpelling))

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
	for (let contract = t.contract; contract !== undefined; contract = contract.base.contract) {
		names.push(contract.name)
	}
	return names
}

/**
 * The typing environment of an owned schema's laws: the descriptor registry's reading, its closed relations' rosters,
 * each contract's predicate table, and `patterns`, the admitted patterns of the compile it serves with the text
 * analysis of a pattern a predicate computes (scalar/regex/patterns.ts PatternAutomata), its checked schema's one table
 * (analysis/schema.ts CheckedSchema `patterns`). Theory normalization types its laws in it, and law specialization its
 * generated CHECK predicates.
 */
export const typingEnv = (
	owned: Owned,
	patterns: PatternAutomata
): {
	readonly fieldType: (desc: FieldDesc, loc: SourceLoc) => Result.Result<ScalarType, CompileError>
	readonly contractInfo: (
		desc: ContractFieldDesc,
		loc: SourceLoc
	) => Result.Result<ContractInfo, CompileError>
	readonly patterns: PatternAutomata
} => {
	const rosters = new Map<string, Roster>()
	for (const r of Object.values(owned.relations)) {
		if (r.kind === "closed") {
			rosters.set(r.name, r.roster)
		}
	}
	const fieldType = (desc: FieldDesc, loc: SourceLoc): Result.Result<ScalarType, CompileError> =>
		scalarTypeOf(desc, schemaEnv(loc), loc)
	/** The registry's environment of the owned schema, its refusals at `loc`. */
	const schemaEnv = (loc: SourceLoc): ScalarEnv => ({
		kind: "schema",
		roster: (name) => rosters.get(name),
		contractPredicate: (predicate, base, contract, facts) =>
			contractPredicateTable(predicate, base, contract, facts, {
				loc,
				fieldType,
				patterns
			})
	})
	return {
		fieldType,
		contractInfo: (desc, loc) => contractInfoOf(desc, schemaEnv(loc), loc),
		patterns
	}
}

/**
 * What a checked schema's law sides are resolved in (laws.ts SidesEnv): the stored relations' handles the checked
 * schema minted, by name, its closure's, and the typing environment of its laws (typingEnv), its lowerings applying the
 * closed relations its laws' predicates and terms may read (CheckedSchema.closedReads).
 */
const sidesEnvOf = (checked: CheckedSchema): SidesEnv => {
	const typing = typingEnv(checked.owned, checked.patterns)
	return {
		relations: new Map(checked.stored.map((r) => [r.name, r] as const)),
		lowerEnv: {
			fieldType: typing.fieldType,
			patterns: typing.patterns,
			closed: checked.closedReads
		}
	}
}

class Builder {
	readonly owned: Owned
	/**
	 * What the theory's law sides are resolved in (sidesEnvOf): the checked schema's stored and closed relations, and
	 * each stored derived relation as the theory reads it (ir/law.ts StoredDerivedRelation).
	 */
	readonly sides: SidesEnv
	/** The checker's reading of the owned schema, which a rule over a query's violation query is checked against. */
	readonly checked: CheckedSchema
	/** Each derived relation's definition, by name, a stored one's among them. */
	readonly definitions: ReadonlyMap<string, QueryDesc>
	/** The containments of the closure's statements a whole rule's region reads (unit.ts RegionFacts), and the declared
	 * unit each relation's rows sit in, a stored derived relation's the one its admission decided (ir/unit.ts StoredUnit
	 * `declared`), so a rule reading its table and its holders is judged whole under the one borrow that covers both. */
	readonly regionFacts: RegionFacts
	/** Each stored derived relation's upkeep (StoredUpkeep), level by level and in name order within one. */
	readonly upkeeps: ReadonlyArray<StoredUpkeep>

	constructor(checked: CheckedSchema) {
		this.checked = checked
		this.#columns = knownColumns(checked)
		this.definitions = new Map(
			Object.values(checked.owned.relations).flatMap((r) =>
				r.desc.kind === "derived" ? [[r.name, r.desc.query] as const] : []
			)
		)
		this.owned = checked.owned
		const authored = sidesEnvOf(checked)
		const facts = regionFactsOf(
			checked.closure.statements.map((s) => s.statement),
			authored.relations,
			this.definitions,
			checked.owned.unitOf
		)
		const { stored, upkeeps } = this.#stored(authored.relations, facts)
		this.upkeeps = upkeeps
		this.sides = {
			...authored,
			relations: new Map([...authored.relations, ...stored.map((r) => [r.name, r] as const)])
		}
		this.regionFacts = {
			...facts,
			members: new Map([
				...facts.members,
				...stored.flatMap((r) =>
					r.unit.kind === "unit" ? [[r.name, r.unit.declared] as const] : []
				)
			])
		}
	}

	/** The columns of each definition the theory reads, each checked once however many laws read it (columns.ts knownColumns). */
	readonly #columns: NormalizeEnv["columnType"]

	/**
	 * The definition of a derived relation the theory reads live, by name: a live one's, none for a stored one, whose table
	 * every reader reads as a relation's (ir/law.ts StoredDerivedRelation), a law's violation query and a stored
	 * relation's upkeep alike, nor for an authored or closed relation. The checked schema decided each derived relation's
	 * holding (analysis/derived/storage.ts) before the theory reads any.
	 */
	readonly #readLive = (relation: string): QueryDesc | undefined =>
		this.checked.holdings.get(relation)?.kind === "stored"
			? undefined
			: this.definitions.get(relation)

	/** How the theory reads each relation, each live definition read once however many readers read it. */
	readonly #live = liveReading((relation) => this.#readLive(relation))

	/**
	 * What normalizing the schema's laws reads of it: its relations, each derived relation's definition and the types its
	 * columns are delivered at, the naming door's law identities, and the typing environment its predicates and terms
	 * lower in.
	 */
	env(): NormalizeEnv {
		return {
			...this.sides,
			definition: this.#readLive,
			columnType: this.#columns,
			live: this.#live,
			named: lawIdentityOf,
			regionFacts: this.regionFacts
		}
	}

	/**
	 * Primary keys, in relation order; every family's and tree's shape, so a containment knows the axes it may ride;
	 * the statements, in canonical order; contracts, in name order, with every column and span endpoint that stores
	 * their values. Then the drawn and accumulated fields' namings are checked: every law kept, none written yet. The
	 * relations and statements are the checked schema's closure's (analysis/closure.ts), each law sourced at its index in
	 * the whole schema's, so each is the law the whole schema's theory states.
	 */
	#normalize(): Normalizer {
		const normalizer = new Normalizer(this.env())
		const stored = Object.values(this.owned.relations)
			.flatMap((r) => (r.kind === "derived" ? [] : [r.name]))
			.toSorted(compareStrings)
		for (const [index, name] of stored.entries()) {
			const r = this.sides.relations.get(name)
			if (r?.kind === "relation") {
				normalizer.primaryKey(r, index)
			}
		}
		normalizer.families(this.checked.closure.statements.map((s) => s.statement))
		for (const { statement, index } of this.checked.closure.statements) {
			normalizer.statement(statement, index)
		}
		const contracts = Object.entries(this.owned.contracts).toSorted(([a], [b]) =>
			compareStrings(a, b)
		)
		for (const [index, [name, contract]] of contracts.entries()) {
			const uses = [...this.sides.relations.values()].flatMap((r) =>
				r.kind === "relation" ? r.fields.flatMap((f) => contractUses(r, f, name)) : []
			)
			normalizer.contract(contract, index, uses, contract.loc)
		}
		normalizer.finish(this.checked.closure.filled)
		return normalizer
	}

	/** The schema's laws normalized (`normalize`), the families resolved and every law's detail written. */
	run(): Theory {
		const normalizer = this.#normalize()
		const kept = normalizer.laws
		const classes = this.#classes(kept, normalizer.familyPairings())
		const { laws, primaryKeys, dag, families } = this.#written(normalizer, kept)
		const fill = unwrap(fillOrder(families, laws))
		const relations = Object.freeze(Object.fromEntries(this.sides.relations))
		const instants = unwrap(instantRoles(relations, laws))
		return Object.freeze({
			schema: this.owned.fingerprint,
			name: this.owned.name,
			relations,
			classes,
			laws,
			primaryKeys,
			dag,
			dependencies: this.#dependencies(laws),
			capabilities: this.#capabilities(laws),
			families,
			fill,
			regionFacts: this.regionFacts,
			instants,
			upkeeps: this.upkeeps
		})
	}

	/**
	 * Each stored derived relation, as the checked schema decided it (analysis/derived/storage.ts DerivedHolding), with its
	 * upkeep, level by level and in name order within one: its definition read live (`live`), each live derived relation
	 * it names through its definition and each stored one as its table, over the authored and closed relations
	 * `relations` and the stored relations of the levels below it, its upkeep's region read by the closure's facts
	 * `facts`.
	 */
	#stored(
		relations: ReadonlyMap<string, TheoryRelation>,
		facts: RegionFacts
	): {
		readonly stored: ReadonlyArray<StoredDerivedRelation>
		readonly upkeeps: ReadonlyArray<StoredUpkeep>
	} {
		const stored: Array<StoredDerivedRelation> = []
		const upkeeps: Array<StoredUpkeep> = []
		const known = new Map(relations)
		for (const r of Object.values(this.owned.relations).toSorted(
			(a, b) => compareNumbers(a.level, b.level) || compareStrings(a.name, b.name)
		)) {
			const holding = this.checked.holdings.get(r.name)
			if (r.kind !== "derived" || holding?.kind !== "stored") {
				continue
			}
			const admitted = holding.relation
			stored.push(admitted)
			/** Its upkeep at COMMIT, none for one frozen at the installation, whose rows no COMMIT changes (ir/unit.ts
			 * FrozenUnit). */
			const upkeep =
				admitted.unit.kind === "unit"
					? [
							storedUpkeep(
								r.name,
								this.#live.query(r.desc.query),
								admitted.unit,
								known,
								facts,
								r.desc.loc
							)
						]
					: []
			appendAll(upkeeps, upkeep)
			known.set(r.name, admitted)
		}
		return { stored: Object.freeze(stored), upkeeps: Object.freeze(upkeeps) }
	}

	/**
	 * Each law with its detail written, in law order: each primary key's law with its relation, then every other law.
	 * The families are resolved first, each fold's step selection lowered, since a family's and a tree's law carry
	 * them; a rule over a query keeps its violation query as normalization wrote it. No law's violation query is written
	 * or checked (laws/model/violations.ts writes and checks them, for the snapshot that reads them) and no row check's
	 * predicate is lowered (law specialization lowers the checks it keeps). The DAG holds what the theory lowered, each
	 * fold's nonempty step selection projected over its scan, so the law model's own DAG extends it under labels apart
	 * from every one it carries.
	 */
	#written(
		normalizer: Normalizer,
		kept: ReadonlyArray<KeptLaw>
	): {
		readonly laws: ReadonlyArray<TheoryLaw>
		readonly primaryKeys: ReadonlyArray<PrimaryKeyLaw>
		readonly dag: LabelledDag
		readonly families: ReadonlyArray<Family>
	} {
		const vb = new ViolationBuilder(SourceLoc(`schema ${this.owned.name}`, []))
		const resolved = normalizer.resolve(vb)
		const roots = resolved.selections.map((s) =>
			vb.project(
				s.region,
				s.where.map((w, i) => [`where${i}`, w] as const)
			)
		)
		const write = (k: KeptLaw): TheoryLaw => {
			const stated = k.identity
			const law = {
				id: identifierOf(k.named),
				named: k.named,
				...stated,
				loc: k.loc,
				entry: this.#entryOf(stated.statements, k)
			}
			const writing = k.draft.write
			switch (writing.kind) {
				case "built":
					return Object.freeze({ ...law, detail: writing.detail() })
				case "query":
					return Object.freeze({
						...law,
						detail: { ...writing.detail, violation: writing.violation }
					})
			}
		}
		const primaryKeys = normalizer.primaryKeys.map((p: PrimaryKeyKept): PrimaryKeyLaw =>
			Object.freeze({ relation: p.relation, law: write(p.kept) })
		)
		const laws = [...primaryKeys.map((p) => p.law), ...kept.map(write)]
		const built = vb.b.build(roots)
		return {
			laws,
			primaryKeys,
			dag: new LabelSupply(built).dag(built.roots),
			families: resolved.families
		}
	}

	/**
	 * The catalog entry of the law `k` its statements state (`statements`, indices into the owned schema's): the one their
	 * author declares, merged over them (runtime/law-entry.ts mergedEntry), or none, so the law's is derived. Two
	 * statements of one law whose authors declare two entries are refused (MalformedDescription), since one law has one
	 * name.
	 */
	#entryOf(statements: ReadonlyArray<number>, k: KeptLaw): StatedEntry {
		let entry: StatedEntry = this.#declaredFor(k)
		for (const s of statements) {
			const merged = mergedEntry(
				entry,
				defined(this.owned.statementEntries[s], "a law's statement is a statement of its schema")
			)
			if (merged === undefined) {
				throw new Refusal(
					malformedDescription(
						k.loc,
						`two catalog entries for the law ${k.named.display}, which statements of the schema state: one law has one entry`
					)
				)
			}
			entry = merged
		}
		return entry
	}

	/**
	 * The catalog entry the schema's declarations declare for the law `k` where no statement states it (Owned declared):
	 * a primary key's, its relation's, and a contract's, its own; none for any other law.
	 */
	#declaredFor(k: KeptLaw): StatedEntry {
		const detail = k.draft.identity.detail
		const declared =
			detail.kind === "key" && k.draft.identity.source.kind === "relation"
				? this.owned.declared.primaryKeys.get(detail.relation)
				: detail.kind === "contract"
					? this.owned.declared.contracts.get(detail.contract)
					: undefined
		return declared ?? derivedStatement
	}

	/**
	 * The field-compatibility classes: every field of every relation, each containment's pairs, of one base carrier, and
	 * each family's (Normalizer.familyPairings), of one identity, so two fields one law compares are of one base carrier
	 * and compare under its equality.
	 */
	#classes(
		kept: ReadonlyArray<KeptLaw>,
		families: ReturnType<Normalizer["familyPairings"]>
	): ReadonlyArray<FieldClass> {
		const classes = new FieldClasses()
		for (const r of this.sides.relations.values()) {
			for (const c of r.fields) {
				classes.add(FieldId(r.name, c.name), c.type)
			}
		}
		/**
		 * The field `f` of `a` paired with the field `g` of `b`, each at its column's type, by a statement whose pairs
		 * share what `meets` reads, which refuses two that do not for `refusal`, a rule the types name too.
		 */
		const pair = (
			a: string,
			f: HeadingColumn,
			b: string,
			g: HeadingColumn,
			loc: SourceLoc,
			meets: (x: ScalarType, y: ScalarType) => boolean,
			refusal: Refused
		): void => {
			const paired = classes.union(
				{ field: FieldId(a, f.name), type: f.type },
				{ field: FieldId(b, g.name), type: g.type },
				meets
			)
			if (!paired) {
				throw new Refusal(ruleRefused(loc, refusal))
			}
		}
		for (const k of kept) {
			const detail = k.draft.identity.detail
			if (detail.kind === "containment") {
				const refusal = containmentPairing(k.draft.identity.source)
				for (const p of detail.pairs) {
					pair(
						detail.from.relation,
						p.from.column,
						detail.to.relation,
						p.to.column,
						k.tracked,
						sameCarrier,
						refusal
					)
				}
			}
		}
		for (const p of families) {
			pair(p.a, p.f, p.b, p.g, p.loc, compatible, p.refusal)
		}
		return classes.classes()
	}

	#dependencies(laws: ReadonlyArray<TheoryLaw>): Readonly<Record<string, ReadonlyArray<string>>> {
		const deps = new Map<string, Set<string>>()
		for (const name of this.sides.relations.keys()) {
			deps.set(name, new Set())
		}
		const reads = laws.flatMap((law) => {
			const read = [...law.reads]
			return read.flatMap((r) =>
				read.filter((other) => other !== r).map((other) => [r, other] as const)
			)
		})
		for (const [reader, read] of reads) {
			defined(deps.get(reader), "a law reads a relation of the theory").add(read)
		}
		return Object.freeze(
			Object.fromEntries(
				[...deps].map(([r, set]) => [r, Object.freeze([...set].toSorted(compareStrings))])
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
			[...this.sides.relations.values()].some((r) =>
				r.fields.some((c) => baseOf(c.type).carrier === "vector")
			)
		) {
			caps.add("extension:vector")
		}
		return Object.freeze([...caps].toSorted(compareStrings))
	}
}

/**
 * The CheckedTheory of an owned schema, or the first refusal: a pairing of incompatible fields, a malformed family, tree
 * or fold, or a drawn or accumulated field no statement names or two do (MalformedDescription), multi-span coverage
 * (UnsupportedLawFamily), a literal or operator the catalogue does not admit, or the violation DAG's own validation.
 *
 * Theory normalization: field-compatibility classes, normalized laws with their violation queries, the families and
 * relation dependencies.
 */
export const buildTheory = (checked: CheckedSchema): Result.Result<Theory, CompileError> =>
	catchRefusal(() => new Builder(checked).run())

/**
 * A rule over a query's violation query, as normalization wrote it (`violation`), checked against the checked schema
 * its theory was built over: what the violation queries' writer reads (laws/model/violations.ts), its one reader, so
 * no theory checks a rule's query no installation's snapshot writes. A rule whose violation reads a stable value
 * (`readsStable`) is refused: its verdict can change with no write, as a setting of the session it reads changes, so
 * neither its judge, which reads the units or the deltas a transaction wrote, nor the migration's check over its rows
 * holds it of every state.
 */
export const ruleViolation = (
	checked: CheckedSchema,
	law: Pick<TheoryLaw, "named" | "loc">,
	violation: InferredQuery
): Result.Result<{ readonly dag: ValidDag; readonly root: RelNode }, CompileError> =>
	Result.flatMap(
		checkRelation(checked, violation, {
			label: `rule ${law.named.display}`,
			clock: noClock,
			session: new CheckSession(checked.patterns)
		}),
		(admitted) => {
			/** What its rows are read from: every derived relation it reads, at any depth, through its definition, whatever
			 * the installation stores (ir/derived.ts servedQuery). */
			const read = servedQuery(admitted, checked.expanded())
			if (readsStable(read.dag)) {
				return Result.err(
					unsupported(
						law.loc,
						`a rule whose violation reads its rows alone, every value immutable; rule ${law.named.display} reads a stable one, a declared function's or a conversion's that reads a setting of its session, which can change its verdict with no write`
					)
				)
			}
			/** As its writer's readers lower it, each over the rows a COMMIT leaves: a stored relation's table, current. */
			const served = servedQuery(admitted, checked.rows(noneWritten))
			return Result.ok({ dag: served.dag, root: served.dag.roots[0] })
		}
	)

/**
 * Whether `dag` reads a stable value: an expression that is (ir/expr.ts exprEffects, which makes a stable argument's
 * reader stable), or a call of a declared function's rows that is not immutable.
 */
const readsStable = (dag: ValidDag): boolean =>
	topoOrder(dag).some(
		(n) =>
			(n.kind === "Call" &&
				n.function.kind !== "split" &&
				n.function.kind !== "series" &&
				n.function.volatility !== "immutable") ||
			exprsOf(n).some((e) => e.volatility === "stable")
	)

/**
 * The sides of a checked schema's laws, resolved as its theory resolves them (LawSides), in the sides' environment its
 * normalization reads (sidesEnvOf), and nothing else of it, its region facts never: what the violation queries' writer
 * (laws/model/violations.ts) writes each law's violation query by, from what its theory law carries.
 */
export const lawSides = (checked: CheckedSchema): LawSides => new LawSides(sidesEnvOf(checked))

/**
 * Each key, row check and containment's evidence, an alternatives expansion's containments among them (statement
 * "alternatives"), with its validity context: keys and row checks are validated immediate storage facts, and so is a
 * containment into a closed relation, since the roster's domain types a lone field contained in its own roster, a table
 * CHECK reads every other's constant, and one between closed relations holds of their declared facts, which the
 * migration installing them checks. Any other containment is a native reference, immediate where law specialization
 * proves it (`immediate`, a non-deferred native FK) and holding in lawful committed snapshots otherwise. A family's, a
 * tree's and a fold's laws give none of their own: a containment riding a family's axis gives its evidence as a
 * containment.
 */
export const theoryEvidence = (
	laws: ReadonlyArray<TheoryLaw>,
	immediate: ReadonlySet<LawId>
): TheoryEvidence => {
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
				kind: d.key.primary ? "primaryKey" : "unique",
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
					statement: law.source.kind === "alternatives" ? law.source.kind : "contained",
					context:
						d.to.rel.kind === "closed" || immediate.has(law.id) ? "immediate" : "committedSnapshot"
				})
			}
		}
	}
	return Object.freeze({ keys, checks, containments })
}

const admitted = (c: EvidenceContext): boolean => c === "immediate"

/** The evidence valid at every statement of a write transaction: what a read inside one, such as a read-back, may rely on. */
export const immediateEvidence = (evidence: TheoryEvidence): TheoryEvidence =>
	Object.freeze({
		keys: evidence.keys,
		checks: evidence.checks,
		containments: evidence.containments.filter((c) => admitted(c.context))
	})
import { noClock } from "#compiler/ir/clock.ts"
