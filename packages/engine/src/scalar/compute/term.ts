import type { Column } from "#compiler/core/decoder.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import { type Built, built, builtMark } from "#compiler/core/phantom.ts"
import { hasProperties } from "#compiler/core/record.ts"
import type { GuardDesc } from "#compiler/ir/desc.ts"
import type { OpenExpr, OpenHead } from "#compiler/ir/open.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"

export interface PredicateValue extends Built {
	readonly predicate: true
	readonly expr: OpenExpr
}

/**
 * The key a guard holds the term its Compute.when branch receives under: the guard's subject, which the guard refines
 * inside the branch. The public barrel exports no key, so only Compute.when hands it out, to its branch's function, and
 * compilation proves its facts only inside the branch (a copy used elsewhere is refused, PartialOperation).
 */
export const guarded: unique symbol = Symbol("grizzle.guarded")

/** A guard a Compute guard builder made: a predicate, and under `guarded` the term its branch receives. */
export interface GuardValue<out S> extends PredicateValue {
	readonly [guarded]: S
}

/** A term's carrier: the column that reads its cell into its host value, and its SQL type. */
export interface TermCarrier<out T = unknown, out S extends SqlTag = SqlTag> {
	readonly column: Column<T>
	readonly sql: S
}

/**
 * The runtime protocol of scalar terms and predicates, one language for schema, queries and changes.
 *
 * A term is a frozen value with an `expr` member holding its expression; a predicate has `predicate: true` and an
 * `expr`. The phantom members the public types give
 * Term and Predicate (`type`, `params`, `origin`) exist only in the types. A parameter (r.param) is a term over
 * `{ kind: "param", name, type }` of its descriptor's type, which stands wherever a term of that type stands. An
 * expression is open (ir/open.ts OpenExpr): a query variable, a parent variable or an interior stage in it is the builder's reference object until the
 * rule that uses it spells it, and a row check or a contract parses it into a Description's. This is the protocol the field
 * package's contract predicates (scalar/contract.ts), the query builder and the row checks build terms with, so a
 * Compute expression over a contract's VALUE composes with the value's own comparisons:
 * `contract("Body", text, (v) => Compute.charLength(v).le(2000))`.
 *
 * Terms and predicates are admitted by identity, as queries and sources are. Every builder that makes one registers
 * the frozen value here with its expression and type (registerTerm, registerPredicate), and termExpr, termOf and
 * predicateExpr read the registry, never the value's members. A registered expression is its builder's checked one: a
 * builder checks only the level it adds (each literal it encodes, each name and option it takes), over operands that
 * are registered terms' expressions, checked when those were built, so a reader takes it as it is and building a chain
 * of terms is linear. A value the user passes that no builder made is no term; the Description it ends up in is decoded
 * whole where it leaves the builders (ir/desc.ts decodeDesc). A term's phantoms are the ones its builder's signature
 * gave it, and its members are not its meaning: an object spread copies a term's members and its brand
 * (core/phantom.ts), and the copy's static type keeps the source's phantom, so `{ ...name, expr: balance.expr }` would
 * be a Term of name's type over balance's expression. Such a copy is refused (MalformedDescription), and a value no
 * builder made, whatever its members, is no term.
 *
 * Every term carries the comparisons of a Scalar (eq, ne, lt, le, gt, ge, between, in); Compute.charLength's
 * result is typed a Scalar, and the others are typed Term, whose comparisons are r.eq and Compute.eq.
 *
 * A typed term: its expression and its carrier, whose column delivers T; the ScalarType its literal operands adopt is
 * the one its builder registered (registerTerm).
 */
export interface ScalarTerm<out T = unknown, out S extends SqlTag = SqlTag>
	extends Built, TermCarrier<T, S> {
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

/**
 * What a builder recorded for a value it made: a typed term, with its type and carrier; a carried term, whose carrier
 * is known but whose type the checker reads from the term it meets (a JavaScript value in a head, or a variable over a
 * union field whose arms disagree on its type); a field of a query rebuilt from its Description alone, which has
 * neither type nor carrier; a predicate; or a head-only value, an aggregate or a producer, which stands only in a
 * find head and is no term: its Description and what the builder knows of its result's type.
 */
type Registered =
	| {
			readonly kind: "typed"
			readonly expr: OpenExpr
			readonly scalarType: ScalarType
			readonly carrier: TermCarrier
	  }
	| { readonly kind: "carried"; readonly expr: OpenExpr; readonly carrier: TermCarrier }
	| { readonly kind: "untyped"; readonly expr: OpenExpr }
	| { readonly kind: "predicate"; readonly expr: OpenExpr }
	| {
			readonly kind: "guard"
			readonly expr: OpenExpr
			readonly guardTest: GuardTest
			readonly subject: object
	  }
	| { readonly kind: "head"; readonly desc: OpenHead; readonly typing: Typing }

/**
 * The terms and predicates the builders made, by identity. A WeakMap holds nothing alive and is never enumerated, so
 * it is no cache.
 */
const registered = new WeakMap<object, Registered>()

/**
 * Registers `value`, a frozen typed term a builder made over `expr`, and returns it. Its type is one this package
 * built, frozen by its constructor (ir/scalar.ts, scalar/registry.ts scalarTypeOf), so it is kept as it is, never
 * decoded again.
 */
export const registerTerm = <V extends Built & TermCarrier>(
	value: V,
	expr: OpenExpr,
	scalarType: ScalarType
): V => {
	registered.set(value, {
		kind: "typed",
		expr,
		scalarType,
		carrier: value
	})
	return value
}

/** Registers `value`, a frozen carried term over `expr` whose type the builder does not know, and returns it. */
export const registerCarried = <V extends Built & TermCarrier>(value: V, expr: OpenExpr): V => {
	registered.set(value, { kind: "carried", expr, carrier: value })
	return value
}

/** Registers `value`, a frozen term over `expr` whose type the builder cannot know, and returns it. */
export const registerUntyped = <V extends Built>(value: V, expr: OpenExpr): V => {
	registered.set(value, { kind: "untyped", expr })
	return value
}

/**
 * Registers `value`, a frozen head-only value a builder made, an aggregate or a producer, with its Description and
 * what the builder knows of its result's type, and returns it.
 */
export const registerHead = <V extends Built>(value: V, desc: OpenHead, typing: Typing): V => {
	registered.set(value, { kind: "head", desc, typing })
	return value
}

/** The Description and result typing of a head-only value, or undefined when `value` is none. */
export const headOf = (
	value: unknown
): { readonly desc: OpenHead; readonly typing: Typing } | undefined => {
	const entry = registeredOf(value)
	return entry?.kind === "head" ? { desc: entry.desc, typing: entry.typing } : undefined
}

/**
 * Why a head-only value stands nowhere a term does, the refusal `wanted` names: an aggregate or a producer is a find
 * head's own column, never an operand. A computation over its result reads it from an interior stage that finds it.
 */
export const headOnlyOperand = (wanted: string, head: OpenHead): string => {
	const named =
		head.kind === "aggregate"
			? `r.${head.fn}(...) is an aggregate`
			: head.kind === "producer"
				? `r.${head.fn}(...) is a producer`
				: "a head term"
	return `${wanted}: ${named}, which stands only as a column of a find head; to compute with its result, find it in an interior stage (r.interior) and compute over the variable that matches that column`
}

/** Registers `value`, a frozen predicate a builder made over `expr`, and returns it. */
export const registerPredicate = <V extends Built>(value: V, expr: OpenExpr): V => {
	registered.set(value, { kind: "predicate", expr })
	return value
}

/**
 * What a guard's branch knows of its subject: what its builder's test establishes there (GuardDesc), or nothing, the
 * test of a match against a pattern term, whose values hold no one language. Compute.when over the second is a
 * conditional over its test.
 */
export type GuardTest =
	| { readonly kind: "refines"; readonly guard: GuardDesc }
	| { readonly kind: "tests" }

/**
 * A guard a Compute guard builder made (Compute.nonzero and its kin): a predicate, `expr`, that Compute.when also reads
 * as its guard over `subject`, the term it refines.
 */
export const registerGuard = <V extends Built>(
	value: V,
	expr: OpenExpr,
	guardTest: GuardTest,
	subject: object
): V => {
	registered.set(value, { kind: "guard", expr, guardTest, subject })
	return value
}

/** A guard's test and its subject, where `value` is a guard a builder made. */
export const guardOf = (
	value: unknown
): { readonly guardTest: GuardTest; readonly subject: object } | undefined => {
	const entry = registeredOf(value)
	return entry?.kind === "guard"
		? { guardTest: entry.guardTest, subject: entry.subject }
		: undefined
}

/**
 * What the registry holds for `value`. A value that carries the brand and an `expr` member but that no builder
 * registered is a copy of a term or predicate, an object spread of one: it is refused, since its static type keeps a
 * phantom its expression need not have. Any other unregistered value is simply no term.
 */
const registeredOf = (value: unknown): Registered | undefined => {
	if (!hasProperties(value)) {
		return undefined
	}
	const entry = registered.get(value)
	if (entry === undefined && built in value && "expr" in value) {
		throw malformedDescription(
			captureLoc("term", []),
			"a term or predicate a builder made: a copy of one (an object spread) is neither, because a term's phantom types are its builder's"
		)
	}
	return entry
}

/** The expression of a scalar term, or undefined when the value is not one. */
export const termExpr = (value: unknown): OpenExpr | undefined => {
	const entry = registeredOf(value)
	return entry === undefined ||
		entry.kind === "predicate" ||
		entry.kind === "guard" ||
		entry.kind === "head"
		? undefined
		: entry.expr
}

/**
 * What a builder knows of a term's or a heading field's type: the ScalarType its literal operands adopt, or nothing,
 * for the checker to read from the term it meets.
 */
export type Typing =
	| { readonly kind: "typed"; readonly type: ScalarType }
	| { readonly kind: "untyped" }

export const typed = (type: ScalarType): Typing => Object.freeze({ kind: "typed", type })
export const untyped: Typing = Object.freeze({ kind: "untyped" })

/** A scalar term as its builder recorded it: its expression and what the builder knows of its type. */
export interface TermOf {
	readonly expr: OpenExpr
	readonly typing: Typing
}

/**
 * The scalar term `value` is, or undefined when it is none. A carried term, whose type the builder does not know,
 * is untyped.
 */
export const termOf = (value: unknown): TermOf | undefined => {
	const entry = registeredOf(value)
	if (
		entry === undefined ||
		entry.kind === "predicate" ||
		entry.kind === "guard" ||
		entry.kind === "head"
	) {
		return undefined
	}
	return { expr: entry.expr, typing: entry.kind === "typed" ? typed(entry.scalarType) : untyped }
}

/** A scalar term its builder typed: its expression, its type and its carrier, the term itself. */
export interface TypedTerm {
	readonly expr: OpenExpr
	readonly type: ScalarType
	readonly carrier: TermCarrier
}

/**
 * The typed term `value` is, or undefined when it is none: a value that is no term, a predicate, or a term whose type
 * the builder does not know.
 */
export const typedTermOf = (value: unknown): TypedTerm | undefined => {
	const entry = registeredOf(value)
	return entry?.kind === "typed"
		? { expr: entry.expr, type: entry.scalarType, carrier: entry.carrier }
		: undefined
}

/**
 * The carrier of a scalar term, its column and SQL type, or undefined when the value is not one or carries none: a
 * field of a query rebuilt from its Description alone.
 */
export const termCarrier = (value: unknown): TermCarrier | undefined => {
	const entry = registeredOf(value)
	return entry?.kind === "typed" || entry?.kind === "carried" ? entry.carrier : undefined
}

/** The expression of a predicate, or undefined when the value is not one. */
export const predicateExpr = (value: unknown): OpenExpr | undefined => {
	const entry = registeredOf(value)
	return entry?.kind === "predicate" || entry?.kind === "guard" ? entry.expr : undefined
}

export const predicateValue = (expr: OpenExpr): PredicateValue =>
	registerPredicate(Object.freeze({ ...builtMark, predicate: true, expr }), expr)
