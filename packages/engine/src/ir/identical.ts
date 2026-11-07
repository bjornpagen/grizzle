import { sameOrder } from "#compiler/core/array.ts"
import type { DecimalParts } from "#compiler/core/decimal.ts"
import type { ExprTable, PatternEntry, TableExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import type {
	Exact,
	FactSource,
	NativeProof,
	OperandPremise,
	OperationProof,
	Precondition,
	PreconditionProof
} from "#compiler/ir/proof.ts"
import {
	type ContractInfo,
	contractOf,
	exactDigitsOf,
	type NumericBound,
	numericBoundOf,
	type NumericTypmod,
	numericTypmodOf,
	type PatternCheck,
	type RegexCheck,
	type RegexRef,
	type Roster,
	rosterOf,
	type ScalarType,
	spanOf,
	type TextBounds,
	type TextInfo,
	textOf,
	type VectorTypmod,
	vectorTypmodOf
} from "#compiler/ir/scalar.ts"

/** Both absent, or both present and identical. */
const both = <A>(a: A | undefined, b: A | undefined, same: (x: A, y: A) => boolean): boolean =>
	a === undefined || b === undefined ? a === b : same(a, b)

/** One length, and identical position by position. */
const each = <A>(
	a: ReadonlyArray<A>,
	b: ReadonlyArray<A>,
	same: (x: A, y: A) => boolean
): boolean =>
	a === b ||
	(a.length === b.length &&
		a.every((x, i) => {
			const y = b[i]
			return y !== undefined && same(x, y)
		}))

const identicalBounds = (a: TextBounds, b: TextBounds): boolean =>
	a.length === b.length && a.bytes === b.bytes

const identicalPatternCheck = (a: PatternCheck, b: PatternCheck): boolean => {
	switch (a.kind) {
		case "finite":
			return (
				b.kind === "finite" &&
				sameOrder(a.members, b.members) &&
				identicalBounds(a.bounds, b.bounds)
			)
		case "regex":
			return (
				b.kind === "regex" && a.pattern === b.pattern && both(a.bounds, b.bounds, identicalBounds)
			)
	}
}

const identicalRegexCheck = (a: RegexCheck, b: RegexCheck): boolean => {
	if (a.kind !== "octets" || b.kind !== "octets") {
		return a.kind !== "octets" && b.kind !== "octets" && identicalPatternCheck(a, b)
	}
	return (
		a.octets === b.octets &&
		identicalBounds(a.bounds, b.bounds) &&
		both(a.check, b.check, identicalPatternCheck)
	)
}

const identicalRegex = (a: RegexRef | "wildcard", b: RegexRef | "wildcard"): boolean =>
	a === "wildcard" || b === "wildcard"
		? a === b
		: a.source === b.source &&
			a.flags === b.flags &&
			a.key === b.key &&
			identicalRegexCheck(a.check, b.check)

/** A text descriptor's regex metadata: its pattern, its language's key and enforcement, and its proved bounds. */
export const identicalText = (a: TextInfo, b: TextInfo): boolean =>
	identicalRegex(a.regex, b.regex) && a.lengthBound === b.lengthBound && a.byteBound === b.byteBound

/** A roster: its closed relation and its handles in code order, by their digest, as its canonical form states them. */
export const identicalRoster = (a: Roster, b: Roster): boolean =>
	a.closed === b.closed && a.digest === b.digest

/** A span's endpoint type and its fixed width, none for a span of no fixed width. */
export const identicalSpan = (
	a: { readonly endpoint: ScalarType; readonly width: bigint | undefined },
	b: { readonly endpoint: ScalarType; readonly width: bigint | undefined }
): boolean => a.width === b.width && identicalScalarType(a.endpoint, b.endpoint)

const identicalNumericTypmod = (a: NumericTypmod, b: NumericTypmod): boolean =>
	a.precision === b.precision && a.scale === b.scale

const identicalVectorTypmod = (a: VectorTypmod, b: VectorTypmod): boolean => a.dims === b.dims

const identicalNumericBound = (a: NumericBound, b: NumericBound): boolean =>
	a.digits === b.digits && a.scale === b.scale

const identicalContract = (a: ContractInfo, b: ContractInfo): boolean =>
	a.name === b.name &&
	identicalScalarType(a.base, b.base) &&
	both(a.predicate, b.predicate, identicalExprTable) &&
	sameOrder(a.facts, b.facts)

/**
 * Structural identity of two descriptors: identical exactly when every field of each is, the equality their canonical
 * text states without building the text. One carrier, each field read through its carrier's total accessor, so a
 * variant's fields are exactly the ones compared: capabilities, contract, numeric typmod or computed bound, vector
 * dimensions, exact digit bound, text, roster and span. A contract is compared whole, its predicate and facts
 * included, where type identity (ir/scalar.ts sameScalarType) compares it by name and base alone.
 */
export const identicalScalarType = (a: ScalarType, b: ScalarType): boolean =>
	a === b ||
	(a.carrier === b.carrier &&
		sameOrder(a.caps, b.caps) &&
		both(contractOf(a), contractOf(b), identicalContract) &&
		both(numericTypmodOf(a), numericTypmodOf(b), identicalNumericTypmod) &&
		both(numericBoundOf(a), numericBoundOf(b), identicalNumericBound) &&
		both(vectorTypmodOf(a), vectorTypmodOf(b), identicalVectorTypmod) &&
		exactDigitsOf(a) === exactDigitsOf(b) &&
		both(textOf(a), textOf(b), identicalText) &&
		both(rosterOf(a), rosterOf(b), identicalRoster) &&
		both(spanOf(a), spanOf(b), identicalSpan))

const identicalParts = (a: DecimalParts, b: DecimalParts): boolean =>
	a.kind === "finite" && b.kind === "finite"
		? a.negative === b.negative && a.coefficient === b.coefficient && a.minScale === b.minScale
		: a.kind === b.kind

const identicalLiteral = (a: TypedLiteral, b: TypedLiteral): boolean => {
	switch (a.kind) {
		case "int":
			return b.kind === "int" && a.value === b.value
		case "numeric":
			return b.kind === "numeric" && identicalParts(a.value.parts, b.value.parts)
		case "float":
			return b.kind === "float" && a.value === b.value
		case "floatSpecial":
			return b.kind === "floatSpecial" && a.value === b.value
		case "money":
			return b.kind === "money" && a.value.minorUnits === b.value.minorUnits
		case "bool":
			return b.kind === "bool" && a.value === b.value
		case "text":
			return b.kind === "text" && a.value === b.value
		case "uuid":
			return b.kind === "uuid" && a.value === b.value
		case "date":
			return b.kind === "date" && a.value === b.value
		case "handle":
			return b.kind === "handle" && a.handle === b.handle
		case "handles":
			return b.kind === "handles" && sameOrder(a.handles, b.handles)
		case "span":
			return b.kind === "span" && a.start === b.start && a.end === b.end
		case "vector":
			return b.kind === "vector" && sameOrder(a.value.components, b.value.components)
	}
}

const identicalExact = (a: Exact, b: Exact): boolean => a.units === b.units && a.scale === b.scale

const identicalSource = (a: FactSource, b: FactSource): boolean =>
	a.kind === "contract" || b.kind === "contract"
		? a.kind === "contract" && b.kind === "contract" && a.name === b.name
		: a.kind === b.kind

const identicalPremise = (a: OperandPremise, b: OperandPremise): boolean => {
	switch (a.kind) {
		case "fact":
			return (
				b.kind === "fact" &&
				a.operand === b.operand &&
				a.fact === b.fact &&
				identicalSource(a.source, b.source)
			)
		case "interval":
			return (
				b.kind === "interval" &&
				a.operand === b.operand &&
				identicalExact(a.low, b.low) &&
				identicalExact(a.high, b.high) &&
				a.nan === b.nan
			)
		case "checked":
			return b.kind === "checked" && a.operand === b.operand && a.by === b.by
		case "language":
			return (
				b.kind === "language" &&
				a.operand === b.operand &&
				a.pattern === b.pattern &&
				a.flags === b.flags &&
				a.bytes === b.bytes
			)
	}
}

const identicalPrecondition = (a: Precondition, b: Precondition): boolean => {
	switch (a.kind) {
		case "nonzero":
			return b.kind === "nonzero" && a.operand === b.operand
		case "nonnegative":
			return b.kind === "nonnegative" && a.operand === b.operand
		case "finite":
			return b.kind === "finite" && a.operand === b.operand
		case "fits":
		case "contract":
		case "language":
		case "powerDomain":
		case "powerRange":
		case "bucketDomain":
		case "lexical":
			return b.kind === a.kind
	}
}

const identicalPreconditionProof = (a: PreconditionProof, b: PreconditionProof): boolean =>
	identicalPrecondition(a.precondition, b.precondition) &&
	each(a.premises, b.premises, identicalPremise)

const identicalProof = (a: OperationProof, b: OperationProof): boolean =>
	each(a, b, identicalPreconditionProof)

const identicalNative = (a: NativeProof, b: NativeProof): boolean =>
	each(a.premises, b.premises, identicalPremise)

const identicalPattern = (a: PatternEntry, b: PatternEntry): boolean =>
	a.source === b.source && a.are === b.are

type Operation = Extract<TableExpr, { readonly kind: "op" | "cast" }>

const nativeOf = (e: Operation): NativeProof | undefined => ("native" in e ? e.native : undefined)

const proofOf = (e: Operation): OperationProof | undefined => ("proof" in e ? e.proof : undefined)

const patternsOf = (e: Operation): ReadonlyArray<PatternEntry> | undefined =>
	"patterns" in e ? e.patterns : undefined

/** What an operator and a cast name beside their overload: a native proof, an operation proof, a pattern table. */
const identicalWitness = (a: Operation, b: Operation): boolean =>
	both(nativeOf(a), nativeOf(b), identicalNative) &&
	both(proofOf(a), proofOf(b), identicalProof) &&
	both(patternsOf(a), patternsOf(b), (x, y) => each(x, y, identicalPattern))

/** An entry's own fields, by its kind, beside the fields every entry has (identicalEntry). */
const identicalOwn = (a: TableExpr, b: TableExpr): boolean => {
	switch (a.kind) {
		case "column":
			return (
				b.kind === "column" && a.column.node === b.column.node && a.column.name === b.column.name
			)
		case "param":
			return b.kind === "param" && a.param === b.param && a.role === b.role
		case "literal":
			return b.kind === "literal" && identicalLiteral(a.value, b.value)
		case "op":
			return b.kind === "op" && a.op === b.op && identicalWitness(a, b)
		case "cast":
			return b.kind === "cast" && a.cast === b.cast && identicalWitness(a, b)
		case "domainCast":
			return b.kind === "domainCast" && identicalProof(a.proof, b.proof)
		case "closedAt":
			return b.kind === "closedAt" && a.relation === b.relation && a.field === b.field
		case "closedRow":
			return b.kind === "closedRow" && a.relation === b.relation
		case "closedHas":
			return b.kind === "closedHas" && a.relation === b.relation
		case "value":
		case "cond":
			return b.kind === a.kind
	}
}

/** A table entry: its label, arguments, type, non-null proof, effects and dependencies, then its kind's own fields. */
const identicalEntry = (a: TableExpr, b: TableExpr): boolean =>
	a.id === b.id &&
	sameOrder<string>(a.args, b.args) &&
	a.nonNull === b.nonNull &&
	a.volatility === b.volatility &&
	sameOrder(a.deps.params, b.deps.params) &&
	sameOrder(a.deps.nodes, b.deps.nodes) &&
	identicalScalarType(a.type, b.type) &&
	identicalOwn(a, b)

/** An expression table: its root, and one key set whose entries are identical key by key. */
export const identicalExprTable = (a: ExprTable, b: ExprTable): boolean => {
	if (a.root !== b.root) {
		return false
	}
	const entries = Object.entries(a.exprs)
	const others = new Map<string, TableExpr>(Object.entries(b.exprs))
	return (
		entries.length === others.size &&
		entries.every(([key, x]) => {
			const y = others.get(key)
			return y !== undefined && identicalEntry(x, y)
		})
	)
}
