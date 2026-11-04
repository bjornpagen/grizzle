import { Array as Arr, Option } from "effect"
import { canonicalTag } from "#compiler/core/canonical.ts"
import { type Column, convertColumn, handleColumn } from "#compiler/core/decoder.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { NodeId, ParamId } from "#compiler/core/ids.ts"
import { formatLoc, SourceLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { ExprDesc, FieldDesc, LiteralDesc, Spelled } from "#compiler/ir/desc.ts"
import { describeOp, type ExprSpec, type ScalarExpr, type TypedLiteral } from "#compiler/ir/expr.ts"
import type { BuilderScope, OpenExpr } from "#compiler/ir/open.ts"
import type { Fact } from "#compiler/ir/proof.ts"
import { baseOf, type Carrier, contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { spellExpr } from "#compiler/query/build/walk.ts"
import { scalarTerm } from "#compiler/scalar/compute/builders.ts"
import { irLiteral } from "#compiler/scalar/compute/literal.ts"
import {
	type LowerEnv,
	type Lowered,
	type LowerParams,
	lowerPredicate,
	lowerTerm,
	noExtension,
	type ParamRef
} from "#compiler/scalar/compute/lower.ts"
import { exprEmitter } from "#compiler/scalar/compute/lower.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"
import { plainColumns } from "#compiler/scalar/compute/tables.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { contractPredicateTable } from "#compiler/scalar/compute/total.ts"
import { withoutSerial } from "#compiler/scalar/compute/types.ts"
import { type ScalarEnv, type SqlTag, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { spanColumn } from "#compiler/scalar/span.ts"
import { convertByCarrier } from "#compiler/scalar/values/convert.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import {
	type BuiltinFunctionName,
	builtinFunctionNames,
	type Expr,
	type TypeRef
} from "#compiler/sql/ast.ts"

import {
	binary,
	builtinType,
	call,
	lit,
	namedType,
	numericType,
	positionalValue,
	types
} from "#compiler/sql/build.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { textLookup } from "#compiler/text/refinement.ts"
import { succeeded } from "#test/support/assert.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import { testTypeSchema } from "#test/support/sql.ts"

export interface TestField {
	readonly sql: SqlTag
	readonly column: Column<unknown>
	readonly desc: FieldDesc
	readonly scalar: ScalarType
}

/** The closed types a test field's handle names, by name: Mood, the aggregate suite's (test/pg/compute). */
const rosters: ReadonlyMap<string, NonEmptyReadonlyArray<string>> = new Map<
	string,
	NonEmptyReadonlyArray<string>
>([["Mood", ["sad", "ok", "happy"]]])

/**
 * A schema's environment over the declared rosters: every pattern as written, and each contract's predicate table as
 * the checker lowers it, with the reference evaluator's regex membership.
 */
const testEnv: ScalarEnv = {
	kind: "schema",
	roster: (name) => rosters.get(name),
	text: textLookup,
	contractPredicate: (predicate, base, name, facts) =>
		contractPredicateTable(predicate, base, name, facts, {
			loc: SourceLoc(`contract ${name}`, []),
			fieldType: (d) => scalarTypeOf(d, testEnv, SourceLoc(`contract ${name}`, [])),
			regexMember: patternMember
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
		case "serial":
			return desc.type === "smallserial"
				? plainColumns.smallint
				: desc.type === "serial"
					? plainColumns.integer
					: plainColumns.bigint
		case "uuid":
			return plainColumns.uuid
		case "text":
			return plainColumns.text
		case "closedId": {
			const handles = rosters.get(desc.roster)
			if (handles === undefined) {
				throw new Error(`no roster ${desc.roster}`)
			}
			return handleColumn(handles)
		}
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
	numeric: field({ kind: "numeric" }, "numeric"),
	numericOf: (precision: number, scale: number) =>
		field({ kind: "numeric", precision, scale }, "numeric"),
	uuid: field({ kind: "uuid" }, "uuid"),
	text: field({ kind: "text", source: "^.*$", flags: "su" }, "text"),
	regex: (source: string, flags: "u" | "su") => field({ kind: "text", source, flags }, "text"),
	serial: field({ kind: "serial", type: "serial" }, "integer"),
	bigserial: field({ kind: "serial", type: "bigserial" }, "bigint")
} as const

/**
 * A term's expression as a Description states it: a variable `v` made spelled by its field, a parent variable by its
 * column and an interior stage by its id.
 */
export const spelled = (expr: OpenExpr): ExprDesc =>
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
			predicate: built === undefined ? undefined : spelled(built),
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

/** A rule variable of a field's type, which `spelled` names `name`. */
export const v = (name: string, of: TestField): ScalarTerm =>
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

/** An env's variables: each a column of node n0 or a literal value. */
export type LeafBinding =
	| { readonly kind: "column"; readonly type: ScalarType }
	| { readonly kind: "literal"; readonly type: ScalarType; readonly value: LiteralDesc }

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
	const declared = withoutSerial(scalarOfDesc(type))
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
			return { ...common, mode, regexMember: patternMember, extension: noExtension }
		case "check":
			return { ...common, mode, regexMember: patternMember }
		case "build":
			return { ...common, mode }
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
		const name = desc.kind === "var" ? desc.var : desc.kind === "field" ? desc.field : desc.kind
		const binding = vars[name]
		if (binding === undefined) {
			return Result.err(malformedDescription(loc, `a variable named ${name}`))
		}
		if (binding.kind === "column") {
			return Result.ok({
				kind: "column",
				column: { node: NodeId("n0"), name },
				args: [],
				type: binding.type,
				nonNull: "storage"
			})
		}
		const typed = irLiteral(binding.value, binding.type)
		if (!typed.ok) {
			throw new Error(`${formatLoc(loc)}: ${typed.error}`)
		}
		return Result.ok({
			kind: "literal",
			value: typed.value.literal,
			args: [],
			type: binding.type,
			nonNull: "literal"
		})
	},
	params,
	fieldType: (desc) => Result.ok(scalarOfDesc(desc))
})

/** A lowered term or predicate, and every expression its lowering emitted, in emission order. */
export interface LoweredTable {
	readonly emitted: ReadonlyArray<ScalarExpr>
	readonly root: Lowered
}

/** Lowers a term or predicate whose variables are bound to literal values or columns. */
export const lowerWith = (
	mode: LowerEnv["mode"],
	expr: ExprDesc,
	vars: Readonly<Record<string, LeafBinding>>,
	predicate: boolean,
	params: LowerParams<Spelled>
): Result.Result<LoweredTable, CompileError> => {
	const s = sink()
	const e = env(mode, vars, s.emit, params)
	const lowered = predicate ? lowerPredicate(expr, e) : lowerTerm(expr, e)
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
	range8: builtinType("int8range")
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
			return { kind: "literal", value: { kind: "text", value: literal.value }, type }
		case "enum":
			return { kind: "literal", value: { kind: "text", value: literal.handle }, type }
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

/** The PostgreSQL builtin a registry operator names. */
const builtinName = (name: string): BuiltinFunctionName =>
	Option.getOrThrowWith(
		Arr.findFirst(builtinFunctionNames, (n) => n === name),
		() => new Error(`no builtin function ${name}`)
	)

/** The SQL AST of the expression tree `root`. */
const sqlOf = (root: ScalarExpr, options: RenderOptions): Expr => {
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
			case "cast":
				return { kind: "cast", expr: arg(0), type: typeRef(e.type, options) }
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
				const op = nativeOp(e.op)
				if (op === undefined) {
					throw new Error(`no operator ${describeOp(e.op)}`)
				}
				const sql = op.sql
				switch (sql.kind) {
					case "infix":
						return sql.owner === "catalog"
							? binary(sql.op, arg(0), arg(1))
							: {
									kind: "binary",
									op: sql.op,
									left: arg(0),
									right: arg(1),
									schema: options.vectorSchema
								}
					case "prefix":
						return { kind: "negate", expr: arg(0) }
					case "function":
						return sql.owner === "catalog"
							? call(builtinName(sql.name), args)
							: {
									kind: "call",
									fn: {
										kind: "qualified",
										schema: options.vectorSchema,
										name: sql.name
									},
									args,
									star: false,
									distinct: false,
									orderBy: [],
									withinGroup: [],
									over: undefined
								}
					case "between":
						return { kind: "between", expr: arg(0), low: arg(1), high: arg(2), not: false }
					case "in":
						return {
							kind: "inList",
							expr: arg(0),
							list: [arg(1), ...args.slice(2)],
							not: false
						}
					case "least":
					case "greatest":
						return { kind: sql.kind, args: [arg(0), ...args.slice(1)] }
					case "and":
					case "or":
						return { kind: sql.kind, args: [arg(0), ...args.slice(1)] }
					case "not":
						return { kind: "not", expr: arg(0) }
					case "cast":
						return { kind: "cast", expr: arg(0), type: typeRef(e.type, options) }
				}
			}
		}
	}
	return go(root)
}

/** The SQL text of the expression tree `root`; a contract predicate's table is parsed first (ir/expr.ts predicateTree). */
export const renderSql = (root: ScalarExpr, options: RenderOptions): string =>
	printExpr(sqlOf(root, options))

export const decimal = (text: string): Decimal => Decimal.of(text)
