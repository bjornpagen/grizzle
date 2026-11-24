import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { catchRefusal, floatSpecials } from "#compiler/core/canonical.ts"
import type { ProseTag } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { moneyMinorUnits, vectorPayload } from "#compiler/ir/carriers.ts"
import { codecOf, codeOf, handlesHex, type RosterCodec } from "#compiler/ir/codes.ts"
import { datePartSlices } from "#compiler/ir/date.ts"
import {
	describeOp,
	type ExprOf,
	type ScalarExpr,
	spanLiteralText,
	type TypedLiteral
} from "#compiler/ir/expr.ts"
import {
	fieldColumnType,
	type LibraryFn,
	baseTypeRef as physicalBaseType,
	type PhysicalNames
} from "#compiler/ir/physical.ts"
import { baseOf, rosterOf, type ScalarType, spanCarrierOf } from "#compiler/ir/scalar.ts"
import {
	type Env,
	type LowerContext,
	loweringAt,
	refuse,
	refuseAt
} from "#compiler/lower/conservative/context.ts"
import { defaultOps } from "#compiler/lower/conservative/expr/ops.ts"
import { equalityChain, sharedExpr } from "#compiler/lower/conservative/expr/share.ts"
import { ieeeForm } from "#compiler/lower/conservative/expr/total.ts"
import { lowerSearchOp } from "#compiler/lower/conservative/search/index.ts"
import { lowerSpanOp } from "#compiler/lower/conservative/span/index.ts"
import { lowerVectorOp } from "#compiler/lower/conservative/vector/index.ts"
import { closedLeaf } from "#compiler/runtime/write/fill.ts"
import { isDateParse, nativeOp } from "#compiler/scalar/compute/registry.ts"
import { matchAre } from "#compiler/scalar/regex/admit.ts"
import { moneyFractionDigits } from "#compiler/scalar/values/decimal.ts"
import type { Expr, TypeRef } from "#compiler/sql/ast.ts"
import {
	binary,
	call,
	cast,
	eq,
	lit,
	positionalValue,
	qualifiedCall,
	slotParam,
	types
} from "#compiler/sql/build.ts"
import { type ClosedRead, closedRead as closedReadOf, nameOf } from "#compiler/sql/constants.ts"
import { dateOfText } from "#compiler/sql/lexical.ts"
import { printExpr } from "#compiler/sql/print.ts"

/**
 * Minor units as the exact decimal text of the amount, two fractional digits under the fixed C.UTF-8 monetary
 * context that admission verifies.
 */
const moneyText = (minor: bigint): string => {
	const negative = minor < 0n
	const magnitude = negative ? -minor : minor
	const unit = 10n ** BigInt(moneyFractionDigits)
	const whole = magnitude / unit
	const cents = (magnitude % unit).toString().padStart(moneyFractionDigits, "0")
	return `${negative ? "-" : ""}${whole.toString()}.${cents}`
}

/**
 * The codes of the roster a closed literal of `type` is over. A handle's type is a closed id's and a set's a set's
 * (ir/expr.ts literalProblem), so a type over no roster is a defect.
 */
const literalCodec = (names: PhysicalNames, type: ScalarType): RosterCodec => {
	const roster = rosterOf(type)
	if (roster === undefined) {
		throw defect(`a closed literal is typed by a roster's type, not ${baseOf(type).carrier}`)
	}
	return codecOf(names.codes, roster)
}

/**
 * A typed literal of `type`'s base, the one literal spelling of every site (lowerScalar): a query's, a write's and a
 * persistent expression's alike. A literal is never cast to a domain: its refinement was checked at compile time (the
 * ContractLiteral check), and a persistent expression compares a domain column with a base-typed value, since a
 * constant cast to the domain would be rechecked against the domain's current constraints and a tightened domain would
 * make every later insert fail.
 *
 * Money is a quoted literal of the exact plain amount, never a currency-formatted string, and never the numeric
 * constant cast `1.25::money`: numeric_cash is STABLE and reads lc_monetary each time it runs, so in a CHECK, a domain
 * CHECK, an index predicate or a generated column it would depend on the writing session's lc_monetary, which any role
 * can set, and PostgreSQL refuses it in an index predicate or a generated column (42P17). A quoted money literal is
 * converted once, by cash_in where the statement is parsed, under the fixed C.UTF-8 monetary context that admission
 * verifies, and in a persistent expression at DDL time under the migration identity's, stored as a constant count of
 * minor units.
 *
 * Half-open, start < end: PostgreSQL's canonical spelling of a discrete range.
 *
 * The canonical payload is pgvector's input text, -0 already written as 0.
 *
 * A handle is its code under the installation's codebook, a smallint, never its position among the roster's live
 * handles: a removed handle leaves a hole, so the two differ after any removal. A set is its hex literal at its
 * roster's width (ir/codes.ts handlesHex), X'<digits>' cast to its domain.
 */
export const lowerLiteral = (
	names: PhysicalNames,
	literal: TypedLiteral,
	type: ScalarType
): Expr => {
	const sqlType = physicalBaseType(names, type)
	switch (literal.kind) {
		case "int":
			return lit.int(literal.value, sqlType)
		case "numeric":
			return lit.decimal(literal.value.parts, sqlType)
		case "float":
			return lit.float(literal.value, sqlType)
		case "floatSpecial":
			return lit.float(floatSpecials[literal.value], sqlType)
		case "money":
			return lit.text(moneyText(moneyMinorUnits(literal.value)), sqlType)
		case "bool":
			return lit.bool(literal.value)
		case "text":
		case "uuid":
		case "sha256":
		case "date":
		case "inet":
		case "cidr":
			return lit.text(literal.value, sqlType)
		case "handle":
			return lit.int(BigInt(codeOf(literalCodec(names, type), literal.handle)), sqlType)
		case "handles":
			return lit.bits(handlesHex(literalCodec(names, type), literal.handles), sqlType)
		case "span":
			return lit.text(spanLiteralText(literal, type), sqlType)
		case "vector":
			return lit.text(vectorPayload(literal.value), sqlType)
		case "pattern":
			throw defect("a pattern literal is lowered where its match reads it, as its ARE (patternAre)")
	}
}

const exprLabel = (expr: ScalarExpr): string => `expression ${expr.id} (${expr.kind})`

/**
 * Where a scalar expression is lowered, everything its SQL varies by (lowerScalar): a query's lowering, whose leaves are
 * its environment's columns and its declared parameters (querySite), or a persistent expression's, a CHECK's, a domain
 * CHECK's, an index predicate's or a STORED generated column's, whose leaves are its row's installed columns or a
 * domain's VALUE, which folds each constant subterm to its value (physical/ddl/expr.ts persistentSite). Every node is
 * one SQL node in both, through the one switch of lowerScalar, and every literal one spelling (lowerLiteral).
 */
export interface ScalarSite {
	readonly names: PhysicalNames
	/** Where a refusal of `expr` is reported. */
	readonly at: (expr: ScalarExpr) => SourceLoc
	/** A column, VALUE or a parameter, as the site reads it. */
	readonly leaf: (expr: ScalarExpr & { readonly kind: "column" | "value" | "param" }) => Expr
	/** The type a cast or a domain cast into `type` names. */
	readonly castType: (type: ScalarType, expr: ScalarExpr) => TypeRef
	/** The SQL of `expr` that the site writes otherwise than its node, or undefined for its node's own. */
	readonly whole: (expr: ScalarExpr) => Expr | undefined
}

/** A refusal at `expr`'s place in `site`. */
const refuseIn = (site: ScalarSite, expr: ScalarExpr, tag: ProseTag, capability: string): never =>
	refuseAt(tag, site.at(expr), capability)

/**
 * The SQL of the scalar expression `expr` at `site`.
 *
 * One IR node is one scalar operation, so each lowers to its SQL wherever it stands: a column, VALUE and a parameter as
 * the site reads them, a literal typed by its base, an operator its catalog form (an exact one in its exact space and
 * an IEEE 754 one natively where proved and by its guarded form otherwise, ops.ts totalForm), a cast `x::type` (a
 * rounding into a float as total.ts ieeeForm chooses, which only a query holds: a check refuses it, compute/lower.ts),
 * a domain cast `x::domain`, a conditional CASE with its ELSE, and a closed read or membership test a read of its
 * relation's installed constants (`closedRead`). No NULL and no COALESCE is produced, and NULLIF only by C.at, whose
 * absent key reads NULL, and by a persistent site's boolean NULL.
 */
export const lowerScalar = (expr: ScalarExpr, site: ScalarSite): Expr => {
	const whole = site.whole(expr)
	if (whole !== undefined) {
		return whole
	}
	const lower = (a: ScalarExpr): Expr => lowerScalar(a, site)
	switch (expr.kind) {
		case "column":
		case "value":
		case "param":
			return site.leaf(expr)
		case "literal":
			return lowerLiteral(site.names, expr.value, expr.type)
		case "cast": {
			const inner = lower(expr.args[0])
			if (isDateParse(expr.cast)) {
				return dateOfText(inner, datePartSlices)
			}
			const ieee = ieeeForm(expr, [inner])
			if (ieee?.kind === "guarded") {
				return (
					ieee.sql ??
					refuseIn(
						site,
						expr,
						"UnsupportedOperation",
						`an IEEE 754 rounding into ${baseOf(expr.type).carrier}`
					)
				)
			}
			return cast(inner, site.castType(expr.type, expr))
		}
		case "domainCast":
			return cast(lower(expr.args[0]), site.castType(expr.type, expr))
		case "cond": {
			const chain = equalityChain(expr)
			if (chain !== undefined) {
				const simple = simpleCase(chain, lower)
				if (simple !== undefined) {
					return simple
				}
			}
			const [when, result, otherwise] = expr.args
			return {
				kind: "case",
				whens: [{ when: lower(when), result: lower(result) }],
				else: lower(otherwise),
				operand: undefined
			}
		}
		case "op": {
			const member = membershipOf(expr)
			if (member !== undefined) {
				return memberTest(site, member, lower)
			}
			const args =
				"patterns" in expr
					? matchOperands(expr, {
							lower,
							whole: site.whole,
							are: (read) =>
								closedRead(site, read, read.args.map(lower), { kind: "are", field: read.field }),
							spelling: site.names.spellings.of
						})
					: expr.args.map(lower)
			const zoned = nativeOp(expr.op)?.sql
			if (zoned?.kind === "zoneLibrary") {
				return zoneCall(site, expr, zoned.fn, args)
			}
			const operandTypes = [expr.type, ...expr.args.map((a) => a.type)]
			if (operandTypes.some((t) => spanCarrierOf(t) !== undefined)) {
				return lowerSpanOp(expr, args, site.at(expr), site.names.library)
			}
			if (operandTypes.some((t) => t.carrier === "vector")) {
				return lowerVectorOp(expr, args, site.at(expr), site.names.vectorSchema)
			}
			if (operandTypes.some((t) => t.carrier === "tsvector")) {
				return lowerSearchOp(expr, args, site.at(expr))
			}
			return (
				defaultOps(expr, args, site.names.library) ??
				refuseIn(
					site,
					expr,
					"UnsupportedOperation",
					`a lowering for the operation ${describeOp(expr.op)} over ${args.length} operand(s)`
				)
			)
		}
		case "closedAt":
		case "closedRow":
		case "closedHas":
			return closedRead(
				site,
				expr,
				expr.args.map(lower),
				expr.kind === "closedAt"
					? { kind: "at", field: expr.field }
					: expr.kind === "closedRow"
						? { kind: "row" }
						: { kind: "has" }
			)
		case "call":
			return declaredCall(site, expr, expr.args.map(lower))
	}
}

/**
 * A call of a library function over a zone (scalar/compute/registry.ts zoneWall): its operands as they are but the last,
 * a zone roster's closed id, which reaches the function as its handle, the zone's IANA name, read from its roster's names
 * constant by its code, `(names())[z + 1]::text` (sql/constants.ts nameOf), NULL where the code is.
 */
const zoneCall = (
	site: ScalarSite,
	expr: ExprOf<"op">,
	fn: LibraryFn,
	args: ReadonlyArray<Expr>
): Expr => {
	const zoneAt = expr.args.length - 1
	const roster = rosterOf(expr.args[zoneAt]?.type ?? expr.type)
	const zone = args[zoneAt]
	if (roster === undefined || zone === undefined || args.length !== expr.args.length) {
		return refuseIn(
			site,
			expr,
			"UnsupportedOperation",
			`a zone's closed id as ${describeOp(expr.op)}'s last operand`
		)
	}
	const names = site.names.rosterNames(roster.closed)
	const library = site.names.library(fn)
	return qualifiedCall(library.schema, library.name, [
		...args.slice(0, zoneAt),
		nameOf({ schema: names.schema, name: names.name }, zone)
	])
}

/** A membership test's operands: the code it asks for and the set it asks of. */
interface Membership {
	readonly code: ScalarExpr
	readonly set: ScalarExpr
}

/**
 * A membership test, `Bits.subset(Bits.singleton(c), s)`: the subset test whose first operand is the empty set
 * with one code's bit set, which is what Bits.singleton types (scalar/compute/typing.ts singleton). Its code and
 * its set; none for any other node.
 */
const membershipOf = (expr: ExprOf<"op">): Membership | undefined => {
	const [singleton, set] = expr.args
	if (
		nativeOp(expr.op)?.fn !== "subset" ||
		set === undefined ||
		singleton?.kind !== "op" ||
		nativeOp(singleton.op)?.fn !== "adjoin"
	) {
		return undefined
	}
	const [empty, code] = singleton.args
	return empty?.kind === "literal" &&
		empty.value.kind === "handles" &&
		empty.value.handles.length === 0 &&
		code !== undefined
		? { code, set }
		: undefined
}

/**
 * A membership test as the one bit it reads, never a set built and compared (a singleton's set_bit, a complement, an
 * AND and a bit_count).
 *
 * - Over a closed relation's row of a prefix, C.row(k…), it is the relation's key set's bit at the completed key,
 *   C.has(k…, c) (sql/constants.ts closedRead), which is bit c of the row. c is a code of the row's roster, or a slot
 *   code that the read guards below its owner's count, so the completed key's cell is the row's c-th; a prefix the
 *   relation completes nowhere, and a slot code past its owner's count, read absent, so false.
 * - Over any other set, it is `get_bit(s, c::integer) = 1`: bit c from the left is code c's. c is a live code of the
 *   set's roster, below its width, so get_bit never reads past the string.
 *
 * Either is NULL where the code or the set is NULL, as the subset test of a singleton is. A row the site folds to its
 * value is read as any other set is.
 */
const memberTest = (
	site: ScalarSite,
	{ code, set }: Membership,
	lower: (a: ScalarExpr) => Expr
): Expr =>
	set.kind === "closedRow" && site.whole(set) === undefined
		? closedRead(site, set, [...set.args.map(lower), lower(code)], { kind: "has" })
		: eq(
				call("get_bit", [lower(set), cast(lower(code), types.integer)]),
				lit.int(1n, types.integer)
			)

/**
 * A conditional chain of equalities of one subject to literals (share.ts equalityChain) as one simple CASE over the
 * subject, `CASE s WHEN v1 THEN a1 WHEN v2 THEN a2 … ELSE otherwise END`, which evaluates `s` once: PostgreSQL compares
 * each WHEN's value to the subject by the `=` that `s = v` names, so the chain is the CASE wherever each of its tests
 * lowers to that `=`; undefined where one lowers otherwise, which the chain's conditionals then print as they are.
 */
const simpleCase = (
	chain: NonNullable<ReturnType<typeof equalityChain>>,
	lower: (a: ScalarExpr) => Expr
): Expr | undefined => {
	const [first, ...rest] = chain.whens
	if (first === undefined) {
		return undefined
	}
	const plain = chain.whens.every((w) => {
		const test = lower(w.condition)
		return test.kind === "binary" && test.op === "="
	})
	const when = (w: (typeof chain.whens)[number]) => ({
		when: lower(w.value),
		result: lower(w.result)
	})
	return plain
		? {
				kind: "case",
				operand: lower(chain.subject),
				whens: [when(first), ...rest.map(when)],
				else: lower(chain.otherwise)
			}
		: undefined
}

/**
 * How a site lowers what a Text.matches pattern reads (patternAre): any subterm, a subterm it folds to its value,
 * a str.pattern payload's ARE read by key, and the spelling the installation installs a pattern written as one as
 * (ir/pattern.ts InstalledSpellings `of`).
 */
export interface PatternLowering {
	readonly lower: (e: ScalarExpr) => Expr
	readonly whole: (e: ScalarExpr) => Expr | undefined
	readonly are: (read: ScalarExpr & { readonly kind: "closedAt" }) => Expr
	readonly spelling: (spelling: string) => string
}

/**
 * A Text.matches node's operands as `~` reads them: its subject's SQL, and its pattern in the ARE PostgreSQL reads
 * (patternAre).
 */
export const matchOperands = (expr: ScalarExpr, lowering: PatternLowering): ReadonlyArray<Expr> => {
	const [subject, pattern] = expr.args
	if (subject === undefined || pattern === undefined || expr.args.length !== 2) {
		throw defect("a Text.matches node reads its subject and its pattern")
	}
	return [lowering.lower(subject), patternAre(pattern, lowering)]
}

/**
 * A Text.matches pattern lowered as its ARE, the one PostgreSQL's `~` reads, never as its source, which only
 * grizzle's own automaton reads: a literal's ARE of the spelling the installation installs its language as
 * (scalar/regex/admit.ts matchAre, PatternLowering `spelling`), so one language is one ARE whatever spells it, as is a pattern the
 * site folds to a literal (physical/ddl/expr.ts), so no expression compares two constants, which a generation expression refuses
 * (42P22); a str.pattern payload's ARE read by its key from the relation's ARE dictionary (sql/constants.ts
 * closedRead), translated where the constants were planned; and a Logic.cond of them, each arm its ARE. Typing admits
 * no other pattern (scalar/compute/typing.ts patternParts), so the match translates nothing as it runs and states no
 * table of translations.
 */
const patternAre = (pattern: ScalarExpr, lowering: PatternLowering): Expr => {
	const whole = lowering.whole(pattern)
	if (whole !== undefined) {
		if (whole.kind !== "literal" || whole.value.kind !== "text") {
			throw defect("a folded Text.matches pattern is a text literal")
		}
		return lit.text(matchAre(lowering.spelling(whole.value.value)), types.text)
	}
	switch (pattern.kind) {
		case "literal":
			if (pattern.value.kind !== "pattern") {
				throw defect("a Text.matches pattern literal is a pattern value")
			}
			return lit.text(matchAre(lowering.spelling(pattern.value.value.spelling)), types.text)
		case "closedAt":
			return lowering.are(pattern)
		case "cond": {
			const [when, result, otherwise] = pattern.args
			return {
				kind: "case",
				whens: [{ when: lowering.lower(when), result: patternAre(result, lowering) }],
				else: patternAre(otherwise, lowering),
				operand: undefined
			}
		}
		case "column":
		case "value":
		case "param":
		case "op":
		case "cast":
		case "domainCast":
		case "closedRow":
		case "closedHas":
		case "call":
			throw defect(
				"a Text.matches pattern is a literal, a str.pattern payload or a Logic.cond of them"
			)
	}
}

/**
 * Fn.call(f, args) of a declared function that returns a value: the function's call, each argument cast to its
 * declared type's base, the type the function takes it at, and its value cast to the type its declared field's values
 * are stored as (ir/physical.ts fieldColumnType), whose domain PostgreSQL checks it at, a closed id's roster's among
 * them, where a NULL value is refused through the installation's refusal function (SQLSTATE
 * 22004, null_value_not_allowed), since grizzle holds no NULL:
 *
 *   COALESCE(<level>.<f>(<a>::<base>, ...), CASE WHEN <level>.__refuse('22004', '<f>', ...) THEN <the call> ELSE
 *     <the call> END)::<type>
 *
 * COALESCE reads its second argument only where its first is NULL, and the refusal raises there, so the function is
 * called once and the CASE's branches, which state the value's type, are never read.
 *
 * A strict function's call (nonNull "strict") is NULL where an argument is NULL, its body never run there, so its
 * refusal stands only where every argument is a value: a first WHEN, `pg_catalog.num_nonnulls(<a>::<base>, ...) < n
 * THEN <the call>`, which CASE reads before the refusal and whose call, at a NULL argument, PostgreSQL answers NULL
 * without running the body. A function of no argument has no NULL argument, so its call has no such WHEN.
 */
const declaredCall = (
	site: ScalarSite,
	expr: ScalarExpr & { readonly kind: "call" },
	args: ReadonlyArray<Expr>
): Expr => {
	const fn = site.names.declaredFunction(expr.function.name)
	const value = qualifiedCall(
		fn.ref.schema,
		fn.ref.name,
		args.map((a, i) => {
			const param = expr.params[i]
			if (param === undefined) {
				throw defect("a call's argument at each of its declared parameters")
			}
			return cast(a, physicalBaseType(site.names, param))
		})
	)
	const refused = qualifiedCall(site.names.refusal.schema, site.names.refusal.name, [
		lit.text(sqlstates.nullValueNotAllowed, types.text),
		lit.text(expr.function.name, types.text),
		lit.text(`function ${expr.function.name} returned NULL`, types.text)
	])
	const refusal = { when: refused, result: value }
	const whens =
		expr.nonNull === "strict" && value.args.length > 0
			? ([
					{
						when: binary(
							"<",
							call("num_nonnulls", value.args),
							lit.int(value.args.length, types.integer)
						),
						result: value
					},
					refusal
				] as const)
			: ([refusal] as const)
	return cast(
		{
			kind: "coalesce",
			args: [value, { kind: "case", operand: undefined, whens, else: value }]
		},
		fieldColumnType(site.names, expr.type).type
	)
}

/**
 * A query's site (lowerScalar): a column is its qualified reference in `env`, a parameter its typed placeholder, and
 * VALUE is refused. Types: a comparison parameter is cast to its base type and a written or emitted one to its domain,
 * which the IR records as the parameter's type; a literal is typed by its base, since its refinement was checked at
 * compile time (the ContractLiteral check); a domain cast always names the domain, because the database validation it
 * carries is its point.
 */
const querySite = (cx: LowerContext, env: Env): ScalarSite => ({
	names: cx.names,
	at: (expr) => loweringAt(exprLabel(expr)),
	leaf: (expr) => {
		const at = exprLabel(expr)
		switch (expr.kind) {
			case "column":
				return (
					env.columns.get(expr.column.node)?.get(expr.column.name) ??
					refuse(
						"MalformedDescription",
						at,
						`a column ${expr.column.node}.${expr.column.name} of a node in scope`
					)
				)
			case "value":
				return refuse("MalformedDescription", at, "VALUE only inside a contract predicate")
			case "param":
				return cx.scalarParam(expr.param, expr.type, at)
		}
	},
	castType: (type) => cx.typeRef(type),
	whole: () => undefined
})

/**
 * The SQL of the expression `expr`, evaluated where `env` is in scope: lowerScalar at its query's site, of the
 * expression with its shared subterms evaluated once (share.ts sharedExpr), each rewrite measured at the site with
 * every parameter a stand-in of its type, so no measure allocates a placeholder of the statement.
 */
export const lowerExpr = (cx: LowerContext, expr: ScalarExpr, env: Env): Expr => {
	const site = querySite(cx, env)
	const measured: ScalarSite = {
		...site,
		leaf: (e) =>
			e.kind === "param" ? slotParam(positionalValue(0), cx.typeRef(e.type)) : site.leaf(e)
	}
	return lowerScalar(
		sharedExpr(expr, {
			closed: cx.names.closedRelations,
			host: closedLeaf(cx.names.closedIndex),
			size: (e) => printedSize(() => lowerScalar(e, measured))
		}),
		site
	)
}

/** The length of the SQL text `lowered` prints, or undefined where lowering it refuses. */
export const printedSize = (lowered: () => Expr): number | undefined => {
	const sql = catchRefusal(lowered)
	return sql.ok ? printExpr(sql.value).length : undefined
}

/**
 * A closed read as its relation's installed constants answer it (sql/constants.ts closedRead), its arguments the codes
 * of the key fields it fixes, in key order, as SQL: C.at's payload field, a str.pattern payload's ARE, C.row's
 * completions, or C.has's membership test, which the closed rewrite (lower/optimize/closed) also states. Every argument is a code its column's roster domain proves below
 * its roster's size, and a slot code past its owner's count reads the first cell past the string, so no index aliases
 * a neighbour's and an index past the string reads absent.
 */
const closedRead = (
	site: ScalarSite,
	expr: ScalarExpr & { readonly kind: "closedAt" | "closedRow" | "closedHas" },
	args: ReadonlyArray<Expr>,
	read: ClosedRead
): Expr => {
	const lowered = closedReadOf(
		site.names.closed(expr.relation),
		expr.relation,
		read,
		args,
		physicalBaseType(site.names, expr.type)
	)
	return lowered.ok ? lowered.value : refuseIn(site, expr, "MalformedDescription", lowered.error)
}
