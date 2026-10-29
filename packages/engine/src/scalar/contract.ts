import { brandColumn } from "#compiler/core/decoder.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import { captureLoc, SourceLoc } from "#compiler/core/loc.ts"
import { type Built, builtMark } from "#compiler/core/phantom.ts"
import { hasProperties, isList } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { type CompareOp, decodeDesc, type ExprDesc, type FieldDesc } from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { rosterOf, type ScalarType, textOf } from "#compiler/ir/scalar.ts"
import {
	type PredicateValue,
	predicateExpr,
	predicateValue,
	registerTerm,
	type TermCarrier,
	termExpr
} from "#compiler/scalar/compute/term.ts"

import {
	contractType,
	type Described,
	type Descriptor,
	defineField,
	describeFieldOrThrow,
	literalDescOrThrow,
	noText,
	type ScalarEnv,
	type SqlTag
} from "#compiler/scalar/registry.ts"

interface ScalarTerm extends Built, TermCarrier {
	readonly expr: OpenExpr
	readonly eq: (other: unknown) => PredicateValue
	readonly ne: (other: unknown) => PredicateValue
	readonly lt: (other: unknown) => PredicateValue
	readonly le: (other: unknown) => PredicateValue
	readonly gt: (other: unknown) => PredicateValue
	readonly ge: (other: unknown) => PredicateValue
	readonly between: (low: unknown, high: unknown) => PredicateValue
	readonly in: (values: unknown) => PredicateValue
}

const paramName = (value: unknown): string | undefined =>
	hasProperties(value) && typeof value["param"] === "string" && value["expr"] === undefined
		? value["param"]
		: undefined

/** The operand opposite a term of type `t`: another term, a parameter, or a literal of t's base. */
const operandExpr = (operand: unknown, t: ScalarType, label: string): OpenExpr => {
	const term = termExpr(operand)
	if (term !== undefined) {
		return term
	}
	const param = paramName(operand)
	if (param !== undefined) {
		return { kind: "param", name: param }
	}
	if (predicateExpr(operand) !== undefined) {
		throw malformedDescription(captureLoc(label, []), "a scalar operand, not a predicate")
	}
	return { kind: "literal", value: literalDescOrThrow(t, operand, label), type: undefined }
}

const compare =
	(op: CompareOp, left: OpenExpr, t: ScalarType) =>
	(other: unknown): PredicateValue =>
		predicateValue({ kind: "compare", op, left, right: operandExpr(other, t, `${op} operand`) })

/**
 * A scalar term over `expr`, whose comparisons take operands of type `t`, its carrier the column and SQL type of the
 * value it stands for.
 */
const scalarTerm = (expr: OpenExpr, t: ScalarType, carrier: TermCarrier): ScalarTerm => {
	const term: ScalarTerm = Object.freeze({
		...builtMark,
		expr,
		column: carrier.column,
		sql: carrier.sql,
		eq: compare("eq", expr, t),
		ne: compare("ne", expr, t),
		lt: compare("lt", expr, t),
		le: compare("le", expr, t),
		gt: compare("gt", expr, t),
		ge: compare("ge", expr, t),
		between: (low: unknown, high: unknown) =>
			predicateValue({
				kind: "between",
				arg: expr,
				low: operandExpr(low, t, "between low"),
				high: operandExpr(high, t, "between high")
			}),
		in: (values: unknown) => {
			if (!isList(values) || values.length === 0) {
				throw malformedDescription(captureLoc("in", []), "a nonempty finite list of literals")
			}
			const list: ReadonlyArray<unknown> = values
			const literals = list.map((v) => literalDescOrThrow(t, v, "in value"))
			return predicateValue({ kind: "in", arg: expr, values: literals })
		}
	})
	return registerTerm(term, expr, t)
}

interface ContractDescriptor extends Descriptor {
	readonly name: string
	/** The descriptor the caller passed, unchanged: a str.regex field keeps its pattern. */
	readonly base: object
	readonly predicate: ExprDesc | undefined
	(value: unknown): unknown
}

/**
 * The ScalarEnv that re-reads a base's own resolved metadata: its roster and canonical text refinement, which a
 * FieldDesc names but does not hold.
 */
const baseEnv = (base: ScalarType): ScalarEnv => {
	const text = textOf(base)
	const roster = rosterOf(base)
	return {
		kind: "builder",
		roster: (name) => (roster?.closed === name ? roster.handles : undefined),
		text: text === undefined ? noText : () => Result.ok(text)
	}
}

const buildPredicate = (predicate: unknown, base: Described, name: string): ExprDesc => {
	if (typeof predicate !== "function") {
		throw malformedDescription(
			captureLoc(`contract ${name} predicate`, []),
			"a predicate callback (v) => predicate over the value"
		)
	}
	const built: unknown = Reflect.apply(predicate, undefined, [
		scalarTerm({ kind: "value" }, base.scalar, base)
	])
	const expr = predicateExpr(built)
	if (expr === undefined) {
		throw malformedDescription(
			captureLoc(`contract ${name} predicate`, []),
			"a predicate built from the value's comparisons"
		)
	}
	const owned = decodeDesc("expr", expr)
	if (!owned.ok) {
		throw owned.error
	}
	return owned.value
}

/**
 * What the admission core decided: the contract's Description and the members and environment its descriptor is
 * defined with.
 */
interface ContractParts {
	readonly name: string
	readonly sql: SqlTag
	/** The base as the registry admitted it, its column among its members. */
	readonly base: Described
	readonly desc: FieldDesc
	readonly predicate: ExprDesc | undefined
	readonly loc: SourceLoc
	readonly env: ScalarEnv
}

/**
 * The admission core of contract: a JavaScript caller can pass anything in every position. `rest` is what follows the
 * base: none or an undefined predicate is contract(name, base), one predicate, which buildPredicate checks is a
 * callback, contract(name, base, predicate), and more are refused. The predicate is read once, here.
 */
export const contractParts = (
	name: unknown,
	base: unknown,
	...rest: ReadonlyArray<unknown>
): ContractParts => {
	const declared =
		typeof name === "string" ? parseDeclaredName(name) : Result.err("a name given as a string")
	if (!declared.ok) {
		throw malformedDescription(
			captureLoc("contract name", []),
			`a contract name: a declared name, the contract's identity; ${declared.error}`
		)
	}
	const contract = declared.value
	if (rest.length > 1) {
		throw malformedDescription(
			captureLoc(`contract ${contract}`, []),
			"contract(name, base) or contract(name, base, predicate)"
		)
	}
	const [predicate] = rest
	const described = describeFieldOrThrow(base, SourceLoc(`contract ${contract} base`, []))
	const loc = captureLoc(`contract ${contract}`, [])
	/** A serial base is refused before the predicate runs: it is a generation declaration, not a value domain. */
	const domain = contractType(contract, described.scalar, loc, undefined)
	if (!domain.ok) {
		throw domain.error
	}
	const built = predicate === undefined ? undefined : buildPredicate(predicate, described, contract)
	return {
		name: contract,
		sql: described.sql,
		base: described,
		desc: { kind: "contract", name: contract, base: described.desc, predicate: built },
		predicate: built,
		loc,
		env: baseEnv(described.scalar)
	}
}

/**
 * contract(name, base, predicate?): a nominal contract over a base descriptor, and the runtime protocol of scalar terms and predicates the predicate is built from.
 *
 * A contract is a nominal identity over its base, with an optional total predicate over one value, and it always
 * lowers to a PostgreSQL DOMAIN over the base type. Its identity is its name and base: two contracts with
 * identical bases and predicates are different types, and the predicate is not part of type compatibility.
 * The domain's one constraint is `<contract>__check`, which a migration changing the predicate replaces in place.
 *
 * The contract value is callable as an unchecked brand constructor: `Cents(1250n)` returns its argument unchanged and
 * checks nothing, ever. The public contract (types/fields) is an unchecked brand constructor to Effect's type-level
 * brand (core/brand.ts nominal), with the contract's members defined onto it; this module's `contract` is the admission
 * core a JavaScript caller reaches, whose brand is the plain identity. PostgreSQL alone evaluates the predicate: on
 * writes into the domain, on an explicit domain cast, and, for a literal that adopts the contract, the compiler's
 * ContractLiteral check at compilation.
 *
 * The predicate callback runs once, at construction, over the domain's VALUE, and records an ExprDesc (callbacks
 * build descriptions; they never run per row). Its value scalar offers the comparisons of a Scalar:
 * eq, ne, lt, le, gt, ge, between and in. A literal operand adopts the base's host type and is checked as a literal of
 * it at construction: over a numeric base a JavaScript number is refused and an exact decimal string is
 * parsed. Whether the predicate lies in the total fragment, and whether each literal fits, is the checker's to decide
 * at compilation.
 *
 * The term protocol (compute/term.ts). A scalar term is a value with an `expr` member holding its expression; a predicate
 * also has `predicate: true`. The Compute catalogue (scalar/compute), the query builder and
 * the row checks build terms and predicates and register them by identity in compute/term.ts's one registry,
 * and read them with `termExpr` and `predicateExpr`, which consult that registry and never a value's members, so a
 * Compute expression over a contract's value composes with the value's own comparisons:
 * `contract("Body", text, (v) => Compute.charLength(v).le(2000))`, and a copy of a term is no term. A parameter
 * (r.param) is any value with a string `param` member and no `expr`; it adopts the type it meets.
 *
 * The admission core for a JavaScript caller: contract(name, base) or contract(name, base, predicate), the predicate a
 * callback over the value's scalar term.
 */
export const contractDescriptor = (
	name: unknown,
	base: unknown,
	...rest: ReadonlyArray<unknown>
): ContractDescriptor => admitContract(name, base, ...rest)

/**
 * The descriptor of the admission core: the unchecked identity brand, with the contract's members.
 *
 * describeField admitted `base`, so it is an object or a function: the public `base` member is the caller's
 * descriptor itself, and an unowned str.regex field keeps its pattern.
 */
export const admitContract = (
	name: unknown,
	base: unknown,
	...rest: ReadonlyArray<unknown>
): ContractDescriptor => {
	const parts = contractParts(name, base, ...rest)
	if (base === null || (typeof base !== "object" && typeof base !== "function")) {
		throw malformedDescription(captureLoc(`contract ${parts.name} base`, []), "a field descriptor")
	}
	/** A fresh unchecked brand constructor, one function per contract, which its descriptor is: no runtime predicate
	 * exists in the library. The column is the base's, branded. */
	const brand = (value: unknown): unknown => value
	const column = brandColumn(parts.base.column, brand)
	return defineField(
		brand,
		parts.sql,
		parts.desc,
		{ name: parts.name, base, predicate: parts.predicate, column },
		parts.loc,
		parts.env
	)
}
