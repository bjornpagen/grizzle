import { fieldDescOf } from "#compiler/analysis/derived/fields.ts"
import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { refuse, ViolationBuilder } from "#compiler/analysis/theory/build.ts"
import { type FieldClass, FieldClasses } from "#compiler/analysis/theory/classes.ts"
import { familyStated } from "#compiler/analysis/theory/families.ts"
import { fillOrder } from "#compiler/analysis/theory/fill.ts"
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
	type TheoryLaw
} from "#compiler/analysis/theory/laws.ts"
import type { RuleSide } from "#compiler/analysis/theory/query.ts"
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
import { checkDefinition, checkQuery } from "#compiler/check/index.ts"
import { catchRefusal, compareText, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, refused } from "#compiler/core/errors.ts"
import {
	type Identity,
	identifierOf,
	identity,
	type LawStatement,
	type Part
} from "#compiler/core/identity.ts"

import { type ConstraintName, FieldId, type LawId } from "#compiler/core/ids.ts"
import { defined } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import * as Result from "#compiler/core/result.ts"
import { type LabelledDag, LabelSupply } from "#compiler/ir/dag.ts"
import {
	type FieldDesc,
	fieldTermsOf,
	type InferredFieldDesc,
	type InferredQuery,
	type QueryDesc,
	termText
} from "#compiler/ir/desc.ts"
import type { EvidenceContext } from "#compiler/ir/evidence.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { FillOrder } from "#compiler/ir/fill.ts"
import {
	type EvidenceSide,
	fieldNames,
	type LawField,
	type LawSource,
	type RelationInfo,
	type TheoryRelation
} from "#compiler/ir/law.ts"
import type { CheckedTheory } from "#compiler/ir/products.ts"
import type { HeadingColumn, KeySet, RelNode, ValidDag } from "#compiler/ir/rel.ts"
import {
	baseOf,
	type ContractInfo,
	contractOf,
	Roster,
	type ScalarType,
	spanOf
} from "#compiler/ir/scalar.ts"
import type { ClosedRelations } from "#compiler/scalar/compute/lower.ts"
import { contractPredicateTable } from "#compiler/scalar/compute/total.ts"
import { CompilePatterns, type PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import {
	contractInfoOf,
	type ScalarEnv,
	scalarTypeOf,
	type TextLookup
} from "#compiler/scalar/registry.ts"
import type { Owned } from "#compiler/schema/own.ts"
import { textLookup } from "#compiler/text/refinement.ts"

/**
 * What the statement a containment's law is from refuses two of its paired fields of other identities for: an
 * alternatives arm's key against its parent's, or the sides of a containment it states.
 */
const containmentPairing = (source: LawSource): Refused =>
	source.kind === "alternatives"
		? "the arm's key does not match the parent key"
		: "the sides' field types differ"

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
	 * What states it: a `contained` statement, or an alternatives statement's expansion (desc.ts expandAlternatives). attach reads only
	 * declared containments.
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
	/** The relations and closed relations the laws read, typed; derived relations carry no law. */
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
 * slots and its member's terms, a tree by its slots, its member's terms and its root field (spelling.ts
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
			return ruleStatement(law.shape, d.rule, spell)
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

/** A side of a rule over a query as its law's identity states it: its relation, its terms and its conjuncts' texts. */
const rulePart = (side: RuleSide, spell: Spelling): Part => [
	spell.relation(side.relation),
	side.terms.map((t) => [t.kind, spell.field(side.relation, t.field)]),
	side.texts
]

/** A side of a rule over a query as its law's display spells it. */
const ruleDisplay = (side: RuleSide, spell: Spelling): string =>
	`${spell.relation(side.relation)}(${side.terms
		.map((t) => termText({ ...t, field: spell.field(side.relation, t.field) }))
		.join(", ")})${side.texts.length === 0 ? "" : ` where ${side.texts.join(" and ")}`}`

/** A rule over a query as the naming door states it: a containment by its sides, a key by its side, a check by its
 * relation and name, as the same rule over stored relations is. */
const ruleStatement = (
	shape: LawIdentity["shape"],
	rule: Extract<LawIdentity["detail"], { readonly kind: "rule" }>["rule"],
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
	for (let contract = contractOf(t); contract !== undefined; contract = contractOf(contract.base)) {
		names.push(contract.name)
	}
	return names
}

/**
 * The typing environment of an owned schema's laws: the descriptor registry's reading, its closed relations' rosters,
 * each contract's predicate table, the admitted patterns of the compile it serves (scalar/regex/patterns.ts), one table
 * per environment, and the text analysis of a pattern a predicate computes. Theory normalization types its laws in it,
 * and law specialization its generated CHECK predicates.
 */
export const typingEnv = (
	owned: Owned
): {
	readonly fieldType: (desc: FieldDesc, loc: SourceLoc) => Result.Result<ScalarType, CompileError>
	readonly contractInfo: (
		desc: Extract<FieldDesc, { readonly kind: "contract" }>,
		loc: SourceLoc
	) => Result.Result<ContractInfo, CompileError>
	readonly patterns: PatternAutomata
	readonly patternLanguage: TextLookup
} => {
	const patterns = new CompilePatterns()
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
				patterns,
				patternLanguage: textLookup
			})
	})
	return {
		fieldType,
		contractInfo: (desc, loc) => contractInfoOf(desc, schemaEnv(loc), loc),
		patterns,
		patternLanguage: textLookup
	}
}

class Builder {
	readonly owned: Owned
	readonly fieldType: (desc: FieldDesc, loc: SourceLoc) => Result.Result<ScalarType, CompileError>
	/** The admitted patterns the theory's compile reads (typingEnv). */
	readonly patterns: PatternAutomata
	/** The stored relations' handles the checked schema minted, by name: its closure's. */
	readonly relations: ReadonlyMap<string, TheoryRelation>
	/** The closed relations a law's predicates and terms may apply (CheckedSchema.closedReads). */
	readonly closed: ClosedRelations
	/** The checker's reading of the owned schema, which a rule over a query's violation query is checked against. */
	readonly checked: CheckedSchema
	/** Each derived relation's definition, by name. */
	readonly definitions: ReadonlyMap<string, QueryDesc>

	constructor(checked: CheckedSchema) {
		this.checked = checked
		this.definitions = new Map(
			Object.values(checked.owned.relations).flatMap((r) =>
				r.desc.kind === "derived" ? [[r.name, r.desc.query] as const] : []
			)
		)
		this.owned = checked.owned
		const typing = typingEnv(checked.owned)
		this.fieldType = typing.fieldType
		this.patterns = typing.patterns
		this.closed = checked.closedReads
		this.relations = new Map(checked.stored.map((r) => [r.name, r] as const))
	}

	/**
	 * The descriptor each column of `query`, read as a definition of `relation`, is delivered at: its heading as the
	 * checker types it against the checked schema, a bare head literal's column by its value or by its position in a
	 * union, each column the inferred field's own descriptor (analysis/derived/fields.ts fieldDescOf), a computed
	 * numeric's its bound, whatever its value, NaN, an infinity or one past numeric(p, s)'s limits included.
	 */
	#columnType(
		relation: string,
		query: InferredQuery,
		loc: SourceLoc
	): (column: string) => InferredFieldDesc {
		const admitted = checkDefinition(this.checked, `derived ${relation}`, query)
		if (!admitted.ok) {
			throw new Refusal(admitted.error)
		}
		const heading = new Map(
			admitted.value.dag.roots[0].heading.map((c) => [c.name, c.type] as const)
		)
		return (column) => {
			const type = heading.get(column)
			if (type === undefined) {
				return refuse("MalformedDescription", loc, `a column ${column} of ${relation}'s definition`)
			}
			const desc = fieldDescOf(type, this.owned.contracts)
			return desc.ok
				? desc.value
				: refuse("MalformedDescription", loc, `a declared type of ${relation}.${column}`)
		}
	}

	/**
	 * What normalizing the schema's laws reads of it: its relations, each derived relation's definition and the types its
	 * columns are delivered at, the naming door's law identities, and the typing environment its predicates and terms
	 * lower in.
	 */
	env(): NormalizeEnv {
		return {
			relations: this.relations,
			definition: (relation) => this.definitions.get(relation),
			columnType: (relation, query, loc) => this.#columnType(relation, query, loc),
			named: lawIdentityOf,
			lowerEnv: {
				fieldType: this.fieldType,
				patterns: this.patterns,
				patternLanguage: textLookup,
				closed: this.closed
			}
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
			const r = this.relations.get(name)
			if (r?.kind === "relation") {
				normalizer.primaryKey(r, index)
			}
		}
		normalizer.families(this.checked.closure.statements.map((s) => s.statement))
		for (const { statement, index } of this.checked.closure.statements) {
			normalizer.statement(statement, index)
		}
		const contracts = Object.entries(this.owned.contracts).toSorted(([a], [b]) => compareText(a, b))
		for (const [index, [name, contract]] of contracts.entries()) {
			const uses = [...this.relations.values()].flatMap((r) =>
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
		const fill = fillOrder(families, laws)
		if (!fill.ok) {
			throw new Refusal(fill.error)
		}
		return Object.freeze({
			schema: this.owned.fingerprint,
			name: this.owned.name,
			relations: Object.freeze(Object.fromEntries(this.relations)),
			classes,
			laws,
			primaryKeys,
			dag,
			dependencies: this.#dependencies(laws),
			capabilities: this.#capabilities(laws),
			families,
			fill: fill.value
		})
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
			const law = { id: identifierOf(k.named), named: k.named, ...k.identity, loc: k.loc }
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
	 * The field-compatibility classes: every field of every relation, each containment's pairs, and each family's
	 * (Normalizer.familyPairings), so two fields one law compares are of one identity.
	 */
	#classes(
		kept: ReadonlyArray<KeptLaw>,
		families: ReturnType<Normalizer["familyPairings"]>
	): ReadonlyArray<FieldClass> {
		const classes = new FieldClasses()
		for (const r of this.relations.values()) {
			for (const c of r.fields) {
				classes.add(FieldId(r.name, c.name), c.type)
			}
		}
		/**
		 * The field `f` of `a` paired with the field `g` of `b`, each at its column's type, by a statement that refuses
		 * two of other identities for `refusal`, a rule the types name too.
		 */
		const pair = (
			a: string,
			f: HeadingColumn,
			b: string,
			g: HeadingColumn,
			loc: SourceLoc,
			refusal: Refused
		): void => {
			const problem = classes.union(
				{ field: FieldId(a, f.name), type: f.type },
				{ field: FieldId(b, g.name), type: g.type }
			)
			if (problem !== undefined) {
				throw new Refusal(refused(loc, refusal))
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
						refusal
					)
				}
			}
		}
		for (const p of families) {
			pair(p.a, p.f, p.b, p.g, p.loc, p.refusal)
		}
		return classes.classes()
	}

	#dependencies(laws: ReadonlyArray<TheoryLaw>): Readonly<Record<string, ReadonlyArray<string>>> {
		const deps = new Map<string, Set<string>>()
		for (const name of this.relations.keys()) {
			deps.set(name, new Set())
		}
		const reads = laws.flatMap((law) => {
			const read = [...new Set(law.reads)]
			return read.flatMap((r) =>
				read.filter((other) => other !== r).map((other) => [r, other] as const)
			)
		})
		for (const [reader, read] of reads) {
			defined(deps.get(reader), "a law reads a relation of the theory").add(read)
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
 * no theory checks a rule's query no installation's snapshot writes.
 */
export const ruleViolation = (
	checked: CheckedSchema,
	law: Pick<TheoryLaw, "named">,
	violation: InferredQuery
): Result.Result<{ readonly dag: ValidDag; readonly root: RelNode }, CompileError> =>
	Result.map(
		checkQuery(checked, violation, { read: "rows", label: `rule ${law.named.display}` }),
		(admitted) => ({
			dag: admitted.dag,
			root: admitted.dag.roots[0]
		})
	)

/**
 * The sides of an owned schema's laws, resolved as the theory resolves them (LawSides), in the environment its
 * normalization reads with `closed` the closed relations its lowerings apply, the violation queries' lowering batch:
 * what the violation queries' writer (laws/model/violations.ts) writes each law's violation query by, from what its
 * theory law carries.
 */
export const lawSides = (checked: CheckedSchema, closed: ClosedRelations): LawSides => {
	const env = new Builder(checked).env()
	return new LawSides({ ...env, lowerEnv: { ...env.lowerEnv, closed } })
}

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
					statement: law.source.kind === "alternatives" ? "alternatives" : "contained",
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
