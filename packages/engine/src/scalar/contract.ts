import { malformedDescription, unsupported } from "#compiler/core/errors.ts"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import { captureLoc, SourceLoc } from "#compiler/core/loc.ts"
import { type Built, builtMark } from "#compiler/core/phantom.ts"
import { hasProperties, isList } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { type CompareOp, decodeDesc, type ExprDesc, type FieldDesc } from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { type Fact, factNames } from "#compiler/ir/proof.ts"
import { rosterOf, type ScalarType } from "#compiler/ir/scalar.ts"
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
	describeFieldOrThrow,
	literalDescOrThrow,
	type ScalarEnv,
	type SqlTag,
	serialNameOf
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

/** The operand opposite a term of type `t`: another term or a literal of t's base. */
const operandExpr = (operand: unknown, t: ScalarType, label: string): OpenExpr => {
	const term = termExpr(operand)
	if (term !== undefined) {
		return term
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
			if (!isList(values)) {
				throw malformedDescription(captureLoc("in", []), "a finite list of literals")
			}
			const list: ReadonlyArray<unknown> = values
			const literals = list.map((v) => literalDescOrThrow(t, v, "in value"))
			return predicateValue({ kind: "in", arg: expr, values: literals })
		}
	})
	return registerTerm(term, expr, t)
}

/** The ScalarEnv that re-reads a base's own resolved roster, which a FieldDesc names but does not hold. */
const baseEnv = (base: ScalarType): ScalarEnv => {
	const roster = rosterOf(base)
	return {
		kind: "builder",
		roster: (name) => (roster?.closed === name ? roster.handles : undefined)
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
 * The facts a contract declares it proves, `{ proves: [...] }` after its predicate: distinct facts, kept in the one
 * order, which the schema's compilation proves from the predicate (scalar/compute/total.ts contractPredicateTable). A
 * declaration needs a predicate to prove it from.
 */
const declaredFacts = (
	declared: unknown,
	predicate: ExprDesc | undefined,
	contract: string
): ReadonlyArray<Fact> => {
	if (declared === undefined) {
		return []
	}
	const loc = captureLoc(`contract ${contract} proves`, [])
	const proves = hasProperties(declared) ? declared["proves"] : undefined
	if (!isList(proves)) {
		throw malformedDescription(loc, "{ proves: [...] }, the facts the predicate proves")
	}
	const facts = factNames.filter((f) => proves.includes(f))
	if (facts.length !== proves.length) {
		throw malformedDescription(
			loc,
			"distinct facts the predicate proves: nonzero, nonnegative or finite, each once"
		)
	}
	if (predicate === undefined && facts.length > 0) {
		throw malformedDescription(loc, "a predicate that proves the declared facts")
	}
	return facts
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
 * contract(name, base, predicate?): a nominal contract over a base descriptor, and the runtime protocol of scalar terms and predicates the predicate is built from.
 *
 * A contract is a nominal identity over its base, with an optional total predicate over one value, and it always
 * lowers to a PostgreSQL DOMAIN over the base type. Its identity is its name and base: two contracts with
 * identical bases and predicates are different types, and the predicate is not part of type compatibility.
 * The domain's one constraint is `<contract>__check`, which a migration changing the predicate replaces in place.
 *
 * The contract value is callable as an unchecked brand constructor: `Cents(1250n)` returns its argument unchanged and
 * checks nothing, ever. The public contract (public/fields.ts) is an unchecked brand constructor to Effect's type-level
 * brand (core/brand.ts nominal), with the contract's members, which this admission core decides, defined onto it.
 * PostgreSQL evaluates the predicate on writes into the domain and on an explicit domain cast; the library evaluates it
 * for a literal that adopts the contract, the ContractLiteral check at compilation, and for a parameter its uses type
 * by the contract, at bind (codec/scalar.ts paramEncoder).
 *
 * The predicate callback runs once, at construction, over the domain's VALUE, and records an ExprDesc (callbacks
 * build descriptions; they never run per row). Its value scalar offers the comparisons of a Scalar:
 * eq, ne, lt, le, gt, ge, between and in. A literal operand adopts the base's host type and is checked as a literal of
 * it at construction: over a numeric base a JavaScript number is refused and an exact decimal string is
 * parsed. Whether each of the predicate's partial operations is proved, each declared fact holds and each literal fits
 * is the checker's to decide at compilation.
 *
 * The term protocol (compute/term.ts). A scalar term is a value with an `expr` member holding its expression; a predicate
 * also has `predicate: true`. The Compute catalogue (scalar/compute), the query builder and
 * the row checks build terms and predicates and register them by identity in compute/term.ts's one registry,
 * and read them with `termExpr` and `predicateExpr`, which consult that registry and never a value's members, so a
 * Compute expression over a contract's value composes with the value's own comparisons:
 * `contract("Body", text, (v) => Compute.charLength(v).le(2000))`, and a copy of a term is no term. A parameter
 * (r.param) is any value with a string `param` member and no `expr`; it adopts the type it meets.
 *
 * The admission core of contract: a JavaScript caller can pass anything in every position. `rest` is what follows the
 * base: none or an undefined predicate is contract(name, base), one predicate, which buildPredicate checks is a
 * callback, contract(name, base, predicate), the facts it proves after it contract(name, base, predicate, { proves }),
 * and more are refused. A serial base is refused UnsupportedOperation before the predicate runs, by its writing
 * (registry.ts serialNameOf), since its type is its integer's: it is a generation declaration, not a value domain.
 * The predicate is read once, here.
 */
export const contractParts = (
	name: unknown,
	base: unknown,
	rest: ReadonlyArray<unknown>
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
	const [predicate, declaration, ...extra] = rest
	if (extra.length > 0) {
		throw malformedDescription(
			captureLoc(`contract ${contract}`, []),
			"contract(name, base), contract(name, base, predicate) or contract(name, base, predicate, { proves })"
		)
	}
	const described = describeFieldOrThrow(base, SourceLoc(`contract ${contract} base`, []))
	const loc = captureLoc(`contract ${contract}`, [])
	const serial = serialNameOf(described)
	if (serial !== undefined) {
		throw unsupported(
			loc,
			`contractBase: a contract is a value domain; ${serial} is a serial generation declaration, so use its integer type, pg.${described.sql}`
		)
	}
	const domain = contractType(contract, described.scalar, loc, undefined, [])
	if (!domain.ok) {
		throw domain.error
	}
	const built = predicate === undefined ? undefined : buildPredicate(predicate, described, contract)
	const facts = declaredFacts(declaration, built, contract)
	return {
		name: contract,
		sql: described.sql,
		base: described,
		desc: { kind: "contract", name: contract, base: described.desc, predicate: built, facts },
		predicate: built,
		loc,
		env: baseEnv(described.scalar)
	}
}
