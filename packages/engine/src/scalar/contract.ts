import { admitHostKey } from "#compiler/core/brand.ts"
import { malformedDescription, ruleRefused } from "#compiler/core/errors.ts"
import { admitDeclaredName } from "#compiler/core/identity.ts"
import { captureLoc, SourceLoc } from "#compiler/core/loc.ts"
import { type Built, builtMark } from "#compiler/core/phantom.ts"
import { hasProperties, isList } from "#compiler/core/record.ts"
import { decodeDesc, type ExprDesc, type FieldDesc, nestedFields } from "#compiler/ir/desc.ts"
import { instantName, isInstantType } from "#compiler/ir/instant.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { type Fact, factNames } from "#compiler/ir/proof.ts"
import { naturalName, rosterOf, type ScalarType, typeLabel } from "#compiler/ir/scalar.ts"
import { predicateExpr, registerTerm, type TermCarrier } from "#compiler/scalar/compute/term.ts"

import {
	contractType,
	type Described,
	describeFieldOrThrow,
	type ScalarEnv,
	type SqlTag
} from "#compiler/scalar/registry.ts"

interface ScalarTerm extends Built, TermCarrier {
	readonly expr: OpenExpr
}

/**
 * The term a contract predicate's callback receives for its value: a scalar term over `expr` of type `t`, its carrier
 * the column and SQL type of the value it stands for, which Logic's comparisons read.
 */
const scalarTerm = (expr: OpenExpr, t: ScalarType, carrier: TermCarrier): ScalarTerm =>
	registerTerm(
		Object.freeze({ ...builtMark, expr, column: carrier.column, sql: carrier.sql }),
		expr,
		t
	)

/** The ScalarEnv that re-reads a base's own resolved roster, which a FieldDesc names but does not hold. */
const baseEnv = (base: ScalarType): ScalarEnv => {
	const roster = rosterOf(base)
	return {
		kind: "builder",
		roster: (name) => (roster?.closed === name ? roster : undefined)
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
			"a predicate built from Logic's comparisons over the value"
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
 * The first call of a caller's contract, `contract<typeof key>()`, as a JavaScript caller makes it: its one argument is
 * its key's type, a type argument, so it takes no value, and a value there, the spelling `contract(name, base)` of a contract
 * that minted its own values, is refused naming the one spelling.
 */
export const admitContractCall = (first: ReadonlyArray<unknown>): void => {
	if (first.length > 0) {
		throw malformedDescription(
			captureLoc("contract", []),
			"contract<typeof key>()(name, base), contract<typeof key>()(name, base, predicate) or contract<typeof key>()(name, base, predicate, { proves }): the type of its key is the first call's type argument, and the first call takes no value"
		)
	}
}

/**
 * contract<typeof key>()(name, base, predicate?): a nominal contract over a base descriptor, and the runtime protocol of scalar
 * terms and predicates the predicate is built from.
 *
 * A contract is a nominal identity over its base, with an optional total predicate over one value, and it always
 * lowers to a PostgreSQL DOMAIN over the base type. Its identity is its name and base: two contracts with
 * identical bases and predicates are different types, and the predicate is not part of type compatibility.
 * The domain's one constraint is `<contract>__check`, which a migration changing the predicate replaces in place.
 *
 * The contract value makes no value: its host type is its consumer's (public/fields.ts contract), its base's host type
 * under the consumer's key, which only the consumer's mint makes (core/brand.ts mintOf), and its column delivers it
 * from the base's (core/decoder.ts hostColumn). The public contract is a descriptor with the contract's members, which
 * this admission core decides. PostgreSQL evaluates the predicate on writes into the domain and on an explicit domain
 * cast; the library evaluates it for a literal the contract reads, the ContractLiteral check at compilation. A parameter its uses type by the
 * contract is PostgreSQL's to check, its placeholder typed by the contract's domain (lower/conservative/context.ts
 * paramTypeRef).
 *
 * The predicate callback runs once, at construction, over the domain's VALUE, and records an ExprDesc (callbacks
 * build descriptions; they never run per row). Its value scalar offers the comparisons of a Scalar:
 * eq, ne, lt, le, gt, ge, between and in. A literal operand adopts the base's host type and is checked as a literal of
 * it at construction: over a numeric base a JavaScript number is refused and an exact decimal string is
 * parsed. Whether each of the predicate's partial operations is proved, each declared fact holds and each literal fits
 * is the checker's to decide at compilation.
 *
 * The term protocol (compute/term.ts). A scalar term is a value with an `expr` member holding its expression; a predicate
 * also has `predicate: true`. The scalar catalogue (scalar/compute), the query builder and
 * the row checks build terms and predicates and register them by identity in compute/term.ts's one registry,
 * and read them with `termExpr` and `predicateExpr`, which consult that registry and never a value's members, so a
 * scalar expression over a contract's value is compared as any term is:
 * `contract<typeof bodyKey>()("Body", text, (v) => Logic.le(Text.charLength(v), 2000))`, and a copy of a term is no term. A parameter
 * (r.param) is any value with a string `param` member and no `expr`; it adopts the type it meets.
 *
 * The admission core of contract: a JavaScript caller can pass anything in every position. `rest` is what follows the
 * base: none or an undefined predicate is contract<typeof key>()(name, base), one predicate, which buildPredicate checks is a
 * callback, contract<typeof key>()(name, base, predicate), the facts it proves after it, contract<typeof key>()(name, base,
 * predicate, { proves }), and more are refused. The predicate is read once, here.
 */
/**
 * A caller's contract's admission (public/fields.ts contract): contractParts', its name apart from natural and instant,
 * the builtins' own (scalar/natural.ts, scalar/instant.ts), so every contract of another name is its consumer's
 * (isOwnedName).
 */
export const callerContractParts = (
	name: unknown,
	base: unknown,
	rest: ReadonlyArray<unknown>
): ContractParts => {
	if (name === naturalName || name === instantName) {
		throw ruleRefused(
			captureLoc(`contract ${name}`, []),
			"a contract's name is apart from natural and instant, grizzle's own types"
		)
	}
	return contractParts(name, base, rest)
}

/**
 * Whether a contract of this name is a consumer's, whose values only its consumer's key makes: any name but natural's
 * and instant's, which no caller's contract takes (callerContractParts).
 */
const isOwnedName = (name: string): boolean => name !== naturalName && name !== instantName

/**
 * The names of the consumers' contracts (isOwnedName) a descriptor holds a value of at any depth: itself where it is
 * one, then its base's down its chain, a span's endpoint's, and each field's of a variant's arms; a name once each, in
 * the order the walk meets them.
 */
export const ownedContractNames = (desc: FieldDesc): ReadonlyArray<string> => {
	const names: Array<string> = []
	nestedFields(desc, (d) => {
		if (d.kind === "contract" && isOwnedName(d.name) && !names.includes(d.name)) {
			names.push(d.name)
		}
	})
	return names
}

/**
 * How many consumers' contracts a type's chain holds (isOwnedName): its own, then its base's, down to its base type,
 * each a key a mint of its values takes.
 */
export const ownedLevels = (t: ScalarType): number =>
	t.contract === undefined
		? 0
		: (isOwnedName(t.contract.name) ? 1 : 0) + ownedLevels(t.contract.base)

/**
 * A cast of `operand` into `to` as a refusal spells it: Type.cast's own arguments, then a placeholder for the keys a cast
 * into a consumer's contract takes (ownedLevels), its key or its keys.
 */
export const castSpelling = (operand: string, to: ScalarType): string => {
	const levels = ownedLevels(to)
	const keys = levels === 0 ? "" : levels === 1 ? ", <its key>" : ", <its keys>"
	return `Type.cast(${operand}, ${typeLabel(to)}${keys})`
}

/**
 * What a database-side mint into `type` takes after its own arguments, `rest`, as a JavaScript caller passes them
 * (types/fields MintKey): a key for each consumer's contract of its chain (ownedLevels), its own first, then its base's,
 * each a value mintOf would take (core/brand.ts admitHostKey), and nothing for any other type. A mint is Type.cast,
 * drawn or accumulated, each a value of its target the database or grizzle makes from values of other types; `plain`
 * is its spelling over any other target and `keyed` over a contract, which its refusal names. Whose each key is, the
 * types judge.
 */
export const admitMintKey = (
	type: ScalarType,
	rest: ReadonlyArray<unknown>,
	loc: SourceLoc,
	plain: string,
	keyed: string
): void => {
	const levels = ownedLevels(type)
	if (levels === 0) {
		if (rest.length > 0) {
			throw malformedDescription(loc, plain)
		}
		return
	}
	if (rest.length !== levels) {
		throw malformedDescription(
			loc,
			`${keyed}: a contract's values are its consumer's, made only under the keys its modules hold, one for each consumer's contract of its chain, its own first`
		)
	}
	for (const key of rest) {
		admitHostKey(key, `${loc.label} key`)
	}
}

export const contractParts = (
	name: unknown,
	base: unknown,
	rest: ReadonlyArray<unknown>
): ContractParts => {
	const nameLoc = captureLoc("contract name", [])
	if (typeof name !== "string") {
		throw malformedDescription(
			nameLoc,
			"a contract name: a declared name, the contract's identity; a name given as a string"
		)
	}
	const declared = admitDeclaredName(name, `contract name ${JSON.stringify(name)}`, nameLoc)
	if (!declared.ok) {
		throw declared.error
	}
	const contract = declared.value
	const [predicate, declaration, ...extra] = rest
	if (extra.length > 0) {
		throw malformedDescription(
			captureLoc(`contract ${contract}`, []),
			"contract<typeof key>()(name, base), contract<typeof key>()(name, base, predicate) or contract<typeof key>()(name, base, predicate, { proves })"
		)
	}
	const described = describeFieldOrThrow(base, SourceLoc(`contract ${contract} base`, []))
	const loc = captureLoc(`contract ${contract}`, [])
	if (isInstantType(described.scalar)) {
		throw ruleRefused(
			loc,
			"a contract is over a value a caller brands; an instant is the database's clock's alone, so no contract is over one"
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
		desc: { kind: "contract", name: contract, base: described.desc, facts, predicate: built },
		predicate: built,
		loc,
		env: baseEnv(described.scalar)
	}
}
