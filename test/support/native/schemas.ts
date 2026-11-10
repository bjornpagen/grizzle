import { Array as Arr, Option, Record as Rec } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type {
	CompareOp,
	ExprDesc,
	FieldDesc,
	LiteralDesc,
	SideDesc,
	TermDesc
} from "#compiler/ir/desc.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { naturalDescriptor } from "#compiler/scalar/natural.ts"
import {
	type AuthoredStatementDesc,
	check,
	contained,
	f,
	key,
	mirrors,
	on,
	onWhere,
	pred,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { lawNamesOf } from "#test/support/kernel/naming.ts"
import {
	everyFact,
	type HostFact,
	type HostLaw,
	type HostRelation,
	type HostSchema,
	type HostSelection,
	type HostSide,
	type HostState,
	type HostValue,
	type Span
} from "#test/support/laws/model.ts"
import type { NativeRow, NativeState } from "#test/support/native/model.ts"

/**
 * The schemas the native-model suite draws, each stated twice from one description: as the SchemaDesc grizzle
 * compiles, and as the host law model's schema (test/support/laws/model.ts), whose laws are read from each
 * statement's meaning, never from the compiler. Sides are partial projections, `on(select(R, φ), t…)` the set
 * { (t…)(r) | r ∈ R, φ(r), every tᵢ(r) defined }, so a pred term pred(x), defined where x > 0, is the host field
 * `pred(x)` holding x − 1 under the side's selection conjoined with x > 0. A selection φ is a predicate tree evaluated
 * on the host by JavaScript's own comparisons, a third reading beside the engine's lowering and the reference
 * evaluator's.
 */

/** A field's type: a 32-bit integer, a natural (a bigint never below zero, the one type pred reads) or a boolean. */
export type FieldType = "int" | "natural" | "boolean" | "span"

/** A relation's fields in heading order, each with its type, and its primary key. */
export interface RelationSpec {
	readonly fields: ReadonlyArray<readonly [name: string, type: FieldType]>
	readonly key: NonEmptyReadonlyArray<string>
}

/** Relations by name, each with its fields and primary key. */
export type Relations = Readonly<Record<string, RelationSpec>>

/**
 * Owner and Item carry a natural field each, so every schema declares the natural contract; Profile and Seat are their
 * keys alone, so no write replaces a row at a referenced key and only a cycle defers a reference into them.
 */
export const RELATIONS: Relations = {
	Owner: {
		fields: [
			["id", "int"],
			["rank", "int"],
			["live", "boolean"],
			["slots", "natural"]
		],
		key: ["id"]
	},
	Item: {
		fields: [
			["id", "int"],
			["owner", "int"],
			["code", "int"],
			["live", "boolean"],
			["at", "natural"]
		],
		key: ["id"]
	},
	Profile: { fields: [["owner", "int"]], key: ["owner"] },
	Seat: { fields: [["owner", "int"]], key: ["owner"] }
}

/** A relation's spec; a relation the schema lacks is a defect of the suite. */
const specOf = (relations: Relations, relation: string): RelationSpec => {
	const spec = relations[relation]
	if (spec === undefined) {
		throw new Error(`the schema declares no relation ${relation}`)
	}
	return spec
}

/** A field's type in its relation; a field the relation lacks is a defect of the suite. */
const typeOf = (spec: RelationSpec, field: string): FieldType => {
	const found = Arr.findFirst(spec.fields, ([name]) => name === field)
	if (Option.isNone(found)) {
		throw new Error(`the relation has no field ${field}`)
	}
	return found.value[1]
}

/**
 * A row predicate, the selection language a side's select states: a field against a literal, written field first or,
 * as a description may state it, literal first; two fields of one type against each other, a boolean field's value,
 * BETWEEN and IN, and the connectives. Integers are small whole numbers, a bigint literal for a natural field and a
 * JavaScript integer for an int field, as each field's codec reads them.
 */
export type Phi =
	| {
			readonly kind: "compare"
			readonly op: CompareOp
			readonly field: string
			readonly value: number
	  }
	| {
			readonly kind: "literalFirst"
			readonly op: CompareOp
			readonly value: number
			readonly field: string
	  }
	| {
			readonly kind: "fields"
			readonly op: CompareOp
			readonly left: string
			readonly right: string
	  }
	| { readonly kind: "is"; readonly field: string; readonly value: boolean }
	| {
			readonly kind: "between"
			readonly field: string
			readonly low: number
			readonly high: number
	  }
	| { readonly kind: "in"; readonly field: string; readonly values: NonEmptyReadonlyArray<number> }
	| { readonly kind: "and" | "or"; readonly left: Phi; readonly right: Phi }
	| { readonly kind: "not"; readonly arg: Phi }

const SYMBOLS: Readonly<Record<CompareOp, string>> = {
	eq: "=",
	ne: "<>",
	lt: "<",
	le: "<=",
	gt: ">",
	ge: ">="
}

/** A selection as a person reads it, in the SQL the guard of its law column is. */
const phiText = (phi: Phi): string => {
	switch (phi.kind) {
		case "compare":
			return `${phi.field} ${SYMBOLS[phi.op]} ${phi.value}`
		case "literalFirst":
			return `${phi.value} ${SYMBOLS[phi.op]} ${phi.field}`
		case "fields":
			return `${phi.left} ${SYMBOLS[phi.op]} ${phi.right}`
		case "is":
			return `${phi.field} = ${String(phi.value)}`
		case "between":
			return `${phi.field} BETWEEN ${phi.low} AND ${phi.high}`
		case "in":
			return `${phi.field} IN (${Arr.join(Arr.map(phi.values, String), ", ")})`
		case "and":
		case "or":
			return `(${phiText(phi.left)} ${phi.kind === "and" ? "AND" : "OR"} ${phiText(phi.right)})`
		case "not":
			return `NOT ${phiText(phi.arg)}`
	}
}

/** The fields a selection reads. */
export const phiFields = (phi: Phi): ReadonlyArray<string> => {
	switch (phi.kind) {
		case "compare":
		case "literalFirst":
		case "is":
		case "between":
		case "in":
			return [phi.field]
		case "fields":
			return [phi.left, phi.right]
		case "and":
		case "or":
			return Arr.dedupe([...phiFields(phi.left), ...phiFields(phi.right)])
		case "not":
			return phiFields(phi.arg)
	}
}

const compared = (op: CompareOp, a: number, b: number): boolean => {
	switch (op) {
		case "eq":
			return a === b
		case "ne":
			return a !== b
		case "lt":
			return a < b
		case "le":
			return a <= b
		case "gt":
			return a > b
		case "ge":
			return a >= b
	}
}

const numberAt = (fact: HostFact, field: string): number => {
	const v = fact[field]
	if (typeof v !== "number") {
		throw new Error(`the selection reads ${field} as a number`)
	}
	return v
}

/** Whether a selection holds of a fact: the host's reading, by JavaScript's comparisons. */
export const phiHolds = (phi: Phi, fact: HostFact): boolean => {
	switch (phi.kind) {
		case "compare":
			return compared(phi.op, numberAt(fact, phi.field), phi.value)
		case "literalFirst":
			return compared(phi.op, phi.value, numberAt(fact, phi.field))
		case "fields":
			return compared(phi.op, numberAt(fact, phi.left), numberAt(fact, phi.right))
		case "is":
			return fact[phi.field] === phi.value
		case "between": {
			const v = numberAt(fact, phi.field)
			return phi.low <= v && v <= phi.high
		}
		case "in":
			return phi.values.includes(numberAt(fact, phi.field))
		case "and":
			return phiHolds(phi.left, fact) && phiHolds(phi.right, fact)
		case "or":
			return phiHolds(phi.left, fact) || phiHolds(phi.right, fact)
		case "not":
			return !phiHolds(phi.arg, fact)
	}
}

/** An integer literal as the field's codec reads it: a bigint for a natural, a JavaScript integer for an int. */
const integerLiteral = (spec: RelationSpec, field: string, value: number): LiteralDesc =>
	typeOf(spec, field) === "natural" ? BigInt(value) : value

const literalDesc = (value: LiteralDesc): ExprDesc => ({ kind: "literal", value })

const fieldDesc = (field: string): ExprDesc => ({ kind: "field", field })

/** A selection as the schema description states it, over `relation`'s fields. */
const phiDesc = (spec: RelationSpec, phi: Phi): ExprDesc => {
	switch (phi.kind) {
		case "compare":
			return {
				kind: "compare",
				op: phi.op,
				left: fieldDesc(phi.field),
				right: literalDesc(integerLiteral(spec, phi.field, phi.value))
			}
		case "literalFirst":
			return {
				kind: "compare",
				op: phi.op,
				left: literalDesc(integerLiteral(spec, phi.field, phi.value)),
				right: fieldDesc(phi.field)
			}
		case "fields":
			return { kind: "compare", op: phi.op, left: fieldDesc(phi.left), right: fieldDesc(phi.right) }
		case "is":
			return {
				kind: "compare",
				op: "eq",
				left: fieldDesc(phi.field),
				right: literalDesc(phi.value)
			}
		case "between":
			return {
				kind: "between",
				arg: fieldDesc(phi.field),
				low: literalDesc(integerLiteral(spec, phi.field, phi.low)),
				high: literalDesc(integerLiteral(spec, phi.field, phi.high))
			}
		case "in":
			return {
				kind: "in",
				arg: fieldDesc(phi.field),
				values: Arr.map(phi.values, (v) => integerLiteral(spec, phi.field, v))
			}
		case "and":
		case "or":
			return { kind: phi.kind, args: [phiDesc(spec, phi.left), phiDesc(spec, phi.right)] }
		case "not":
			return { kind: "not", arg: phiDesc(spec, phi.arg) }
	}
}

/** A side's term: a field, or pred of a natural field. */
export type Term =
	| { readonly kind: "field"; readonly field: string }
	| { readonly kind: "pred"; readonly field: string }

export const fieldTerm = (name: string): Term => ({ kind: "field", field: name })
export const predTerm = (name: string): Term => ({ kind: "pred", field: name })

/** The host field a pred term reads: x − 1, which the side reads only where x > 0. */
const predField = (name: string): string => `pred(${name})`

/** A side as both readings take it: its relation, its terms and its selection, if it has one. */
export interface Side {
	readonly relation: string
	readonly terms: NonEmptyReadonlyArray<Term>
	readonly where: Option.Option<Phi>
}

/** The side over every row of `relation`. */
export const over = (relation: string, terms: NonEmptyReadonlyArray<Term>): Side => ({
	relation,
	terms,
	where: Option.none()
})

/** The side over the rows of `relation` that `phi` holds of. */
export const overWhere = (
	relation: string,
	terms: NonEmptyReadonlyArray<Term>,
	phi: Phi
): Side => ({
	relation,
	terms,
	where: Option.some(phi)
})

/** A law statement as both readings take it; mirrors is sugar for its two containments, left into right first. */
export type Law =
	| { readonly kind: "key"; readonly side: Side }
	| { readonly kind: "contained"; readonly left: Side; readonly right: Side }
	| { readonly kind: "mirrors"; readonly left: Side; readonly right: Side }
	| {
			readonly kind: "check"
			readonly name: string
			readonly relation: string
			readonly phi: Phi
	  }

/** Each comparison's mirror: the operator that holds of the same two operands written the other way round. */
export const MIRROR: Readonly<Record<CompareOp, CompareOp>> = {
	eq: "eq",
	ne: "ne",
	lt: "gt",
	le: "ge",
	gt: "lt",
	ge: "le"
}

const sortedTexts = (texts: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.sort(texts, (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0))

const setText = (texts: ReadonlyArray<string>): string =>
	Arr.join(sortedTexts(Arr.dedupe(texts)), ", ")

/** Two fields compared, read in the canonical orientation: by eq or ne unordered, an ordering as < or <=. */
const fieldsForm = (op: CompareOp, left: string, right: string): string => {
	switch (op) {
		case "eq":
		case "ne":
			return `(${Arr.join(sortedTexts([left, right]), ` ${SYMBOLS[op]} `)})`
		case "lt":
		case "le":
			return `(${left} ${SYMBOLS[op]} ${right})`
		case "gt":
		case "ge":
			return `(${right} ${SYMBOLS[MIRROR[op]]} ${left})`
	}
}

/**
 * A predicate as ownership's canonical form reads it: a conjunction's and a disjunction's operands unordered, nested
 * ones kept; a field and a literal read field first; two fields read by fieldsForm; an IN list the set of its values.
 */
const phiForm = (phi: Phi): string => {
	switch (phi.kind) {
		case "compare":
			return `(${phi.field} ${SYMBOLS[phi.op]} ${phi.value})`
		case "literalFirst":
			return `(${phi.field} ${SYMBOLS[MIRROR[phi.op]]} ${phi.value})`
		case "fields":
			return fieldsForm(phi.op, phi.left, phi.right)
		case "is":
			return `(${phi.field} is ${String(phi.value)})`
		case "between":
			return `(${phi.field} between ${phi.low} and ${phi.high})`
		case "in":
			return `(${phi.field} in [${setText(Arr.map(phi.values, String))}])`
		case "and":
		case "or":
			return `${phi.kind}(${Arr.join(sortedTexts([phiForm(phi.left), phiForm(phi.right)]), ", ")})`
		case "not":
			return `not ${phiForm(phi.arg)}`
	}
}

/** A selection's conjuncts, through every nested conjunction at its top. */
const topConjuncts = (phi: Phi): ReadonlyArray<Phi> =>
	phi.kind === "and" ? [...topConjuncts(phi.left), ...topConjuncts(phi.right)] : [phi]

/**
 * A side as the canonical form reads it: its relation, its terms in order, and its selection the set of its conjuncts.
 */
const sideForm = (s: Side): string =>
	`${s.relation}(${Arr.join(
		Arr.map(s.terms, (t) => (t.kind === "field" ? t.field : `pred(${t.field})`)),
		", "
	)})${Option.match(s.where, {
		onNone: () => "",
		onSome: (phi) => ` where {${setText(Arr.map(topConjuncts(phi), phiForm))}}`
	})}`

/**
 * Each statement a law states, read in ownership's canonical form, in the order Reading states them: a key by its
 * side, a containment by its two sides, a mirrors as its two containments, and a check by its relation and name, which
 * its law is named by. Two statements are one law exactly when their forms are one text.
 */
export const lawForms = (law: Law): NonEmptyReadonlyArray<string> => {
	switch (law.kind) {
		case "key":
			return [`key ${sideForm(law.side)}`]
		case "contained":
			return [`${sideForm(law.left)} in ${sideForm(law.right)}`]
		case "mirrors":
			return [
				`${sideForm(law.left)} in ${sideForm(law.right)}`,
				`${sideForm(law.right)} in ${sideForm(law.left)}`
			]
		case "check":
			return [`check ${law.name} of ${law.relation}`]
	}
}

/** The selections a law's sides and checks state. */
export const lawSelections = (law: Law): ReadonlyArray<Phi> => {
	switch (law.kind) {
		case "key":
			return Option.toArray(law.side.where)
		case "contained":
		case "mirrors":
			return [...Option.toArray(law.left.where), ...Option.toArray(law.right.where)]
		case "check":
			return [law.phi]
	}
}

/** Whether a selection holds a comparison: a field against a literal, either way round, or two fields. */
export const holdsComparison = (phi: Phi): boolean => {
	switch (phi.kind) {
		case "compare":
		case "literalFirst":
		case "fields":
			return true
		case "is":
		case "between":
		case "in":
			return false
		case "and":
		case "or":
			return holdsComparison(phi.left) || holdsComparison(phi.right)
		case "not":
			return holdsComparison(phi.arg)
	}
}

/** A field descriptor of a type: natural is the builtin contract over bigint. */
const descriptorOf = (type: FieldType): FieldDesc => {
	switch (type) {
		case "int":
			return f.integer
		case "natural":
			return naturalDescriptor.desc
		case "boolean":
			return f.boolean
		case "span":
			return f.span(f.integer, undefined)
	}
}

/** The name the natural contract is declared under, which its domain's law is named by. */
const naturalName = (): string => {
	const desc = naturalDescriptor.desc
	if (desc.kind !== "contract") {
		throw new Error("natural is a contract")
	}
	return desc.name
}

const termDesc = (t: Term): string | TermDesc => (t.kind === "field" ? t.field : pred(t.field))

/** A schema's statements and their meaning, over its relations. */
class Reading {
	readonly #relations: Relations

	constructor(relations: Relations) {
		this.#relations = relations
	}

	side(s: Side): SideDesc {
		const terms = Arr.map(s.terms, termDesc)
		return Option.match(s.where, {
			onNone: () => on(s.relation, terms),
			onSome: (phi) => onWhere(s.relation, terms, phiDesc(specOf(this.#relations, s.relation), phi))
		})
	}

	statements(law: Law): ReadonlyArray<AuthoredStatementDesc> {
		switch (law.kind) {
			case "key":
				return [key(this.side(law.side))]
			case "contained":
				return [contained(this.side(law.left), this.side(law.right))]
			case "mirrors":
				return mirrors(this.side(law.left), this.side(law.right))
			case "check":
				return [
					check(law.name, law.relation, phiDesc(specOf(this.#relations, law.relation), law.phi))
				]
		}
	}
}

/**
 * A host side: its fields, a pred term as its host field, and its selection conjoined with x > 0 for each pred(x),
 * where pred(x) is defined.
 */
const hostSide = (s: Side): HostSide => {
	const preds = Arr.flatMap(s.terms, (t) => (t.kind === "pred" ? [t.field] : []))
	const phi = Option.getOrUndefined(s.where)
	const selection: HostSelection =
		phi === undefined && preds.length === 0
			? everyFact
			: {
					kind: "where",
					holds: (fact) =>
						(phi === undefined || phiHolds(phi, fact)) &&
						Arr.every(preds, (x) => numberAt(fact, x) > 0),
					pinned: {}
				}
	return {
		relation: s.relation,
		fields: Arr.map(s.terms, (t) => (t.kind === "field" ? t.field : predField(t.field))),
		selection
	}
}

/** A compiled schema: its relations, its description, the host's reading of its laws, and grizzle's law model. */
export interface Compiled {
	readonly relations: Relations
	readonly desc: SchemaDesc
	readonly host: HostSchema
	readonly model: LawModel
	/** Each law given, in order, as the laws the compiler gives its statements: mirrors names two. */
	readonly statementLaws: ReadonlyArray<ReadonlyArray<LawId>>
	/** The law a relation's primary key reports. */
	readonly primaryKey: (relation: string) => LawId
	/**
	 * A state as the host law model reads it, with each view a selected span key reads: the rows of its relation its
	 * selection holds of, the side a span key over them keys.
	 */
	readonly hostStateOf: (state: State) => HostState
}

/** The rows of a relation a selection holds of, as a host relation of their own, which a selected span key reads. */
interface View {
	readonly name: string
	readonly relation: string
	readonly phi: Phi
}

/** A side's scalars and span, when its last term is a span field: the side of a span key or a coverage. */
const spanOf = (
	relations: Relations,
	side: Side
): Option.Option<{ readonly scalars: ReadonlyArray<string>; readonly span: string }> => {
	const last = Arr.lastNonEmpty(side.terms)
	return last.kind === "field" && typeOf(specOf(relations, side.relation), last.field) === "span"
		? Option.some({
				scalars: Arr.map(side.terms.slice(0, -1), (t) => t.field),
				span: last.field
			})
		: Option.none()
}

/**
 * The schema of `laws` over `relations`, and both readings of it: the description grizzle compiles, and the host law
 * model's laws, each named by the law the compiler gives its statement. Every relation's primary key is a law, and so
 * is the natural contract wherever a natural field holds a value.
 */
export const compiled = (relations: Relations, laws: ReadonlyArray<Law>): Compiled => {
	const reading = new Reading(relations)
	const names = Rec.keys(relations)
	const desc: SchemaDesc = {
		name: "Natives",
		relations: Arr.map(names, (name) => {
			const spec = specOf(relations, name)
			return relation(
				name,
				Rec.fromEntries(
					Arr.map(spec.fields, ([fieldName, type]) => [fieldName, descriptorOf(type)])
				),
				spec.key
			)
		}),
		statements: Arr.flatMap(laws, (law) => reading.statements(law)),
		extends: undefined
	}
	const lawNames = lawNamesOf(desc)
	const lawOf = (statement: AuthoredStatementDesc): LawId => lawNames.lawOfDesc(statement)
	const usesNatural = Arr.some(names, (name) =>
		Arr.some(specOf(relations, name).fields, ([, type]) => type === "natural")
	)
	const views: Array<View> = []
	/** A span side read by a span key: its relation, or, selected, the view of the rows it selects. */
	const spanRelation = (side: Side): string =>
		Option.match(side.where, {
			onNone: () => side.relation,
			onSome: (phi) => {
				const name = `${side.relation} where ${phiText(phi)}`
				if (!Arr.some(views, (v) => v.name === name)) {
					views.push({ name, relation: side.relation, phi })
				}
				return name
			}
		})
	const hostLaws = (law: Law): ReadonlyArray<HostLaw> => {
		const statements = reading.statements(law)
		switch (law.kind) {
			case "key": {
				const span = spanOf(relations, law.side)
				if (Option.isSome(span)) {
					const relation = spanRelation(law.side)
					return Arr.map(statements, (statement): HostLaw => ({
						kind: "spanKey",
						law: lawOf(statement),
						relation,
						scalars: span.value.scalars,
						span: span.value.span,
						selection: everyFact
					}))
				}
				const side = hostSide(law.side)
				return Arr.map(statements, (statement): HostLaw => ({
					kind: "key",
					law: lawOf(statement),
					relation: side.relation,
					fields: side.fields,
					selection: side.selection
				}))
			}
			case "contained":
			case "mirrors": {
				const pairs: ReadonlyArray<readonly [Side, Side]> =
					law.kind === "contained"
						? [[law.left, law.right]]
						: [
								[law.left, law.right],
								[law.right, law.left]
							]
				return Arr.map(Arr.zip(pairs, statements), ([[from, to], statement]): HostLaw => {
					const [source, target] = [spanOf(relations, from), spanOf(relations, to)]
					return Option.isSome(source) && Option.isSome(target)
						? {
								kind: "covered",
								law: lawOf(statement),
								source: { ...hostSide(from), fields: source.value.scalars },
								target: { ...hostSide(to), fields: target.value.scalars },
								span: { source: source.value.span, target: target.value.span }
							}
						: {
								kind: "contained",
								law: lawOf(statement),
								source: hostSide(from),
								target: hostSide(to)
							}
				})
			}
			case "check": {
				const phi = law.phi
				return Arr.map(statements, (statement): HostLaw => ({
					kind: "check",
					law: lawOf(statement),
					relation: law.relation,
					holds: (fact) => phiHolds(phi, fact)
				}))
			}
		}
	}
	const keys = Arr.map(names, (name): HostLaw => ({
		kind: "key",
		law: lawNames.primaryKeyLaw({ name }),
		relation: name,
		fields: specOf(relations, name).key,
		selection: everyFact
	}))
	const natural = usesNatural ? Option.some(lawNames.contract(naturalName()).law) : Option.none()
	const naturals = Arr.flatMap(names, (name) =>
		Arr.flatMap(specOf(relations, name).fields, ([fieldName, type]): ReadonlyArray<HostLaw> =>
			type === "natural" && Option.isSome(natural)
				? [
						{
							kind: "check",
							law: natural.value,
							relation: name,
							holds: (fact) => numberAt(fact, fieldName) >= 0
						}
					]
				: []
		)
	)
	const lawsRead = [...keys, ...naturals, ...Arr.flatMap(laws, hostLaws)]
	const hostRelation = (name: string, of: string, key: ReadonlyArray<string>): HostRelation => ({
		name,
		table: name,
		fields: Arr.map(specOf(relations, of).fields, ([fieldName]) => ({
			name: fieldName,
			column: fieldName
		})),
		key,
		mutable: false
	})
	return {
		relations,
		desc,
		host: {
			relations: [
				...Arr.map(names, (name) => hostRelation(name, name, specOf(relations, name).key)),
				...Arr.map(views, (v) => hostRelation(v.name, v.relation, []))
			],
			laws: lawsRead
		},
		hostStateOf: (state) => {
			const base = hostState(relations, state)
			return new Map([
				...base,
				...Arr.map(
					views,
					(v) =>
						[
							v.name,
							Arr.filter(base.get(v.relation) ?? [], (fact) => phiHolds(v.phi, fact))
						] as const
				)
			])
		},
		model: lawNames.model,
		statementLaws: Arr.map(laws, (law) => Arr.map(reading.statements(law), lawOf)),
		primaryKey: (name) => lawNames.primaryKeyLaw({ name })
	}
}

/** A field's value as the suite writes it: a whole number, a boolean, or a span, half-open from start to end. */
export type Value = number | boolean | Span

/** A stored row as the suite writes it: each field's value. */
export type Row = Readonly<Record<string, Value>>

/** A state as the suite draws it: each relation's rows, a relation it does not name holding none. */
export type State = Readonly<Record<string, ReadonlyArray<Row>>>

const valueAt = (row: Row, fieldName: string): Value => {
	const v = row[fieldName]
	if (v === undefined) {
		throw new Error(`a row without its field ${fieldName}`)
	}
	return v
}

/** A row as the host reads it: its fields, and pred(x) = x − 1 for each natural field x. */
const hostFact = (spec: RelationSpec, row: Row): HostFact => {
	const fact: Record<string, HostValue> = {}
	for (const [fieldName, type] of spec.fields) {
		const v = valueAt(row, fieldName)
		fact[fieldName] = v
		if (type === "natural" && typeof v === "number") {
			fact[predField(fieldName)] = v - 1
		}
	}
	return fact
}

const rowsOf = (state: State, name: string): ReadonlyArray<Row> => state[name] ?? []

/** A state as the host law model reads it. */
const hostState = (relations: Relations, state: State): HostState =>
	new Map(
		Arr.map(Rec.keys(relations), (name) => [
			name,
			Arr.map(rowsOf(state, name), (row) => hostFact(specOf(relations, name), row))
		])
	)

/** A value as PostgreSQL's carrier: an integer as a bigint, a span as its bigint endpoints, a boolean as itself. */
const carrierOf = (v: Value): CarrierValue =>
	typeof v === "number"
		? BigInt(v)
		: typeof v === "boolean"
			? v
			: { start: BigInt(v.start), end: BigInt(v.end) }

/** A row as PostgreSQL stores it. */
export const nativeRow = (spec: RelationSpec, row: Row): NativeRow =>
	new Map(
		Arr.map(spec.fields, ([fieldName]) => [fieldName, carrierOf(valueAt(row, fieldName))] as const)
	)

/** A state as the native model reads it. */
export const nativeState = (relations: Relations, state: State): NativeState =>
	new Map(
		Arr.map(Rec.keys(relations), (name) => [
			name,
			Arr.map(rowsOf(state, name), (row) => nativeRow(specOf(relations, name), row))
		])
	)

/**
 * One rule of the partial-projection lowering, as the statements over the four relations that exercise it, with the
 * selections it reads: φ selects Item, ψ selects Owner.
 */
export type Rule =
	| { readonly rule: "a key over fields" }
	| { readonly rule: "a key over a selected side"; readonly phi: Phi }
	| { readonly rule: "a key over a pred term" }
	| { readonly rule: "a key over a selected pred term"; readonly phi: Phi }
	| { readonly rule: "a containment" }
	| { readonly rule: "a containment into a superkey" }
	| { readonly rule: "a containment from a selected side"; readonly phi: Phi }
	| { readonly rule: "a containment into a selected side"; readonly psi: Phi }
	| { readonly rule: "a containment between selected sides"; readonly phi: Phi; readonly psi: Phi }
	| { readonly rule: "a closure under pred" }
	| { readonly rule: "a closure under pred over a selected side"; readonly phi: Phi }
	| { readonly rule: "a cycle" }
	| { readonly rule: "mirrors over whole relations" }
	| { readonly rule: "mirrors over a selected side"; readonly phi: Phi }
	| { readonly rule: "a row check"; readonly phi: Phi }
	| { readonly rule: "natural fields" }

export type RuleKind = Rule["rule"]

export const RULE_KINDS: NonEmptyReadonlyArray<RuleKind> = [
	"a key over fields",
	"a key over a selected side",
	"a key over a pred term",
	"a key over a selected pred term",
	"a containment",
	"a containment into a superkey",
	"a containment from a selected side",
	"a containment into a selected side",
	"a containment between selected sides",
	"a closure under pred",
	"a closure under pred over a selected side",
	"a cycle",
	"mirrors over whole relations",
	"mirrors over a selected side",
	"a row check",
	"natural fields"
]

/** A rule as a person reads it: its kind and its selections. */
export const ruleText = (r: Rule): string => {
	switch (r.rule) {
		case "a key over a selected side":
		case "a key over a selected pred term":
		case "a containment from a selected side":
		case "a closure under pred over a selected side":
		case "mirrors over a selected side":
		case "a row check":
			return `${r.rule} where ${phiText(r.phi)}`
		case "a containment into a selected side":
			return `${r.rule} where ${phiText(r.psi)}`
		case "a containment between selected sides":
			return `${r.rule} where ${phiText(r.phi)} and ${phiText(r.psi)}`
		case "a key over fields":
		case "a key over a pred term":
		case "a containment":
		case "a containment into a superkey":
		case "a closure under pred":
		case "a cycle":
		case "mirrors over whole relations":
		case "natural fields":
			return r.rule
	}
}

const owner = fieldTerm("owner")
const id = fieldTerm("id")

/** The statements a rule states over the four relations. */
export const lawsOf = (r: Rule): ReadonlyArray<Law> => {
	switch (r.rule) {
		case "a key over fields":
			return [{ kind: "key", side: over("Item", [owner, fieldTerm("code")]) }]
		case "a key over a selected side":
			return [{ kind: "key", side: overWhere("Item", [owner, fieldTerm("code")], r.phi) }]
		case "a key over a pred term":
			return [{ kind: "key", side: over("Item", [owner, predTerm("at")]) }]
		case "a key over a selected pred term":
			return [{ kind: "key", side: overWhere("Item", [owner, predTerm("at")], r.phi) }]
		case "a containment":
			return [{ kind: "contained", left: over("Item", [owner]), right: over("Owner", [id]) }]
		case "a containment into a superkey":
			return [
				{
					kind: "contained",
					left: over("Item", [owner, fieldTerm("code")]),
					right: over("Owner", [id, fieldTerm("rank")])
				}
			]
		case "a containment from a selected side":
			return [
				{ kind: "contained", left: overWhere("Item", [owner], r.phi), right: over("Owner", [id]) }
			]
		case "a containment into a selected side":
			return [
				{ kind: "contained", left: over("Item", [owner]), right: overWhere("Owner", [id], r.psi) }
			]
		case "a containment between selected sides":
			return [
				{
					kind: "contained",
					left: overWhere("Item", [owner], r.phi),
					right: overWhere("Owner", [id], r.psi)
				}
			]
		case "a closure under pred":
			return [
				{ kind: "key", side: over("Item", [owner, fieldTerm("at")]) },
				{
					kind: "contained",
					left: over("Item", [owner, predTerm("at")]),
					right: over("Item", [owner, fieldTerm("at")])
				}
			]
		case "a closure under pred over a selected side":
			return [
				{ kind: "key", side: over("Item", [owner, fieldTerm("at")]) },
				{
					kind: "contained",
					left: overWhere("Item", [owner, predTerm("at")], r.phi),
					right: over("Item", [owner, fieldTerm("at")])
				}
			]
		case "a cycle":
			return [
				{ kind: "contained", left: over("Profile", [owner]), right: over("Seat", [owner]) },
				{ kind: "contained", left: over("Seat", [owner]), right: over("Profile", [owner]) }
			]
		case "mirrors over whole relations":
			return [{ kind: "mirrors", left: over("Owner", [id]), right: over("Profile", [owner]) }]
		case "mirrors over a selected side":
			return [
				{ kind: "mirrors", left: overWhere("Item", [id], r.phi), right: over("Profile", [owner]) }
			]
		case "a row check":
			return [{ kind: "check", name: "ruled", relation: "Item", phi: r.phi }]
		case "natural fields":
			return []
	}
}

/** The relations of the span rules: visits and the shifts they are covered by, each keyed by its id. */
export const SPAN_RELATIONS: Relations = {
	Visit: {
		fields: [
			["id", "int"],
			["owner", "int"],
			["during", "span"],
			["live", "boolean"]
		],
		key: ["id"]
	},
	Shift: {
		fields: [
			["id", "int"],
			["owner", "int"],
			["during", "span"],
			["live", "boolean"]
		],
		key: ["id"]
	}
}

/**
 * A rule of the span lowering over Visit and Shift: a span key, which a key whose last term is a span is, WITHOUT
 * OVERLAPS, over every row or over the law columns of a selected side; and a coverage, a containment of a span side
 * into a span-keyed one, a PERIOD foreign key, from or into a selected side.
 */
export type SpanRule =
	| { readonly rule: "a span key" }
	| { readonly rule: "a span key over a selected side"; readonly phi: Phi }
	| { readonly rule: "a coverage" }
	| { readonly rule: "a coverage from a selected side"; readonly phi: Phi }
	| { readonly rule: "a coverage into a selected side"; readonly phi: Phi }

export type SpanRuleKind = SpanRule["rule"]

export const SPAN_RULE_KINDS: NonEmptyReadonlyArray<SpanRuleKind> = [
	"a span key",
	"a span key over a selected side",
	"a coverage",
	"a coverage from a selected side",
	"a coverage into a selected side"
]

export const spanRuleText = (r: SpanRule): string => {
	switch (r.rule) {
		case "a span key":
		case "a coverage":
			return r.rule
		case "a span key over a selected side":
		case "a coverage from a selected side":
		case "a coverage into a selected side":
			return `${r.rule} where ${phiText(r.phi)}`
	}
}

const during = [owner, fieldTerm("during")] as const

/** The statements a span rule states over Visit and Shift. */
export const spanLawsOf = (r: SpanRule): ReadonlyArray<Law> => {
	const keyed: Law = { kind: "key", side: over("Shift", during) }
	switch (r.rule) {
		case "a span key":
			return [{ kind: "key", side: over("Visit", during) }]
		case "a span key over a selected side":
			return [{ kind: "key", side: overWhere("Visit", during, r.phi) }]
		case "a coverage":
			return [
				keyed,
				{ kind: "contained", left: over("Visit", during), right: over("Shift", during) }
			]
		case "a coverage from a selected side":
			return [
				keyed,
				{ kind: "contained", left: overWhere("Visit", during, r.phi), right: over("Shift", during) }
			]
		case "a coverage into a selected side":
			return [
				{ kind: "key", side: overWhere("Shift", during, r.phi) },
				{ kind: "contained", left: over("Visit", during), right: overWhere("Shift", during, r.phi) }
			]
	}
}
