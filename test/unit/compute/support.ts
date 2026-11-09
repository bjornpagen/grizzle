import { Array as Arr, Record as Rec } from "effect"
import { canonicalTag } from "#compiler/core/canonical.ts"
import {
	bitsColumn,
	bytesColumn,
	codeColumn,
	type Column,
	convertColumn
} from "#compiler/core/decoder.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { NodeId, ParamId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { type Codebook, codecOf, codeOf, firstCodebook } from "#compiler/ir/codes.ts"
import type { ExprDesc, FieldDesc, LiteralDesc, Spelled } from "#compiler/ir/desc.ts"
import { describeOp, type ExprSpec, type ScalarExpr, type TypedLiteral } from "#compiler/ir/expr.ts"
import type { BuilderScope, OpenExpr } from "#compiler/ir/open.ts"
import type { Fact } from "#compiler/ir/proof.ts"
import {
	baseOf,
	type Carrier,
	contractOf,
	Roster,
	rosterOf,
	type ScalarType
} from "#compiler/ir/scalar.ts"
import { defaultOps } from "#compiler/lower/conservative/expr/ops.ts"
import { ieeeForm } from "#compiler/lower/conservative/expr/total.ts"
import { spellExpr } from "#compiler/query/build/walk.ts"
import { scalarTerm } from "#compiler/scalar/compute/builders.ts"
import {
	type Lowered,
	type LowerEnv,
	type LowerParams,
	lowerPredicate,
	lowerTerm,
	noClosedRelations,
	type ParamRef
} from "#compiler/scalar/compute/lower.ts"
import { exprEmitter } from "#compiler/scalar/compute/lower.ts"
import { plainColumns } from "#compiler/scalar/compute/tables.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { contractPredicateTable } from "#compiler/scalar/compute/total.ts"
import { anyNumeric } from "#compiler/scalar/compute/types.ts"
import { type ScalarEnv, type SqlTag, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { spanColumn } from "#compiler/scalar/span.ts"
import { convertByCarrier } from "#compiler/scalar/values/convert.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import type { Expr, TypeRef } from "#compiler/sql/ast.ts"
import { noExtension } from "#test/support/compute.ts"

import {
	builtinType,
	lit,
	namedType,
	numericType,
	positionalValue,
	types
} from "#compiler/sql/build.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { textLookup } from "#compiler/text/refinement.ts"
import { succeeded } from "#test/support/assert.ts"
import { textDesc } from "#test/support/fixtures/ir/desc.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { referencePatterns } from "#test/support/oracle/reference/evaluate.ts"
import { testTypeSchema } from "#test/support/sql.ts"

/** An operand as the Compute catalogue reads one: its SQL type, its column and its ScalarType. */
export interface TestOperand {
	readonly sql: SqlTag
	readonly column: Column<unknown>
	readonly scalar: ScalarType
}

/** A field descriptor: an operand with the Description a declaration states it by. */
export interface TestField extends TestOperand {
	readonly desc: FieldDesc
}

/** The closed types a test field's handle names, by name: Mood, the aggregate suite's (test/pg/compute). */
const rosters: ReadonlyMap<string, NonEmptyReadonlyArray<string>> = new Map<
	string,
	NonEmptyReadonlyArray<string>
>([["Mood", ["sad", "ok", "happy"]]])

/** The codes a fresh installation gives the declared rosters, which a handle literal renders as. */
const testCodes: Codebook = firstCodebook(
	Arr.map([...rosters], ([closed, handles]) => new Roster(parsedName(closed), handles))
)

/**
 * A schema's environment over the declared rosters, and each contract's predicate table as the checker lowers it, with
 * the reference evaluator's regex membership and the text analysis of a pattern a predicate computes.
 */
const testEnv: ScalarEnv = {
	kind: "schema",
	roster: (name) => {
		const handles = rosters.get(name)
		return handles === undefined ? undefined : new Roster(name, handles)
	},
	contractPredicate: (predicate, base, name, facts) =>
		contractPredicateTable(predicate, base, name, facts, {
			loc: SourceLoc(`contract ${name}`, []),
			fieldType: (d) => scalarTypeOf(d, testEnv, SourceLoc(`contract ${name}`, [])),
			patterns: referencePatterns(),
			patternLanguage: textLookup
		})
}

/** The ScalarType of a FieldDesc, as the descriptor registry reads it in a schema (scalar/registry.ts scalarTypeOf). */
export const scalarOfDesc = (desc: FieldDesc): ScalarType =>
	succeeded(scalarTypeOf(desc, testEnv, SourceLoc("a test field", [])))

/**
 * The column of a FieldDesc, as its descriptor builder makes it: its carrier's conversion, its roster's handles, a
 * span's over its endpoint's, a contract's base's (unbranded: no test decodes a contract's values).
 */
const columnOf = (desc: FieldDesc): Column<unknown> => {
	switch (desc.kind) {
		case "pg":
			return plainColumns[desc.type]
		case "numeric":
			return plainColumns.numeric
		case "uuid":
			return plainColumns.uuid
		case "text":
			return plainColumns.text
		case "closedId": {
			const handles = rosters.get(desc.roster)
			if (handles === undefined) {
				throw new Error(`no roster ${desc.roster}`)
			}
			return codeColumn(desc.roster, handles)
		}
		case "bits":
			return bitsColumn(desc.roster)
		case "bytes":
			return bytesColumn
		case "vector":
			return convertColumn(
				convertByCarrier.vector({ carrier: "vector", dimensions: desc.dimensions })
			)
		case "span":
			return spanColumn(columnOf(desc.endpoint))
		case "contract":
			return columnOf(desc.base)
	}
}

/**
 * Shared helpers for the Compute tests.
 *
 * Field descriptors here carry the Description, the SQL type and the column every descriptor carries, which is all
 * the Compute catalogue reads from one, and the ScalarType the descriptor registry reads from the Description
 * (scalar/registry.ts scalarTypeOf) in a schema's environment: the rosters declared here, every pattern as
 * written, and each contract's predicate table, built by contractPredicateTable as the checker builds it. renderSql
 * prints a lowered expression tree as PostgreSQL text through the SQL AST printer, so a test can run exactly what the
 * registry names.
 */
export const field = (desc: FieldDesc, sql: SqlTag): TestField => ({
	sql,
	column: columnOf(desc),
	desc,
	scalar: scalarOfDesc(desc)
})

export const testPg = {
	smallint: field({ kind: "pg", type: "smallint" }, "smallint"),
	integer: field({ kind: "pg", type: "integer" }, "integer"),
	bigint: field({ kind: "pg", type: "bigint" }, "bigint"),
	real: field({ kind: "pg", type: "real" }, "real"),
	double: field({ kind: "pg", type: "double precision" }, "double precision"),
	money: field({ kind: "pg", type: "money" }, "money"),
	boolean: field({ kind: "pg", type: "boolean" }, "boolean"),
	/**
	 * The widest numeric the compute suites declare: numeric(1000, 20), its 980 integer and 20 fraction digits holding
	 * every operand they draw. No numeric field is without a typmod, so none holds an infinity.
	 */
	numeric: field({ kind: "numeric", precision: 1000, scale: 20 }, "numeric"),
	numericOf: (precision: number, scale: number) =>
		field({ kind: "numeric", precision, scale }, "numeric"),
	/**
	 * A computed numeric at numeric's own limits (types.ts anyNumeric): the type of an operand reaching every finite
	 * value PostgreSQL's numeric holds, as a derived relation's inferred column or a Compute.numeric conversion does. No
	 * declaration states one, so it is an operand with no Description, never a field.
	 */
	computedNumeric: { sql: "numeric", column: plainColumns.numeric, scalar: anyNumeric },
	uuid: field({ kind: "uuid" }, "uuid"),
	text: field(textDesc("^.*$", "su"), "text"),
	regex: (source: string, flags: "u" | "su") => field(textDesc(source, flags), "text")
} as const

/**
 * A term's expression as a Description states it: a variable `v` made spelled by its field, a parent variable by its
 * column and an interior stage by its id.
 */
export const spelledExpr = (expr: OpenExpr): ExprDesc =>
	spellExpr(expr, {
		var: (ref) => ref.field,
		parent: (ref) => ref.column,
		interior: (ref) => ref.id
	})

/**
 * A contract over a base with a predicate built from the value's comparisons, or none, declaring the facts its
 * predicate proves.
 */
export const testDeclaringContract = (
	name: string,
	base: TestField,
	predicate: ((v: ScalarTerm) => { readonly expr: OpenExpr }) | undefined,
	facts: ReadonlyArray<Fact>
): TestField => {
	const built = predicate?.(scalarTerm({ kind: "value" }, base.scalar, base)).expr
	return field(
		{
			kind: "contract",
			name,
			base: base.desc,
			predicate: built === undefined ? undefined : spelledExpr(built),
			facts
		},
		base.sql
	)
}

/** A contract over a base with a predicate built from the value's comparisons, or none, declaring no facts. */
export const testContract = (
	name: string,
	base: TestField,
	predicate: ((v: ScalarTerm) => { readonly expr: OpenExpr }) | undefined
): TestField => testDeclaringContract(name, base, predicate, [])

export const testSpan = (endpoint: TestField): TestField =>
	field({ kind: "span", endpoint: endpoint.desc, width: undefined }, "range")

/** The build the variables `v` makes belong to, which runs as long as the tests do. */
const testBuild: BuilderScope = { active: true }

/** A rule variable of an operand's type, which `spelledExpr` names `name`. */
export const v = (name: string, of: TestOperand): ScalarTerm =>
	scalarTerm(
		{
			kind: "var",
			var: {
				build: testBuild,
				owner: "adopted",
				scope: { name, loc: SourceLoc(`v ${name}`, []) },
				field: name,
				origin: undefined,
				loc: SourceLoc(`v ${name}`, [])
			}
		},
		of.scalar,
		of
	)

/** A parameter, as r.param makes one: a term over the parameter, of its declared type. */
export const param = (name: string, of: TestField): ScalarTerm =>
	scalarTerm({ kind: "param", name, type: of.desc }, of.scalar, of)

/**
 * An env's variables: each a column of node n0; a literal of a field's type, as Compute.literal makes one; or a bare
 * literal, which states no type and so has the one its kind gives it, a Decimal's a computed numeric at numeric's own
 * limits (lower.ts bareLiteral). lowerWith lowers a literal binding as that literal (withLiterals).
 */
export type LeafBinding =
	| { readonly kind: "column"; readonly type: ScalarType }
	| { readonly kind: "literal"; readonly field: TestField; readonly value: LiteralDesc }
	| { readonly kind: "bare"; readonly value: LiteralDesc }

/** An emitter under fresh labels `x#n` (lower.ts exprEmitter), and every expression it emitted, in emission order. */
export interface Sink {
	readonly emit: (spec: ExprSpec) => ScalarExpr
	readonly emitted: ReadonlyArray<ScalarExpr>
}

export const sink = (): Sink => {
	const emitter = exprEmitter("x")
	const emitted: Array<ScalarExpr> = []
	return {
		emit: (spec) => {
			const e = emitter(spec)
			emitted.push(e)
			return e
		},
		emitted
	}
}

/** A parameter of its declared type, bound as the type's base. */
const bindAsBase = ({
	name,
	type
}: ParamRef<Spelled>): Result.Result<
	{ readonly spec: ExprSpec; readonly type: ScalarType },
	CompileError
> => {
	const declared = scalarOfDesc(type)
	return Result.ok({
		spec: {
			kind: "param",
			param: ParamId(name),
			role: "compare",
			args: [],
			type: baseOf(declared),
			nonNull: "codec"
		},
		type: declared
	})
}

export const baseParams: LowerParams<Spelled> = { kind: "scope", lower: bindAsBase }

const env = (
	mode: LowerEnv["mode"],
	vars: Readonly<Record<string, LeafBinding>>,
	emit: (spec: ExprSpec) => ScalarExpr,
	params: LowerParams<Spelled>
): LowerEnv => {
	const common = commonEnv(vars, emit, params)
	switch (mode) {
		case "query":
			return {
				...common,
				mode,
				patternLanguage: textLookup,
				extension: noExtension
			}
		case "check":
			return { ...common, mode, patternLanguage: textLookup }
		case "build":
			return { ...common, mode }
	}
}

/** The name a leaf is bound by in an env's variables: a variable's, a field's, or VALUE's and a parent column's kind. */
const leafName = (
	desc:
		| { readonly kind: "var"; readonly var: string }
		| { readonly kind: "field"; readonly field: string }
		| {
				readonly kind: "value" | "parent"
		  }
): string => (desc.kind === "var" ? desc.var : desc.kind === "field" ? desc.field : desc.kind)

/**
 * `e` with each leaf `vars` binds to a literal replaced by that literal, at its field's type, the node Compute.literal
 * makes, or at none, a bare literal's, so the lowering types it as a literal, its bounds and facts its own value's, as
 * the product lowers every literal; a leaf bound to a column stays a leaf.
 */
const withLiterals = (e: ExprDesc, vars: Readonly<Record<string, LeafBinding>>): ExprDesc => {
	const go = (x: ExprDesc): ExprDesc => withLiterals(x, vars)
	switch (e.kind) {
		case "var":
		case "field":
		case "value":
		case "parent": {
			const binding = vars[leafName(e)]
			if (binding === undefined || binding.kind === "column") {
				return e
			}
			return {
				kind: "literal",
				value: binding.value,
				type: binding.kind === "literal" ? binding.field.desc : undefined
			}
		}
		case "param":
		case "literal":
			return e
		case "compute":
			return { ...e, args: Arr.map(e.args, go) }
		case "cast":
		case "base":
		case "not":
		case "in":
			return { ...e, arg: go(e.arg) }
		case "cond":
			return { ...e, pred: go(e.pred), onTrue: go(e.onTrue), onFalse: go(e.onFalse) }
		case "when":
			return { ...e, subject: go(e.subject), proved: go(e.proved), otherwise: go(e.otherwise) }
		case "compare":
		case "allen":
			return { ...e, left: go(e.left), right: go(e.right) }
		case "between":
			return { ...e, arg: go(e.arg), low: go(e.low), high: go(e.high) }
		case "and":
		case "or":
		case "closedAt":
		case "closedHas":
			return { ...e, args: mapNonEmpty(e.args, go) }
		case "closedRow":
			return { ...e, args: Arr.map(e.args, go) }
		case "pointIn":
			return { ...e, point: go(e.point), span: go(e.span) }
		case "absent":
			return { ...e, bindings: Rec.map(e.bindings, go) }
	}
}

const commonEnv = (
	vars: Readonly<Record<string, LeafBinding>>,
	emit: (spec: ExprSpec) => ScalarExpr,
	params: LowerParams<Spelled>
): Omit<Extract<LowerEnv, { readonly mode: "build" }>, "mode"> => ({
	loc: SourceLoc("test", []),
	emit,
	leaf: (desc, loc) => {
		const name = leafName(desc)
		const binding = vars[name]
		if (binding?.kind !== "column") {
			return Result.err(malformedDescription(loc, `a column named ${name}`))
		}
		return Result.ok({
			kind: "column",
			column: { node: NodeId("n0"), name },
			args: [],
			type: binding.type,
			nonNull: "storage"
		})
	},
	params,
	fieldType: (desc, loc) => scalarTypeOf(desc, testEnv, loc),
	closed: noClosedRelations("the compute suites read no closed relation"),
	patterns: referencePatterns()
})

/** A lowered term or predicate, and every expression its lowering emitted, in emission order. */
export interface LoweredTable {
	readonly emitted: ReadonlyArray<ScalarExpr>
	readonly root: Lowered
}

/**
 * Lowers a term or predicate whose variables are bound to literal values or columns: a literal binding as the literal
 * itself (withLiterals), a column binding as a leaf.
 */
export const lowerWith = (
	mode: LowerEnv["mode"],
	expr: ExprDesc,
	vars: Readonly<Record<string, LeafBinding>>,
	predicate: boolean,
	params: LowerParams<Spelled>
): Result.Result<LoweredTable, CompileError> => {
	const s = sink()
	const e = env(mode, vars, s.emit, params)
	const literal = withLiterals(expr, vars)
	const lowered = predicate ? lowerPredicate(literal, e) : lowerTerm(literal, e)
	return Result.map(lowered, (root) => ({ emitted: s.emitted, root }))
}

/**
 * A literal compared with a column of `type`, lowered in a query predicate: the literal adopts the column's type, so
 * lowering runs the ContractLiteral check of its contract and regex refinement, as a match's literal binding does.
 */
export const adoptedLiteral = (
	value: LiteralDesc,
	type: ScalarType
): Result.Result<Lowered, CompileError> =>
	lowerPredicate(
		{
			kind: "compare",
			op: "eq",
			left: { kind: "var", var: "c" },
			right: { kind: "literal", value, type: undefined }
		},
		env("query", { c: { kind: "column", type } }, sink().emit, baseParams)
	)

const builtinNames: Readonly<Partial<Record<Carrier, TypeRef>>> = {
	int2: builtinType("smallint"),
	int4: builtinType("integer"),
	int8: builtinType("bigint"),
	float4: builtinType("real"),
	float8: builtinType("double precision"),
	money: builtinType("money"),
	bool: builtinType("boolean"),
	uuid: builtinType("uuid"),
	text: builtinType("text"),
	range4: builtinType("int4range"),
	range8: builtinType("int8range"),
	/** A closed id is its code, a smallint, outside a domain. */
	code: builtinType("smallint")
}

export interface RenderOptions {
	/** The domain a contract lowers to, by contract name, or undefined where no contract is rendered. */
	readonly domain:
		| ((testContract: string) => { readonly schema: string; readonly name: string })
		| undefined
	/** The schema the vector extension is installed in. */
	readonly vectorSchema: string
}

/** The rendering of an expression over no contract, the vector extension in vector_ext. */
export const plainRender: RenderOptions = { domain: undefined, vectorSchema: "vector_ext" }

const typeRef = (t: ScalarType, options: RenderOptions): TypeRef => {
	const contract = contractOf(t)
	if (contract !== undefined) {
		if (options.domain === undefined) {
			throw new Error(`no domain for contract ${contract.name}`)
		}
		const d = options.domain(contract.name)
		return namedType(testTypeSchema(d.schema), d.name, [])
	}
	if (t.carrier === "numeric") {
		return t.typmod === undefined ? types.numeric : numericType(t.typmod.precision, t.typmod.scale)
	}
	if (t.carrier === "vector") {
		return namedType(testTypeSchema(options.vectorSchema), "vector", [t.typmod.dims])
	}
	if (t.carrier === "exactInteger") {
		return t.digits <= 18 ? builtinType("bigint") : types.numeric
	}
	if (t.carrier === "exactMoney") {
		return types.numeric
	}
	const ref = builtinNames[t.carrier]
	if (ref === undefined) {
		throw new Error(`no SQL type for ${t.carrier}`)
	}
	return ref
}

const literalExpr = (literal: TypedLiteral, t: ScalarType, options: RenderOptions): Expr => {
	const type = typeRef(baseOf(t), options)
	switch (literal.kind) {
		case "int":
			return { kind: "literal", value: { kind: "int", value: literal.value }, type }
		case "numeric":
			return {
				kind: "literal",
				value: { kind: "decimal", value: literal.value[canonicalTag]().payload },
				type
			}
		case "float":
			return lit.float(literal.value, type)
		case "floatSpecial":
			return { kind: "literal", value: { kind: "floatSpecial", value: literal.value }, type }
		case "money": {
			if (!(literal.value instanceof Money)) {
				throw new Error("a money literal holds a Money")
			}
			const minor = literal.value.minorUnits
			const amount = succeeded(Decimal.fromParts(minor < 0n, minor < 0n ? -minor : minor, 2))
			return {
				kind: "cast",
				expr: {
					kind: "literal",
					value: { kind: "decimal", value: amount.toString() },
					type: types.numeric
				},
				type: builtinType("money")
			}
		}
		case "bool":
			return { kind: "literal", value: { kind: "bool", value: literal.value }, type }
		case "text":
		case "uuid":
		case "date":
			return { kind: "literal", value: { kind: "text", value: literal.value }, type }
		case "handle": {
			const roster = rosterOf(t)
			if (roster === undefined) {
				throw new Error(`a handle literal at ${t.carrier}, no closed id`)
			}
			const code = codeOf(codecOf(testCodes, roster), literal.handle)
			return { kind: "literal", value: { kind: "int", value: BigInt(code) }, type }
		}
		case "handles":
			throw new Error(
				"the compute suites render no set literal: bit(n) has no Compute operand here"
			)
		case "span":
			return {
				kind: "literal",
				value: { kind: "text", value: `[${literal.start},${literal.end})` },
				type
			}
		case "vector":
			return {
				kind: "literal",
				value: { kind: "text", value: literal.value[canonicalTag]().payload },
				type
			}
	}
}

/**
 * The SQL of an expression tree, as grizzle sends it: a literal, a column, VALUE and a parameter in PostgreSQL's own
 * spelling, and every operation and every cast into a float through the product's own forms (lower/conservative/expr:
 * defaultOps, which chooses each overload's exact, IEEE or native form and its operand readings, and ieeeForm, a cast's
 * guarded IEEE 754 rounding unless a kept proof makes it native), so the compute suites run on PostgreSQL the SQL a
 * query holds, against the host evaluator.
 */
export const sqlOf = (root: ScalarExpr, options: RenderOptions): Expr => {
	const go = (e: ScalarExpr): Expr => {
		const args = Arr.map(e.args, go)
		const arg = (i: number): Expr => {
			const a = args[i]
			if (a === undefined) {
				throw new Error(`no operand ${i} of ${e.kind}`)
			}
			return a
		}
		switch (e.kind) {
			case "literal":
				return literalExpr(e.value, e.type, options)
			case "column":
				return { kind: "column", table: "r0", column: e.column.name }
			case "value":
				return { kind: "domainValue" }
			case "param":
				return { kind: "param", slot: positionalValue(1), type: typeRef(e.type, options) }
			case "cast": {
				const ieee = ieeeForm(e, args)
				if (ieee?.kind === "guarded") {
					if (ieee.sql === undefined) {
						throw new Error(`no IEEE 754 rounding into ${baseOf(e.type).carrier}`)
					}
					return ieee.sql
				}
				return { kind: "cast", expr: arg(0), type: typeRef(e.type, options) }
			}
			case "domainCast":
				return { kind: "cast", expr: arg(0), type: typeRef(e.type, options) }
			case "cond":
				return {
					kind: "case",
					whens: [{ when: arg(0), result: arg(1) }],
					else: arg(2),
					operand: undefined
				}
			case "op": {
				const rendered = defaultOps(e, args)
				if (rendered === undefined) {
					throw new Error(`no form of ${describeOp(e.op)} over ${args.length} operand(s)`)
				}
				return rendered
			}
			case "closedAt":
			case "closedRow":
			case "closedHas":
				throw new Error(
					`the compute suites render no closed read: ${e.kind} of ${e.relation} reads an installed constant`
				)
		}
	}
	return go(root)
}

/** The SQL text of the expression tree `root`; a contract predicate's table is parsed first (ir/expr.ts predicateTree). */
export const renderSql = (root: ScalarExpr, options: RenderOptions): string =>
	printExpr(sqlOf(root, options))

export const decimal = (text: string): Decimal => Decimal.of(text)
