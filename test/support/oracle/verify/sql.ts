import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { regex } from "arkregex"
import { Array as Arr, Option, Order, Record as Rec, Result, String as Str } from "effect"
import { CompileError, prose } from "#compiler/core/errors.ts"
import { maxIdentifierBytes } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isDecimal } from "#compiler/core/text.ts"
import { integerRanges } from "#compiler/ir/carriers.ts"
import { operandsAlias } from "#compiler/lower/conservative/expr/total.ts"
import {
	numericMaxPrecision,
	numericMaxScale,
	numericMinScale
} from "#compiler/scalar/values/fault.ts"
import {
	bodyPositionNames,
	builtinFunctions,
	builtinTypeNames,
	type Call,
	type Collation,
	type ColumnDef,
	type CommentTarget,
	type CreateConstant,
	type CreateFunction,
	type CreateTable,
	type Cte,
	type CteBody,
	type Ddl,
	type Delete,
	type Expr,
	type ForeignKeyColumn,
	type FromItem,
	type FunctionCall,
	type Insert,
	type KeyColumn,
	type LiteralValue,
	type Merge,
	type ObjectName,
	type OperandBody,
	type OperandSelect,
	type OrderItem,
	type PlStatement,
	readConditions,
	selectColumns,
	type SelectCore,
	type SqlFunction,
	type SqlStatement,
	type StoredGeneration,
	type StubConstant,
	type TableConstraint,
	tableConstraints,
	type Target,
	type TypeRef,
	type Update,
	functionColumnNames
} from "#compiler/sql/ast.ts"
import { types } from "#compiler/sql/build.ts"
import { type Lexed, lex, type Token } from "#compiler/sql/lexer.ts"
import { placeholderToken, printType, storedSettingValue } from "#compiler/sql/print.ts"

/** r<n>: the generated alias of a relation occurrence or a stage. */
const isGeneratedRelationName = (name: string): boolean =>
	Str.startsWith("r")(name) && isDecimal(Str.slice(1)(name))

/** c<n>: the generated name of a column a stage defines. */
const isGeneratedColumnName = (name: string): boolean =>
	Str.startsWith("c")(name) && isDecimal(Str.slice(1)(name))

type AuditRule =
	| "identifier"
	| "literal"
	| "type"
	| "param"
	| "arity"
	| "naming"
	| "columnList"
	| "context"
	| "positional"
	| "function"
	| "collation"
	| "lex"
	| "null"
	| "outerJoin"
	| "selectStar"
	| "skipLocked"
	| "uncastParam"
	| "untypedLiteral"
	| "checkWithoutIsTrue"
	| "domainCheckRefusingNull"
	| "caseWithoutElse"
	| "emptyList"

interface SqlViolation {
	readonly rule: AuditRule
	/** A path into the statement ("body.targets[0].expr") or a text offset ("offset 42"). */
	readonly where: string
	readonly detail: string
}

/** A bit-string literal's digits: hex alone, in 0-9 and A-F, the one spelling grizzle writes. */
const hexDigits = regex("^[0-9A-F]*$")

/** A closed constant's array's literal: decimal elements, the sentinel -1 among them, each after a comma, in braces. */
const packArray = regex("^\\{((-1|[0-9]+)(,[0-9]+)*)?\\}$")

/** Rules whose violation is SQL the discipline forbids rather than a malformed statement. */
const disciplineRules: ReadonlySet<AuditRule> = new Set<AuditRule>([
	"function",
	"collation",
	"null",
	"outerJoin",
	"selectStar",
	"skipLocked",
	"uncastParam",
	"untypedLiteral",
	"checkWithoutIsTrue",
	"domainCheckRefusingNull",
	"caseWithoutElse"
])

export const violationError = (violation: SqlViolation, label: string): CompileError =>
	CompileError.make(
		prose(
			disciplineRules.has(violation.rule) ? "UnsupportedOperation" : "MalformedDescription",
			SourceLoc(label, [violation.where]),
			`sql ${violation.rule}: ${violation.detail}`
		)
	)

const firstOrOk = (
	violations: ReadonlyArray<SqlViolation>,
	label: string
): Result.Result<void, CompileError> => {
	const first = violations[0]
	return first === undefined ? Result.succeed(undefined) : Result.fail(violationError(first, label))
}

const builtinNames: ReadonlySet<string> = new Set(Rec.keys(builtinFunctions))

/**
 * The rule a call of the builtin function `name` breaks, or undefined for a function of the catalogue. The AST type
 * admits only the catalogue; this holds it for data that bypassed the type, so it reads the name as the string it is.
 * NULLIF and COALESCE are expressions of their own (Expr nullif, Expr coalesce), neither a call.
 */
const builtinCallRule = (name: string): AuditRule | undefined =>
	builtinNames.has(name) ? undefined : "function"

/** A column name as a naming report shows it. */
const shownName = (name: string | undefined): string =>
	name === undefined ? "no name" : `"${name}"`

/** Whether a text is well-formed UTF-16: no surrogate stands alone. */
const isWellFormed = (text: string): boolean => text.isWellFormed()

const isDecimalText = (value: string): boolean => {
	let i = Str.startsWith("-")(value) ? 1 : 0
	let digits = 0
	while (i < value.length && value[i] !== ".") {
		const c = Option.getOrElse(Str.charAt(value, i), () => "")
		if (c < "0" || c > "9") {
			return false
		}
		digits += 1
		i += 1
	}
	if (digits === 0) {
		return false
	}
	if (i === value.length) {
		return true
	}
	i += 1
	let fraction = 0
	while (i < value.length) {
		const c = Option.getOrElse(Str.charAt(value, i), () => "")
		if (c < "0" || c > "9") {
			return false
		}
		fraction += 1
		i += 1
	}
	return fraction > 0
}

/** The integer builtins' ranges, by the name SQL types a literal with (ir/carriers.ts integerRanges). */
const integerBounds: Readonly<Record<string, readonly [bigint, bigint]>> = {
	smallint: integerRanges.int2,
	integer: integerRanges.int4,
	bigint: integerRanges.int8
}

const numericLikeBuiltins: ReadonlySet<string> = new Set([
	"smallint",
	"integer",
	"bigint",
	"numeric",
	"real",
	"double precision",
	"money"
])

/** Where an expression sits, which decides which reference forms it may use. */
interface ExprContext {
	/**
	 * "query": column references are qualified (the printer's scope check, sql/scope.ts, binds each); "ddl": unqualified;
	 * "output": unqualified output names of a set operation, for its ORDER BY; "domain": no column references, VALUE
	 * allowed; "pl": PL/pgSQL expressions outside a query.
	 */
	readonly mode: "query" | "ddl" | "output" | "domain" | "pl"
	/** Whether EXCLUDED is in reach: inside ON CONFLICT. */
	readonly excluded: boolean
	/**
	 * The row images RETURNING may name: only those every returned row has, since PostgreSQL returns NULL for an
	 * absent one. UPDATE has both; DELETE only old; INSERT only new; MERGE old unless it inserts and new unless it
	 * deletes. Undefined outside RETURNING.
	 */
	readonly returningSides: ReadonlySet<"old" | "new"> | undefined
	/**
	 * The row images RETURNING may name under IS TRUE, which reads the NULL of a row lacking one as false: an INSERT's
	 * old besides its new where its ON CONFLICT DO SELECT or DO UPDATE returns the stored row it meets
	 * (`meetsStoredRow`), whose old is that row and is NULL on a row it inserted (PostgreSQL 19 INSERT's RETURNING;
	 * write/insert/protocol.ts's met marker). Undefined where they are `returningSides`.
	 */
	readonly underIsTrue: ReadonlySet<"old" | "new"> | undefined
	/** Whether merge_action() is in reach: inside MERGE ... RETURNING. */
	readonly mergeAction: boolean
	/** Whether the expression is inside PL/pgSQL, where its variables and NEW, OLD and TG_* are defined. */
	readonly pl: boolean
}

/**
 * An expression context of `mode`, inside PL/pgSQL where `pl` says so, with neither EXCLUDED, RETURNING nor
 * merge_action() in reach.
 */
const context = (mode: ExprContext["mode"], pl: boolean): ExprContext => ({
	mode,
	excluded: false,
	returningSides: undefined,
	underIsTrue: undefined,
	mergeAction: false,
	pl
})

/** Where a query body sits: inside PL/pgSQL or not, and whether it is the outermost output, whose names may be public. */
interface BodyContext {
	readonly pl: boolean
	readonly outermost: boolean
}

/**
 * A full query's context: `topLevel` is the statement itself, whose own WITH may hold a data-modifying CTE; never a
 * nested query.
 */
interface SelectContext extends BodyContext {
	readonly topLevel: boolean
}

/**
 * A key's column, and whether it is the key's span: a temporal key's WITHOUT OVERLAPS column or a PERIOD reference's.
 */
interface SpanColumn {
	readonly column: string
	readonly span: boolean
}

const keySpan = (c: KeyColumn): SpanColumn => ({ column: c.column, span: c.withoutOverlaps })
const periodSpan = (c: ForeignKeyColumn): SpanColumn => ({ column: c.column, span: c.period })

const formatPath = (path: ReadonlyArray<string | number>): string => {
	let out = ""
	for (const segment of path) {
		if (typeof segment === "number") {
			out += `[${segment}]`
		} else {
			out += out === "" ? segment : `.${segment}`
		}
	}
	return out === "" ? "statement" : out
}

/** The output width of a query body, when it is known statically. */
const bodyWidth = (body: OperandBody): number => {
	switch (body.kind) {
		case "core":
			return body.targets.length
		case "setOp":
			return bodyWidth(body.arms[0])
		case "select":
			return bodyWidth(body.body)
	}
}

const selectWidth = (select: OperandSelect): number => bodyWidth(select.body)

/**
 * The aliases a set operation's later arm writes, position by position (its own first core's); PostgreSQL ignores
 * them, which is why they must agree with the union's names when present.
 */
const bodyAliases = (body: OperandBody): ReadonlyArray<string | undefined> => {
	switch (body.kind) {
		case "core":
			return Arr.map(body.targets, (target) => target.alias)
		case "setOp":
			return bodyAliases(body.arms[0])
		case "select":
			return bodyAliases(body.body)
	}
}

class StatementAuditor {
	readonly violations: Array<SqlViolation> = []
	/** Each placeholder's type, with its printed form, which every use of the index shares. */
	readonly #params = new Map<number, { readonly type: TypeRef; readonly printed: string }>()
	/** Relation aliases defined in the current SQL statement; a PL/pgSQL body opens one per embedded statement. */
	#defined = new Set<string>()
	readonly #path: Array<string | number> = []
	#paramsAllowed = true

	/** `at`: the path segments below the current place where the violation sits, none for the place itself. */
	report(rule: AuditRule, detail: string, ...at: ReadonlyArray<string | number>): void {
		this.reportAt(rule, detail, at)
	}

	/** A violation at the path `at` below the current one. */
	reportAt(rule: AuditRule, detail: string, at: ReadonlyArray<string | number>): void {
		this.violations.push({ rule, where: formatPath([...this.#path, ...at]), detail })
	}

	/**
	 * The scoped state below is restored after `f` returns; a throw abandons the whole audit, whose auditor is never
	 * read again (auditStatementDetailed builds one per statement).
	 */
	at<A>(segment: string | number, f: () => A): A {
		this.#path.push(segment)
		const out = f()
		this.#path.pop()
		return out
	}

	params(): ReadonlyArray<TypeRef> {
		const out: Array<TypeRef> = []
		for (let n = 1; n <= this.#params.size; n++) {
			const param = this.#params.get(n)
			if (param !== undefined) {
				out.push(param.type)
			}
		}
		return out
	}

	/** Parameters number 1..n with no gap. */
	checkParamNumbering(): void {
		const indices = Arr.sort([...this.#params.keys()], Order.Number)
		for (const [i, index] of indices.entries()) {
			if (index !== i + 1) {
				this.report(
					"param",
					`parameters number $1..$${indices.length} contiguously; $${i + 1} is unused`
				)
			}
		}
	}

	withoutParams(f: () => void): void {
		const saved = this.#paramsAllowed
		this.#paramsAllowed = false
		f()
		this.#paramsAllowed = saved
	}

	/** A fresh naming state for one embedded SQL statement (a PL/pgSQL query), restored afterwards. */
	embedded(f: () => void): void {
		const saved = this.#defined
		this.#defined = new Set()
		f()
		this.#defined = saved
	}

	ident(name: string, what: string, ...at: ReadonlyArray<string | number>): void {
		if (name.length === 0) {
			this.reportAt("identifier", `${what} is empty`, at)
		} else if (Str.includes("\u0000")(name)) {
			this.reportAt("identifier", `${what} contains NUL`, at)
		} else if (!isWellFormed(name)) {
			this.reportAt("identifier", `${what} is not well-formed UTF-16`, at)
		} else if (utf8Length(name) > maxIdentifierBytes) {
			this.reportAt("identifier", `${what} "${name}" exceeds ${maxIdentifierBytes} bytes`, at)
		}
	}

	objectName(name: ObjectName, what: string, at: string | number): void {
		this.ident(name.schema, `${what} schema`, at)
		this.ident(name.name, what, at)
	}

	tableName(table: ObjectName, at: string | number): void {
		if (typeof table === "string") {
			this.ident(table, "carrier", at)
		} else {
			this.objectName(table, "table", at)
		}
	}

	/**
	 * A relation alias the statement defines: r<n>, once per statement. The one other alias is an operation's operand
	 * binding (total.ts operandsAlias), a scalar subquery's own derived row, which every binding names alike.
	 */
	defineRelation(name: string, at: string | number): void {
		this.ident(name, "relation alias", at)
		if (!isGeneratedRelationName(name)) {
			this.report("naming", `relation alias "${name}" is not a generated r<n>`, at)
		}
		if (this.#defined.has(name)) {
			this.report("naming", `relation alias "${name}" is defined twice`, at)
		}
		this.#defined.add(name)
	}

	/**
	 * A column list a stage defines: c<n> names, distinct. An empty list is a relation of no column, which PostgreSQL
	 * spells by leaving the list out and whose columns nothing reads by name.
	 */
	columnList(names: ReadonlyArray<string>, what: string, generated: boolean): ReadonlySet<string> {
		const seen = new Set<string>()
		for (const [i, name] of names.entries()) {
			this.ident(name, `${what} column`, i)
			if (generated && !isGeneratedColumnName(name)) {
				this.report("naming", `${what} column "${name}" is not a generated c<n>`, i)
			}
			if (seen.has(name)) {
				this.report("columnList", `${what} column "${name}" is listed twice`, i)
			}
			seen.add(name)
		}
		return seen
	}

	baseColumns(names: ReadonlyArray<string>, what: string): void {
		const seen = new Set<string>()
		for (const [i, name] of names.entries()) {
			this.ident(name, what, i)
			if (seen.has(name)) {
				this.report("columnList", `${what} "${name}" is listed twice`, i)
			}
			seen.add(name)
		}
	}

	/** The one collation. The type admits nothing else; this holds it for data that bypassed the type. */
	collation(collation: Collation, ...at: ReadonlyArray<string | number>): void {
		if (!isCUtf8(collation)) {
			this.reportAt(
				"collation",
				`the collation "${collation.schema}"."${collation.name}" is not pg_catalog.pg_c_utf8`,
				at
			)
		}
	}

	/**
	 * A column or domain of builtin text names pg_catalog.pg_c_utf8, and nothing else takes a collation: not another
	 * builtin type, and not a named one, whose collation is its own (a text domain carries the fixed one, and a roster's
	 * domain or an extension type takes none).
	 */
	collatable(type: TypeRef, collation: Collation | undefined, what: string): void {
		if (collation !== undefined) {
			this.collation(collation, "collation")
		}
		if (isBuiltinText(type) && collation === undefined) {
			this.report(
				"collation",
				`a ${what} of type ${printType(type)} without COLLATE pg_catalog.pg_c_utf8`
			)
		}
		if (!isBuiltinText(type) && collation !== undefined) {
			this.report(
				"collation",
				`a ${what} of type ${printType(type)}, which takes no collation, with one`
			)
		}
	}

	type(type: TypeRef): void {
		if (type.kind === "named") {
			this.ident(type.schema, "type schema")
			this.ident(type.name, "type name")
			for (const n of Arr.filter(type.typmod, (m) => !Number.isSafeInteger(m))) {
				this.report("type", `type modifier ${n} is not an integer`)
			}
			return
		}
		if (type.precision === undefined) {
			return
		}
		if (
			!Number.isSafeInteger(type.precision) ||
			type.precision < 1 ||
			type.precision > numericMaxPrecision
		) {
			this.report(
				"type",
				`numeric precision ${type.precision} is outside 1..${numericMaxPrecision}`
			)
		}
		if (
			type.scale !== undefined &&
			(!Number.isSafeInteger(type.scale) ||
				type.scale < numericMinScale ||
				type.scale > numericMaxScale)
		) {
			this.report(
				"type",
				`numeric scale ${type.scale} is outside ${numericMinScale}..${numericMaxScale}`
			)
		}
	}

	/** Only a string spells an array's input, '{...}'; a number or a boolean cast to an array fails (22P02). */
	literal(value: LiteralValue, type: TypeRef): void {
		this.at("type", () => {
			this.type(type)
		})
		if (type.array && value.kind !== "text") {
			this.report("literal", `a ${value.kind} literal typed ${printType(type)}`)
			return
		}
		const builtin = type.kind === "builtin" ? type.name : undefined
		switch (value.kind) {
			case "bool":
				if (builtin !== undefined && builtin !== "boolean") {
					this.report("literal", `a boolean literal typed ${builtin}`)
				}
				return
			case "int": {
				if (builtin === undefined) {
					return
				}
				if (!numericLikeBuiltins.has(builtin)) {
					this.report("literal", `an integer literal typed ${builtin}`)
					return
				}
				const bounds = integerBounds[builtin]
				if (bounds !== undefined && (value.value < bounds[0] || value.value > bounds[1])) {
					this.report("literal", `${value.value} is outside the range of ${builtin}`)
				}
				return
			}
			case "decimal":
				if (
					!isDecimalText(value.value) &&
					value.value !== "NaN" &&
					value.value !== "Infinity" &&
					value.value !== "-Infinity"
				) {
					this.report("literal", `"${value.value}" is not an exact decimal`)
				}
				if (builtin !== undefined && !numericLikeBuiltins.has(builtin)) {
					this.report("literal", `a decimal literal typed ${builtin}`)
				}
				if (builtin !== undefined && integerBounds[builtin] !== undefined) {
					this.report("literal", `a decimal literal typed ${builtin}; use an integer literal`)
				}
				return
			case "float":
			case "floatSpecial":
				if (builtin !== undefined && builtin !== "real" && builtin !== "double precision") {
					this.report("literal", `a float literal typed ${builtin}`)
				}
				return
			case "null":
				return
			case "text":
				if (Str.includes("\u0000")(value.value)) {
					this.report("literal", "a text literal contains NUL")
				} else if (!isWellFormed(value.value)) {
					this.report("literal", "a text literal is not well-formed UTF-16")
				}
				return
			case "bits":
				if (!hexDigits.test(value.hex)) {
					this.report("literal", "a bit-string literal of other than hex digits 0-9 and A-F")
				}
				if (builtin !== undefined && builtin !== "bit" && builtin !== "bit varying") {
					this.report("literal", `a bit-string literal typed ${builtin}`)
				}
				if (
					type.kind === "builtin" &&
					type.name === "bit" &&
					value.hex.length * 4 !== type.length
				) {
					this.report("literal", `${value.hex.length} hex digits typed bit(${type.length})`)
				}
				return
		}
	}

	/** A placeholder $`number` cast to `type`: allowed here, numbered from 1, and always cast alike. */
	placeholder(number: number, type: TypeRef): void {
		if (!this.#paramsAllowed) {
			this.report("context", `parameter $${number} where no parameter may appear`)
		}
		this.at("type", () => {
			this.type(type)
		})
		if (!Number.isSafeInteger(number) || number < 1) {
			this.report("param", `parameter index ${number} is not a positive integer`)
			return
		}
		const printed = printType(type)
		const previous = this.#params.get(number)
		if (previous === undefined) {
			this.#params.set(number, { type, printed })
		} else if (previous.printed !== printed) {
			this.report("param", `$${number} is cast to ${previous.printed} and to ${printed}`)
		}
	}

	expr(e: Expr, ctx: ExprContext): void {
		switch (e.kind) {
			case "column":
				this.column(e, ctx)
				return
			case "excluded":
				this.ident(e.column, "EXCLUDED column")
				if (!ctx.excluded) {
					this.report("context", "EXCLUDED outside ON CONFLICT")
				}
				return
			case "returning":
				this.ident(e.column, `${e.side} column`)
				if (ctx.returningSides === undefined) {
					this.report("context", `${e.side}."${e.column}" outside RETURNING`)
				} else if (!ctx.returningSides.has(e.side)) {
					this.report(
						"context",
						`${e.side}."${e.column}" is NULL for some row this statement returns`
					)
				}
				return
			case "param":
				this.placeholder(e.slot.number, e.type)
				return
			case "clock":
				this.at("type", () => {
					this.type(e.type)
				})
				return
			case "literal":
				this.literal(e.value, e.type)
				return
			case "attribute":
				this.ident(e.attribute, "attribute")
				this.at("record", () => {
					this.expr(e.record, ctx)
				})
				return
			case "cast":
			case "collate":
				if (e.kind === "cast") {
					this.at("type", () => {
						this.type(e.type)
					})
				} else {
					this.collation(e.collation)
				}
				this.at("expr", () => {
					this.expr(e.expr, ctx)
				})
				return
			case "access":
				this.at("expr", () => {
					this.expr(e.expr, ctx)
				})
				return
			case "binary":
				if (e.schema !== undefined) {
					this.ident(e.schema, "operator schema")
				}
				this.at("left", () => {
					this.expr(e.left, ctx)
				})
				this.at("right", () => {
					this.expr(e.right, ctx)
				})
				return
			case "negate":
			case "not":
			case "isTrue":
				this.at("expr", () => {
					this.expr(
						e.expr,
						ctx.underIsTrue === undefined ? ctx : { ...ctx, returningSides: ctx.underIsTrue }
					)
				})
				return
			case "complement":
			case "lowerAscii":
				this.at("expr", () => {
					this.expr(e.expr, ctx)
				})
				return
			case "nullif":
				this.at("expr", () => {
					this.expr(e.expr, ctx)
				})
				this.at("absent", () => {
					this.expr(e.absent, ctx)
				})
				return
			case "subscript":
				this.at("array", () => {
					this.expr(e.array, ctx)
				})
				this.at("index", () => {
					this.expr(e.index, ctx)
				})
				return
			case "and":
			case "or":
				if (e.args.length < 2) {
					this.report("arity", `${Str.toUpperCase(e.kind)} of ${e.args.length} operands`)
				}
				this.exprs(e.args, ctx, "args")
				return
			case "between":
				this.at("expr", () => {
					this.expr(e.expr, ctx)
				})
				this.at("low", () => {
					this.expr(e.low, ctx)
				})
				this.at("high", () => {
					this.expr(e.high, ctx)
				})
				return
			case "inList":
				this.at("expr", () => {
					this.expr(e.expr, ctx)
				})
				this.exprs(e.list, ctx, "list")
				return
			case "inQuery":
				this.at("expr", () => {
					this.expr(e.expr, ctx)
				})
				this.at("query", () => {
					this.subquery(e.query, ctx)
				})
				return
			case "equalsAny":
				this.at("expr", () => {
					this.expr(e.expr, ctx)
				})
				this.at("array", () => {
					this.expr(e.array, ctx)
				})
				return
			case "exists":
			case "subquery":
			case "array":
				this.at("query", () => {
					this.subquery(e.query, ctx)
				})
				return
			case "row":
				this.exprs(e.items, ctx, "items")
				return
			case "case":
				if (e.operand !== undefined) {
					const operand = e.operand
					this.at("operand", () => {
						this.expr(operand, ctx)
					})
				}
				for (const [i, branch] of e.whens.entries()) {
					this.at("whens", () => {
						this.at(i, () => {
							this.at("when", () => {
								this.expr(branch.when, ctx)
							})
							this.at("result", () => {
								this.expr(branch.result, ctx)
							})
						})
					})
				}
				this.at("else", () => {
					this.expr(e.else, ctx)
				})
				return
			case "call":
				this.call(e, ctx)
				return
			case "greatest":
			case "least":
			case "coalesce":
				this.exprs(e.args, ctx, "args")
				return
			case "mergeAction":
				if (!ctx.mergeAction) {
					this.report("context", "merge_action() outside MERGE ... RETURNING")
				}
				return
			case "domainValue":
				if (ctx.mode !== "domain") {
					this.report("context", "VALUE outside a domain CHECK")
				}
				return
			case "plVar":
				this.plVar(e.name, ctx)
				return
			case "plSpecial":
				if (!ctx.pl) {
					this.report("context", `${e.name} outside PL/pgSQL`)
				}
				return
			case "field":
				this.ident(e.field, "record field")
				if (e.record.kind === "plVar") {
					this.plVar(e.record.name, ctx)
				} else if (!ctx.pl) {
					this.report("context", `${e.record.name} outside PL/pgSQL`)
				}
				return
			case "regclass":
				this.objectName(e.relation, "relation", "relation")
				return
			case "user":
				return
		}
	}

	/** A context source names a context and its fields' claims: JSON keys, each a nonempty well-formed text. */
	claimKey(key: string, what: string): void {
		if (key.length === 0) {
			this.report("identifier", `a ${what} is empty`)
		} else if (Str.includes("\u0000")(key) || !isWellFormed(key)) {
			this.report("identifier", `a ${what} is not well-formed text`)
		}
	}

	exprs(list: ReadonlyArray<Expr>, ctx: ExprContext, at: string): void {
		this.at(at, () => {
			for (const [i, e] of list.entries()) {
				this.at(i, () => {
					this.expr(e, ctx)
				})
			}
		})
	}

	/** A variable is named only inside PL/pgSQL; the printer's scope check (sql/scope.ts) holds it to its body's. */
	plVar(name: string, ctx: ExprContext): void {
		this.ident(name, "PL/pgSQL variable")
		if (!ctx.pl) {
			this.report("context", `variable "${name}" outside PL/pgSQL`)
		}
	}

	/**
	 * A column names nothing inside a domain CHECK. Everywhere else the printer's scope check (sql/scope.ts) binds it:
	 * qualified by a relation in reach in a query, unqualified in DDL and a set operation's ORDER BY.
	 */
	column(e: Extract<Expr, { kind: "column" }>, ctx: ExprContext): void {
		this.ident(e.column, "column")
		if (ctx.mode === "domain") {
			this.report("context", `column "${e.column}" inside a domain CHECK`)
			return
		}
		if (e.table !== undefined) {
			this.ident(e.table, "column qualifier")
		}
	}

	call(call: FunctionCall, ctx: ExprContext): void {
		if (call.star) {
			const filter = call.filter
			if (filter !== undefined) {
				this.at("filter", () => {
					this.expr(filter, ctx)
				})
			}
		} else {
			this.callArguments(call, ctx)
		}
		if (call.over !== undefined) {
			const over = call.over
			this.at("over", () => {
				this.exprs(over.partitionBy, ctx, "partitionBy")
				this.orderBy(over.orderBy, ctx, "orderBy")
				if (over.frame === undefined) {
					return
				}
				for (const bound of [over.frame.start, over.frame.end]) {
					if (bound.kind === "offset" && bound.offset < 0n) {
						this.report("arity", "a negative frame offset")
					}
				}
			})
		}
	}

	/** LEAD and LAG default to NULL past the partition's edge; the row's own value is the default. */
	callArguments(call: Call, ctx: ExprContext): void {
		if (call.fn.kind === "qualified") {
			this.ident(call.fn.schema, "function schema")
			this.ident(call.fn.name, "function name")
		} else {
			const name: string = call.fn.name
			const rule = builtinCallRule(name)
			if (rule !== undefined) {
				this.report(rule, `"${name}" is not a builtin function grizzle emits`, "fn")
			}
		}
		this.exprs(call.args, ctx, "args")
		this.orderBy(call.orderBy, ctx, "orderBy")
		this.orderBy(call.withinGroup, ctx, "withinGroup")
		if (
			call.fn.kind === "builtin" &&
			(call.fn.name === "lead" || call.fn.name === "lag") &&
			call.args.length !== 3
		) {
			this.report(
				"null",
				`${call.fn.name} of ${call.args.length} arguments, which defaults to NULL; write ${call.fn.name}(f, 1, f)`
			)
		}
	}

	orderBy(items: ReadonlyArray<OrderItem>, ctx: ExprContext, at: string): void {
		this.at(at, () => {
			for (const [i, item] of items.entries()) {
				this.at(i, () => {
					this.expr(item.expr, ctx)
				})
			}
		})
	}

	/**
	 * A constant's RETURN (sql/ast.ts CreateConstant). Rule constantSubquery: its body may be one scalar subquery and
	 * nothing around it, a query of no outer scope, as a roster's `live()` is `RETURN (SELECT string_agg(...) FROM
	 * unnest(names()) WITH ORDINALITY ...)`: an IMMUTABLE SQL-body function of no argument, which PostgreSQL evaluates at
	 * plan time. Every other body is DDL's expression, where a subquery is refused. A LANGUAGE sql body is no PL/pgSQL
	 * scope, so TG_TABLE_NAME, NEW and OLD are undefined in it.
	 */
	constantBody(body: Expr): void {
		if (body.kind !== "subquery") {
			this.expr(body, context("ddl", false))
			return
		}
		this.at("query", () => {
			this.select(body.query, { pl: false, outermost: true, topLevel: false })
		})
	}

	/** A query nested in an expression, correlated into its enclosing query; inside PL/pgSQL an embedded statement. */
	subquery(query: OperandSelect, ctx: ExprContext): void {
		if (ctx.mode === "pl") {
			this.embedded(() => {
				this.select(query, { pl: ctx.pl, outermost: false, topLevel: false })
			})
			return
		}
		if (ctx.mode !== "query") {
			this.report(
				"context",
				`a subquery in ${ctx.mode === "output" ? "a set operation's ORDER BY" : "DDL"}`
			)
		}
		this.select(query, { pl: ctx.pl, outermost: false, topLevel: false })
	}

	/** `topLevel`: the WITH of the statement itself, the only one that may hold a data-modifying CTE. */
	with(w: ReadonlyArray<Cte>, recursive: boolean, pl: boolean, topLevel: boolean): void {
		this.at("with", () => {
			if (recursive) {
				for (const [i, cte] of w.entries()) {
					this.at(i, () => {
						this.defineRelation(cte.name, "name")
					})
				}
			}
			for (const [i, cte] of w.entries()) {
				this.at(i, () => {
					if (!recursive) {
						this.defineRelation(cte.name, "name")
					}
					this.cte(cte, pl, topLevel)
				})
			}
		})
	}

	/**
	 * A query CTE's columns are its query's output names (sql/ast.ts selectColumns), c<n> names, distinct, none over a
	 * unit read: a relation of no column, whose columns nothing reads by name. A data-modifying CTE's are its RETURNING
	 * targets' names.
	 *
	 * PostgreSQL refuses a data-modifying CTE in any WITH but the statement's own: in a derived table, a subquery,
	 * a set operation's arm, a CTE body, an INSERT's source query or the WITH of another data-modifying CTE
	 * (0A000).
	 */
	cte(cte: Cte, pl: boolean, topLevel: boolean): void {
		const body = cte.query
		if (body.kind === "select") {
			this.at("columns", () => this.columnList(selectColumns(body), "CTE", true))
			this.at("query", () => {
				this.select(body, { pl, outermost: false, topLevel: false })
			})
			return
		}
		if (!topLevel) {
			this.report(
				"context",
				`data-modifying CTE "${cte.name}" in a WITH that is not the statement's own`
			)
		}
		/** A data-modifying CTE's columns are its RETURNING targets' names, each its alias; one with no RETURNING, a write
		 * no part of its statement reads (a carried delta's fill, write/readback/deltas.ts carriedFill), has none. */
		const returning = body.returning
		if (Arr.some(returning, (target) => target.alias === undefined)) {
			this.report("columnList", `data-modifying CTE "${cte.name}" has an unnamed RETURNING column`)
		}
		this.at("query", () => {
			this.dml(body, false, pl)
		})
	}

	/**
	 * A parenthesized query is no query boundary in PostgreSQL: its WITH and tail clauses merge with the enclosing
	 * query's, so `(... LIMIT 5) ORDER BY x` sorts before limiting and two LIMITs are a syntax error. Only one
	 * level of a chain of parenthesized bodies may carry clauses, and a level without any is no boundary either, so
	 * the check looks through it to the next level that has some. A lowering that needs both nests a derived table
	 * or a CTE instead.
	 */
	select(select: OperandSelect, ctx: SelectContext): void {
		if (hasClauses(select) && clausesBelow(select.body) !== undefined) {
			this.report(
				"context",
				"a query body and its enclosing query both carry clauses, which PostgreSQL merges into one",
				"body"
			)
		}
		if (select.with !== undefined) {
			this.with(select.with.ctes, select.with.recursive, ctx.pl, ctx.topLevel)
		}
		this.at("body", () => {
			this.body(select.body, { pl: ctx.pl, outermost: ctx.outermost })
		})
		/** ORDER BY over a set operation names its output columns, unqualified; over a core it reads the core's FROM. */
		const tail = context(select.body.kind === "core" ? "query" : "output", ctx.pl)
		this.orderBy(select.orderBy, tail, "orderBy")
		const bound = context("query", ctx.pl)
		if (select.limit !== undefined) {
			const limit = select.limit
			this.at("limit", () => {
				this.expr(limit, bound)
			})
		}
		if (select.offset !== undefined) {
			const offset = select.offset
			this.at("offset", () => {
				this.expr(offset, bound)
			})
		}
	}

	body(body: OperandBody, ctx: BodyContext): void {
		switch (body.kind) {
			case "core":
				this.core(body, ctx)
				return
			case "setOp": {
				const [first, ...later] = body.arms
				const width = bodyWidth(first)
				/**
				 * UNION arms of one width rename their columns position by position to the union's names, the first arm's.
				 * A later arm either names no column, taking the union's names, or names every column with the union's
				 * name at its position.
				 */
				const names = bodyPositionNames(first)
				for (const [i, arm] of later.entries()) {
					const armWidth = bodyWidth(arm)
					if (armWidth !== width) {
						this.report("arity", `${body.op} of arms with ${width} and ${armWidth} columns`)
					}
					const aliases = bodyAliases(arm)
					const at =
						armWidth === width && Arr.some(aliases, (alias) => alias !== undefined)
							? Arr.findFirstIndex(names, (name, j) => name === undefined || aliases[j] !== name)
							: Option.none()
					if (Option.isSome(at)) {
						this.report(
							"naming",
							`${body.op} arm names column ${at.value + 1} ${shownName(aliases[at.value])}, not the union's ${shownName(names[at.value])}`,
							"arms",
							i + 1
						)
					}
				}
				this.at("arms", () => {
					for (const [i, arm] of body.arms.entries()) {
						this.at(i, () => {
							this.body(arm, ctx)
						})
					}
				})
				return
			}
			case "select":
				this.select(body, { ...ctx, topLevel: false })
				return
		}
	}

	/**
	 * An ungrouped aggregate query yields one row over empty input, and every aggregate but count is NULL there.
	 * An aggregate-only query groups by a constant column its input carries, so empty input yields no row.
	 */
	core(core: SelectCore, ctx: BodyContext): void {
		const exprCtx = context("query", ctx.pl)
		this.at("from", () => {
			for (const [i, item] of core.from.entries()) {
				this.at(i, () => {
					this.fromItem(item, ctx.pl)
				})
			}
		})
		if (typeof core.distinct === "object") {
			const on = core.distinct.on
			this.exprs(on, exprCtx, "distinct")
		}
		this.at("targets", () => {
			for (const [i, target] of core.targets.entries()) {
				this.at(i, () => {
					this.target(target, exprCtx, ctx.outermost)
				})
			}
		})
		if (core.where !== undefined) {
			const where = core.where
			this.at("where", () => {
				this.expr(where, exprCtx)
			})
		}
		this.exprs(core.groupBy, exprCtx, "groupBy")
		if (core.having !== undefined) {
			const having = core.having
			this.at("having", () => {
				this.expr(having, exprCtx)
			})
		}
		if (core.groupBy.length === 0) {
			for (const [i, target] of core.targets.entries()) {
				this.at("targets", () => {
					this.at(i, () => {
						this.ungroupedAggregates(target.expr, "expr")
					})
				})
			}
			if (core.having !== undefined) {
				this.ungroupedAggregates(core.having, "having")
			}
		}
	}

	/**
	 * Reports each plain (unwindowed) NULL-on-empty aggregate in an expression of an ungrouped core. A nested query
	 * is its own core and is audited where it stands.
	 */
	ungroupedAggregates(e: Expr, at: string): void {
		forEachAggregateCall(e, (call) => {
			if (call.fn.kind === "builtin" && nullOnEmptyAggregates.has(call.fn.name)) {
				this.report(
					"null",
					`${call.fn.name}() in an ungrouped query, which yields NULL over empty input; group by a carried constant column`,
					at
				)
			}
		})
	}

	/** Only the outermost output may carry public names; every other alias is a generated c<n>. */
	target(target: Target, ctx: ExprContext, outermost: boolean): void {
		this.at("expr", () => {
			this.expr(target.expr, ctx)
		})
		if (target.alias === undefined) {
			return
		}
		this.ident(target.alias, "column alias", "alias")
		if (!outermost && !isGeneratedColumnName(target.alias)) {
			this.report(
				"naming",
				`nested column alias "${target.alias}" is not a generated c<n>`,
				"alias"
			)
		}
	}

	targetNames(targets: ReadonlyArray<Target>): void {
		const seen = new Set<string>()
		for (const [i, target] of targets.entries()) {
			if (target.alias === undefined) {
				continue
			}
			if (seen.has(target.alias)) {
				this.report("columnList", `output column "${target.alias}" is named twice`, i)
			}
			seen.add(target.alias)
		}
	}

	/**
	 * A FROM item's names and lists, each relation alias it defines defined once; a probe delivering each column it reads
	 * under a generated c<n>, or as the stored column itself, passed through under its own name, as the binding delivers
	 * a probe it makes of a table read (sql/bind.ts), its tuple id a write's target is read at among them. Which relations
	 * each place of it reaches is the printer's scope check (sql/scope.ts).
	 */
	fromItem(item: FromItem, pl: boolean): void {
		switch (item.kind) {
			case "table":
				this.tableName(item.table, "table")
				this.defineRelation(item.alias, "alias")
				return
			case "read": {
				this.tableName(item.table, "table")
				this.defineRelation(item.alias, "alias")
				const ctx = context("query", pl)
				this.at("access", () => {
					for (const condition of readConditions(item)) {
						this.expr(condition, ctx)
					}
				})
				return
			}
			case "probe":
			case "met": {
				this.tableName(item.table, "table")
				this.ident(item.inner, "probed row", "inner")
				const ctx = context("query", pl)
				if (item.kind === "probe") {
					this.at("by", () => {
						for (const [i, c] of item.by.columns.entries()) {
							this.at(i, () => {
								this.ident(c.column, "probed column", "column")
								this.expr(c.value, ctx)
							})
						}
					})
				} else {
					this.ident(item.rows, "met rows", "rows")
					this.at("key", () => {
						for (const [i, k] of item.key.entries()) {
							this.at(i, () => {
								this.ident(k.column, "met column", "column")
								this.ident(k.from, "met row column", "from")
							})
						}
					})
				}
				this.at("filter", () => {
					for (const [i, e] of item.filter.entries()) {
						this.at(i, () => {
							this.expr(e, ctx)
						})
					}
				})
				this.at("columns", () => {
					for (const [i, c] of item.columns.entries()) {
						this.at(i, () => {
							this.ident(c.read, "probed stored column", "read")
						})
					}
				})
				this.at("columns", () => {
					this.columnList(
						Arr.map(item.columns, (c) => c.as),
						"probe",
						false
					)
					for (const [i, c] of item.columns.entries()) {
						if (c.as !== c.read && !isGeneratedColumnName(c.as)) {
							this.report("naming", `probe column "${c.as}" is not a generated c<n>`, i)
						}
					}
				})
				this.defineRelation(item.alias, "alias")
				return
			}
			case "metRows": {
				this.ident(item.insert, "met rows' INSERT", "insert")
				this.ident(item.proposed, "met rows' proposal", "proposed")
				this.ident(item.scan, "proposed row", "scan")
				this.ident(item.returned, "returned row", "returned")
				this.ident(item.sides, "met rows' sides", "sides")
				this.ident(item.marker, "met rows' marker", "marker")
				this.ident(item.marked, "marked met rows", "marked")
				this.ident(item.hit, "met rows' hit", "hit")
				this.at("columns", () => {
					for (const [i, c] of item.columns.entries()) {
						this.at(i, () => {
							this.ident(c.returned, "returned column", "returned")
						})
					}
				})
				this.at("key", () => {
					for (const [i, k] of item.key.entries()) {
						this.at(i, () => {
							this.ident(k.column, "proposed key column", "column")
							this.ident(k.from, "returned key column", "from")
						})
					}
				})
				this.at("columns", () =>
					this.columnList(
						Arr.map(item.columns, (c) => c.column),
						"met rows",
						true
					)
				)
				this.defineRelation(item.alias, "alias")
				return
			}
			case "cte": {
				this.ident(item.name, "CTE reference", "name")
				if (item.alias !== undefined) {
					this.defineRelation(item.alias, "alias")
				}
				return
			}
			case "enclosing":
				this.ident(item.name, "enclosing CTE", "name")
				this.defineRelation(item.alias, "alias")
				return
			case "transition":
				this.defineRelation(item.alias, "alias")
				return
			case "derived": {
				this.at("columns", () => this.columnList(selectColumns(item.query), "derived table", true))
				this.at("query", () => {
					this.select(item.query, { pl, outermost: false, topLevel: false })
				})
				if (item.alias === operandsAlias) {
					this.ident(item.alias, "operand binding", "alias")
				} else {
					this.defineRelation(item.alias, "alias")
				}
				return
			}
			case "function": {
				this.at("columns", () =>
					this.columnList(functionColumnNames(item.columns), "function", true)
				)
				const ctx = context("query", pl)
				this.at("call", () => {
					this.call(item.call, ctx)
				})
				this.defineRelation(item.alias, "alias")
				return
			}
			case "arrays": {
				const source = item.source
				if (source.kind === "count") {
					this.at("source", () => {
						this.placeholder(source.count.number, types.bigint)
					})
					this.defineRelation(item.alias, "alias")
					return
				}
				if (source.kind === "carried" || source.kind === "setting") {
					const ctx = context("query", pl)
					this.at("source", () => {
						for (const [i, { definition, array }] of source.columns.entries()) {
							this.at(i, () => {
								this.type(definition.type)
								this.collatable(definition.type, definition.collation, "column definition")
								this.expr(array, ctx)
							})
						}
						return this.columnList(
							Arr.map(source.columns, (column) => column.definition.name),
							"carried arrays",
							true
						)
					})
					this.defineRelation(item.alias, "alias")
					return
				}
				this.at("source", () => {
					for (const [i, { definition, array }] of source.columns.entries()) {
						this.at(i, () => {
							this.type(definition.type)
							this.collatable(definition.type, definition.collation, "column definition")
							const elements = definition.type
							if (elements.kind === "builtin" && elements.name === "bit") {
								this.report(
									"type",
									"an input array of bit(n), which has no array type grizzle names"
								)
							} else {
								this.placeholder(array.number, { ...elements, array: true })
							}
						})
					}
					return this.columnList(
						Arr.map(source.columns, (column) => column.definition.name),
						"input arrays",
						true
					)
				})
				this.defineRelation(item.alias, "alias")
				return
			}
			case "context": {
				this.claimKey(item.context, "context")
				this.at("columns", () => {
					for (const [i, { field, column }] of item.columns.entries()) {
						this.at(i, () => {
							this.claimKey(field, "claim field")
							this.type(column.type)
							this.collatable(column.type, column.collation, "column definition")
						})
					}
					return this.columnList(
						Arr.map(item.columns, ({ column }) => column.name),
						"context source",
						true
					)
				})
				this.ident(item.refusal.schema, "function schema")
				this.ident(item.refusal.name, "function name")
				this.defineRelation(item.alias, "alias")
				return
			}
			case "values": {
				this.at("columns", () => this.columnList(item.columns, "VALUES", true))
				this.valuesRows(item.rows, item.columns.length, context("query", pl))
				this.defineRelation(item.alias, "alias")
				return
			}
			case "joins":
				this.at("first", () => {
					this.fromItem(item.first, pl)
				})
				this.at("steps", () => {
					for (const [i, step] of item.steps.entries()) {
						this.at(i, () => {
							this.at("source", () => {
								this.fromItem(step.source, pl)
							})
							if (step.kind !== "cross") {
								this.at("on", () => {
									this.expr(step.on, context("query", pl))
								})
							}
						})
					}
				})
				return
		}
	}

	/** A write's target alias and its FROM, USING or USING-source items, each alias defined once. */
	writeItems(alias: string, items: ReadonlyArray<FromItem>, at: string, pl: boolean): void {
		this.defineRelation(alias, "alias")
		this.at(at, () => {
			for (const [i, item] of items.entries()) {
				this.at(i, () => {
					this.fromItem(item, pl)
				})
			}
		})
	}

	valuesRows(rows: ReadonlyArray<ReadonlyArray<Expr>>, width: number, ctx: ExprContext): void {
		this.at("rows", () => {
			for (const [i, row] of rows.entries()) {
				this.at(i, () => {
					if (row.length !== width) {
						this.report("arity", `a VALUES row of ${row.length} for ${width} columns`)
					}
					for (const [j, e] of row.entries()) {
						this.at(j, () => {
							this.expr(e, ctx)
						})
					}
				})
			}
		})
	}

	/** `topLevel`: the statement's own output, whose RETURNING may carry public names; `pl`, whether the statement is a
	 * PL/pgSQL function's (PlStatement modify). */
	dml(statement: CteBody, topLevel: boolean, pl: boolean): void {
		switch (statement.kind) {
			case "select":
				this.select(statement, { pl, outermost: topLevel, topLevel })
				return
			case "insert":
				this.insert(statement, topLevel, pl)
				return
			case "update":
				this.update(statement, topLevel, pl)
				return
			case "delete":
				this.delete(statement, topLevel, pl)
				return
			case "merge":
				this.merge(statement, topLevel, pl)
				return
		}
	}

	returning(returning: ReadonlyArray<Target>, ctx: ExprContext, topLevel: boolean): void {
		this.at("returning", () => {
			for (const [i, target] of returning.entries()) {
				this.at(i, () => {
					this.target(target, ctx, topLevel)
				})
			}
			this.targetNames(returning)
		})
	}

	insert(insert: Insert, topLevel: boolean, pl: boolean): void {
		if (insert.with !== undefined) {
			this.with(insert.with.ctes, insert.with.recursive, pl, topLevel)
		}
		this.tableName(insert.table, "table")
		this.at("columns", () => {
			this.baseColumns(insert.columns, "INSERT column")
		})
		const source = insert.source
		this.at("source", () => {
			if (source.kind === "query") {
				if (selectWidth(source.query) !== insert.columns.length) {
					this.report(
						"arity",
						`INSERT of ${insert.columns.length} columns from ${selectWidth(source.query)}`
					)
				}
				this.at("query", () => {
					this.select(source.query, { pl, outermost: false, topLevel: false })
				})
			} else {
				this.valuesRows(source.rows, insert.columns.length, context("query", pl))
			}
		})
		if (insert.alias !== undefined) {
			this.defineRelation(insert.alias, "alias")
		}
		if (insert.onConflict !== undefined) {
			const conflict = insert.onConflict
			this.at("onConflict", () => {
				if (conflict.kind === "constraint") {
					this.ident(conflict.constraint, "arbiter constraint", "constraint")
					return
				}
				if (conflict.kind === "every") {
					return
				}
				this.at("columns", () => {
					this.baseColumns(conflict.columns, "arbiter column")
				})
				const ctx: ExprContext = { ...context("query", pl), excluded: true }
				const action = conflict.action
				if (action.kind === "doUpdate") {
					this.assignments(action.set, ctx)
				}
				if (action.kind !== "doNothing" && action.where !== undefined) {
					const where = action.where
					this.at("where", () => {
						this.expr(where, ctx)
					})
				}
			})
		}
		this.returning(
			insert.returning,
			{
				...context("query", pl),
				returningSides: newSide,
				underIsTrue: meetsStoredRow(insert) ? bothSides : undefined
			},
			topLevel
		)
	}

	assignments(
		set: ReadonlyArray<{ readonly column: string; readonly value: Expr }>,
		ctx: ExprContext
	): void {
		this.at("set", () => {
			this.baseColumns(
				Arr.map(set, (a) => a.column),
				"assigned column"
			)
			for (const [i, a] of set.entries()) {
				this.at(i, () => {
					this.expr(a.value, ctx)
				})
			}
		})
	}

	update(update: Update, topLevel: boolean, pl: boolean): void {
		if (update.with !== undefined) {
			this.with(update.with.ctes, update.with.recursive, pl, topLevel)
		}
		this.objectName(update.table, "table", "table")
		this.writeItems(update.alias, update.from, "from", pl)
		const ctx = context("query", pl)
		this.assignments(update.set, ctx)
		if (update.where !== undefined) {
			const where = update.where
			this.at("where", () => {
				this.expr(where, ctx)
			})
		}
		this.returning(update.returning, { ...ctx, returningSides: bothSides }, topLevel)
	}

	/** new.* is NULL for a deleted row; the target alias already is the old row. */
	delete(del: Delete, topLevel: boolean, pl: boolean): void {
		if (del.with !== undefined) {
			this.with(del.with.ctes, del.with.recursive, pl, topLevel)
		}
		this.tableName(del.table, "table")
		this.writeItems(del.alias, del.using, "using", pl)
		const ctx = context("query", pl)
		if (del.where !== undefined) {
			const where = del.where
			this.at("where", () => {
				this.expr(where, ctx)
			})
		}
		this.returning(del.returning, { ...ctx, returningSides: oldSide }, topLevel)
	}

	/** Which side each WHEN and the RETURNING reach is the printer's scope check (sql/scope.ts). */
	merge(merge: Merge, topLevel: boolean, pl: boolean): void {
		if (merge.with !== undefined) {
			this.with(merge.with.ctes, merge.with.recursive, pl, topLevel)
		}
		this.objectName(merge.table, "table", "table")
		this.defineRelation(merge.alias, "alias")
		this.at("using", () => {
			this.fromItem(merge.using, pl)
		})
		const ctx = context("query", pl)
		this.at("on", () => {
			this.expr(merge.on, ctx)
		})
		this.at("whens", () => {
			for (const [i, when] of merge.whens.entries()) {
				this.at(i, () => {
					const inner = ctx
					if (when.condition !== undefined) {
						const condition = when.condition
						this.at("condition", () => {
							this.expr(condition, inner)
						})
					}
					const action = when.action
					if (action.kind === "update") {
						this.assignments(action.set, inner)
					}
					if (action.kind === "insert") {
						this.at("row", () => {
							this.baseColumns(
								Arr.map(action.row, (a) => a.column),
								"INSERT column"
							)
							for (const [j, a] of action.row.entries()) {
								this.at(j, () => {
									this.expr(a.value, inner)
								})
							}
						})
					}
				})
			}
		})
		/** old.* is NULL for a row an INSERT action produced, new.* for a row a DELETE action removed. */
		const inserts = Arr.some(
			merge.whens,
			(when) => when.action.kind === "insert" || when.action.kind === "insertDefault"
		)
		const deletes = Arr.some(merge.whens, (when) => when.action.kind === "delete")
		const sides = new Set<"old" | "new">()
		if (!inserts) {
			sides.add("old")
		}
		if (!deletes) {
			sides.add("new")
		}
		this.returning(
			merge.returning,
			{
				...context("query", pl),
				returningSides: sides,
				mergeAction: true
			},
			topLevel
		)
	}

	ddlExpr(e: Expr, at: string): void {
		this.at(at, () => {
			this.expr(e, context("ddl", false))
		})
	}

	columnDef(column: ColumnDef): void {
		this.ident(column.name, "column", "name")
		this.at("type", () => {
			this.type(column.type)
		})
		this.collatable(column.type, column.collation, "column")
		const generated = column.generated
		if (generated === undefined) {
			return
		}
		switch (generated.kind) {
			case "stored":
				this.ddlExpr(generated.expr, "generated")
				return
			case "partial":
				this.at("generated", () => {
					this.ddlExpr(generated.when, "when")
					this.ddlExpr(generated.expr, "expr")
				})
				return
		}
	}

	/**
	 * A span key's span, and a PERIOD reference's span, is the last column. A key's columns, and a foreign key's
	 * referenced columns, are each listed once (42701, 42830); a foreign key's referencing columns may list a column more
	 * than once, which PostgreSQL accepts (`repeats` "admitted"). That each is a column of its table is the printer's
	 * scope check (sql/scope.ts).
	 */
	keyColumns(
		columns: ReadonlyArray<SpanColumn>,
		at: string,
		repeats: "refused" | "admitted"
	): void {
		this.at(at, () => {
			const seen = new Set<string>()
			for (const [i, c] of columns.entries()) {
				this.ident(c.column, "key column", i)
				if (repeats === "refused" && seen.has(c.column)) {
					this.report("columnList", `key column "${c.column}" is listed twice`, i)
				}
				seen.add(c.column)
				if (c.span && i !== columns.length - 1) {
					this.report("columnList", `the span "${c.column}" is not the key's last column`, i)
				}
			}
		})
	}

	constraint(constraint: TableConstraint): void {
		this.ident(constraint.name, "constraint", "name")
		switch (constraint.kind) {
			case "primaryKey":
			case "unique":
				this.keyColumns(Arr.map(constraint.columns, keySpan), "columns", "refused")
				return
			case "foreignKey": {
				this.keyColumns(Arr.map(constraint.columns, periodSpan), "columns", "admitted")
				this.objectName(constraint.references, "referenced table", "references")
				this.keyColumns(
					Arr.map(constraint.referencedColumns, periodSpan),
					"referencedColumns",
					"refused"
				)
				if (constraint.columns.length !== constraint.referencedColumns.length) {
					this.report(
						"arity",
						`a foreign key of ${constraint.columns.length} columns onto ${constraint.referencedColumns.length}`
					)
				}
				const period = (cs: ReadonlyArray<ForeignKeyColumn>): boolean =>
					Arr.some(cs, (c) => c.period)
				if (period(constraint.columns) !== period(constraint.referencedColumns)) {
					this.report("columnList", "PERIOD on one side of a foreign key only")
				}
				return
			}
			case "check":
				this.ddlExpr(constraint.predicate, "predicate")
				return
			case "exclude":
				this.keyColumns(
					Arr.map(constraint.elements, (e) => ({ column: e.column, span: false })),
					"elements",
					"refused"
				)
				return
		}
	}

	/** A table's or a carrier's columns, each declared once. */
	tableColumns(columns: ReadonlyArray<ColumnDef>): void {
		const names = new Set<string>()
		for (const [i, column] of columns.entries()) {
			if (names.has(column.name)) {
				this.report("columnList", `column "${column.name}" is declared twice`, i)
			}
			names.add(column.name)
		}
		this.at("columns", () => {
			for (const [i, column] of columns.entries()) {
				this.at(i, () => {
					this.columnDef(column)
				})
			}
		})
	}

	createTable(table: CreateTable): void {
		this.objectName(table.table, "table", "table")
		this.tableColumns(table.columns)
		this.uniqueNames(
			Arr.map(tableConstraints(table), (c) => c.name),
			"constraint"
		)
		this.at("primaryKey", () => {
			this.constraint(table.primaryKey)
		})
		this.at("secondary", () => {
			for (const [i, c] of table.secondary.entries()) {
				this.at(i, () => {
					this.constraint(c)
				})
			}
		})
	}

	uniqueNames(names: ReadonlyArray<string>, what: string): void {
		const seen = new Set<string>()
		for (const name of names) {
			if (seen.has(name)) {
				this.report("columnList", `${what} "${name}" is declared twice`)
			}
			seen.add(name)
		}
	}

	createFunction(fn: CreateFunction): void {
		this.objectName(fn.name, "function", "name")
		if (fn.language === "sql") {
			this.sqlFunction(fn)
			return
		}
		/** Every argument is in scope in the body, as a declared variable is. */
		const vars = new Set<string>()
		this.at("params", () => {
			for (const [i, p] of fn.params.entries()) {
				this.at(i, () => {
					this.ident(p.name, "argument", "name")
					this.at("type", () => {
						this.type(p.type)
					})
					if (vars.has(p.name)) {
						this.report("naming", `argument "${p.name}" is declared twice`)
					}
					vars.add(p.name)
				})
			}
		})
		this.at("declare", () => {
			for (const [i, d] of fn.body.declare.entries()) {
				this.at(i, () => {
					this.ident(d.name, "variable", "name")
					this.at("type", () => {
						this.type(d.type)
					})
					if (vars.has(d.name)) {
						this.report("naming", `variable "${d.name}" is declared twice`)
					}
					vars.add(d.name)
				})
			}
		})
		this.at("body", () => {
			this.plStatements(fn.body.body)
		})
	}

	/**
	 * An SQL function's body is one expression that names its arguments by position alone: every parameter of the body
	 * is an argument, and every argument is typed. Its parameters are its own, not the installing statement's.
	 */
	sqlFunction(fn: SqlFunction): void {
		this.at("params", () => {
			for (const [i, p] of fn.params.entries()) {
				this.at(i, () => {
					this.ident(p.name, "argument", "name")
					this.at("type", () => {
						this.type(p.type)
					})
				})
			}
		})
		this.argumentsBody(fn.params, () => {
			this.embedded(() => {
				this.at("body", () => {
					this.expr(fn.body, context("pl", true))
				})
			})
		})
	}

	/**
	 * A function body that names its arguments by position alone, `body` audited as it runs: every parameter it holds is
	 * one of `params`, typed as that argument is, and no parameter of the installing statement reaches it.
	 */
	argumentsBody(params: ReadonlyArray<{ readonly type: TypeRef }>, body: () => void): void {
		const saved = { allowed: this.#paramsAllowed, params: new Map(this.#params) }
		this.#paramsAllowed = true
		this.#params.clear()
		body()
		for (const [index, used] of this.#params) {
			const arg = params[index - 1]
			if (arg === undefined) {
				this.report("param", `$${index} names no argument of the function`, "body")
			} else if (printType(arg.type) !== used.printed) {
				this.report(
					"param",
					`$${index} is typed ${used.printed}, its argument ${printType(arg.type)}`,
					"body"
				)
			}
		}
		this.#paramsAllowed = saved.allowed
		this.#params.clear()
		for (const [index, used] of saved.params) {
			this.#params.set(index, used)
		}
	}

	plStatements(statements: ReadonlyArray<PlStatement>): void {
		for (const [i, s] of statements.entries()) {
			this.at(i, () => {
				this.plStatement(s)
			})
		}
	}

	/**
	 * The FOR query is a statement of its own, so its WITH is the statement's own.
	 *
	 * PERFORM replaces the leading SELECT, so the query is one plain core.
	 *
	 * A fixed message: '%' would be a format placeholder without an argument.
	 */
	plStatement(statement: PlStatement): void {
		const ctx = context("pl", true)
		const embeddedSelect = (query: OperandSelect): void => {
			this.embedded(() => {
				this.select(query, { pl: true, outermost: false, topLevel: false })
			})
		}
		switch (statement.kind) {
			case "if":
				for (const [i, branch] of statement.branches.entries()) {
					this.at("branches", () => {
						this.at(i, () => {
							this.at("condition", () => {
								this.expr(branch.condition, ctx)
							})
							this.at("body", () => {
								this.plStatements(branch.body)
							})
						})
					})
				}
				this.at("else", () => {
					this.plStatements(statement.else)
				})
				return
			case "assign":
				this.plVar(statement.target, ctx)
				this.at("value", () => {
					this.expr(statement.value, ctx)
				})
				return
			case "forQuery":
				this.plVar(statement.variable, ctx)
				this.at("query", () => {
					this.embedded(() => {
						this.select(statement.query, { pl: true, outermost: false, topLevel: true })
					})
				})
				this.at("body", () => {
					this.plStatements(statement.body)
				})
				return
			case "perform":
				this.at("query", () => {
					embeddedSelect({ kind: "select", with: undefined, ...statement.query })
				})
				return
			case "wholeReads":
				this.at("body", () => {
					this.plStatements(statement.body)
				})
				return
			case "modify":
				this.at("statement", () => {
					this.embedded(() => {
						this.dml(statement.statement, true, true)
					})
				})
				return
			case "returnQuery":
				this.at("query", () => {
					this.embedded(() => {
						this.select(statement.query, { pl: true, outermost: false, topLevel: true })
					})
				})
				return
			case "createSessionTable":
				this.ident(statement.name, "table", "name")
				for (const [i, column] of statement.columns.entries()) {
					this.ident(column.name, "column", "columns", i, "name")
				}
				return
			case "createSessionIndex":
				this.ident(statement.name, "index", "name")
				this.ident(statement.table, "table", "table")
				this.ident(statement.column, "column", "column")
				return
			case "truncateSessionTable":
				this.ident(statement.name, "table", "name")
				return
			case "createSessionTrigger":
				this.ident(statement.name, "trigger", "name")
				this.ident(statement.table, "table", "table")
				this.objectName(statement.function, "function", "function")
				return
			case "whenFound":
				this.at("query", () => {
					embeddedSelect(statement.query)
				})
				this.at("body", () => {
					this.plStatements(statement.body)
				})
				return
			case "case":
				this.at("operand", () => {
					this.expr(statement.operand, ctx)
				})
				for (const [i, branch] of statement.whens.entries()) {
					this.at("whens", () => {
						this.at(i, () => {
							this.exprs(branch.values, ctx, "values")
							this.at("body", () => {
								this.plStatements(branch.body)
							})
						})
					})
				}
				return
			case "raise": {
				if (Str.includes("%")(statement.message)) {
					this.report("literal", "a RAISE message with a '%' placeholder")
				}
				if (Str.includes("\u0000")(statement.message) || !isWellFormed(statement.message)) {
					this.report("literal", "a RAISE message that is not well-formed text")
				}
				const seen = new Set<string>()
				for (const [i, option] of statement.using.entries()) {
					this.at("using", () => {
						this.at(i, () => {
							if (seen.has(option.option)) {
								this.report("arity", `RAISE option ${option.option} given twice`)
							}
							seen.add(option.option)
							this.at("value", () => {
								this.expr(option.value, ctx)
							})
						})
					})
				}
				return
			}
			case "return":
				this.at("value", () => {
					this.expr(statement.value, ctx)
				})
				return
		}
	}

	statement(statement: SqlStatement): void {
		switch (statement.kind) {
			case "select":
				this.select(statement, { pl: false, outermost: true, topLevel: true })
				return
			case "insert":
			case "update":
			case "delete":
			case "merge":
				this.dml(statement, true, false)
				return
			case "beginRead":
			case "beginWrite":
			case "commit":
			case "rollback":
			case "setConstraintsImmediate":
				return
			case "fillStored":
				this.objectName(statement.table, "table", "table")
				for (const [i, column] of statement.columns.entries()) {
					this.ident(column, "column", "columns", i)
				}
				if (statement.columns.length !== selectWidth(statement.query)) {
					this.report(
						"columnList",
						`a fill of ${statement.columns.length} columns from ${selectWidth(statement.query)}`
					)
				}
				this.at("query", () => {
					this.select(statement.query, { pl: false, outermost: true, topLevel: false })
				})
				return
			case "createSchema":
			case "createTable":
			case "alterTable":
			case "rename":
			case "replaceConstant":
			case "renameColumn":
			case "renameConstraint":
			case "createDomain":
			case "alterDomain":
			case "createIndex":
			case "dropIndex":
			case "createStoredTable":
			case "drop":
			case "createView":
			case "createPolicy":
			case "dropPolicy":
			case "grantRole":
			case "revokeRole":
			case "grantColumns":
			case "dropFunction":
			case "dropTrigger":
			case "createFunction":
			case "createDeclaredFunction":
			case "handOverFunction":
			case "createRowType":
			case "alterRowType":
			case "adoptRole":
			case "endHolders":
			case "createConstant":
			case "stubConstant":
			case "packConstant":
			case "createGuardTrigger":
			case "createImmutableGuardTrigger":
			case "createConstraintTrigger":
			case "createTransitionTrigger":
			case "createPublication":
			case "dropPublication":
			case "createLiveSecret":
			case "guardBracket":
			case "createRole":
			case "alterRole":
			case "grant":
			case "revoke":
			case "alterDefaultPrivileges":
			case "createExtension":
			case "lockTable":
			case "comment":
				this.withoutParams(() => {
					this.ddl(statement)
				})
				return
		}
	}

	/** The object a COMMENT ON names, as each of its kinds spells it. */
	commentTarget(on: CommentTarget): void {
		switch (on.kind) {
			case "SCHEMA":
			case "ROLE":
				this.ident(on.name, on.kind === "SCHEMA" ? "schema" : "role", "on")
				return
			case "TABLE":
			case "VIEW":
			case "DOMAIN":
			case "TYPE":
			case "INDEX":
			case "FUNCTION":
				this.objectName(on.name, Str.toLowerCase(on.kind), "on")
				return
			case "COLUMN":
				this.objectName(on.relation, "relation", "on")
				this.ident(on.column, "column", "on")
				return
			case "CONSTRAINT":
			case "TRIGGER":
			case "POLICY":
				this.ident(on.name, Str.toLowerCase(on.kind), "on")
				this.objectName(on.on, "table", "on")
				return
			case "DOMAIN CONSTRAINT":
				this.ident(on.name, "constraint", "on")
				this.objectName(on.domain, "domain", "on")
				return
		}
	}

	/** A constant's name, its parameters' names and types, and its result type: a constant's and its stub's alike. */
	constantHeader(statement: CreateConstant | StubConstant): void {
		this.objectName(statement.name, "function", "name")
		this.at("params", () => {
			for (const [i, param] of statement.params.entries()) {
				this.at(i, () => {
					this.ident(param.name, "parameter", "name")
					this.type(param.type)
				})
			}
		})
		this.at("returns", () => {
			this.type(statement.returns)
		})
	}

	/**
	 * The conversion reads the table's columns, the old value among them.
	 *
	 * Its parameter and value are the AST type's one pair.
	 */
	ddl(statement: Ddl): void {
		switch (statement.kind) {
			case "createSchema":
				this.ident(statement.name, "schema", "name")
				return
			case "createTable":
				this.createTable(statement)
				return
			case "alterTable":
				this.objectName(statement.table, "table", "table")
				this.at("actions", () => {
					for (const [i, action] of statement.actions.entries()) {
						this.at(i, () => {
							switch (action.kind) {
								case "setExpression":
									this.ident(action.column, "column", "column")
									this.at("generation", () => {
										const g = action.generation
										const ddl = context("ddl", false)
										if (g.kind === "partial") {
											this.at("when", () => {
												this.expr(g.when, ddl)
											})
										}
										this.at("expr", () => {
											this.expr(g.expr, ddl)
										})
									})
									return
								case "addColumn":
								case "addColumnPlaceholder":
								case "addColumnUnchecked":
									this.at("column", () => {
										this.columnDef(action.column)
									})
									return
								case "addColumnDefault":
									this.at("column", () => {
										this.columnDef(action.column)
									})
									this.at("default", () => {
										this.expr(action.default, context("ddl", false))
									})
									return
								case "addConstraint":
									this.at("constraint", () => {
										this.constraint(action.constraint)
									})
									return
								case "alterColumnType":
									this.ident(action.column, "column", "column")
									this.at("type", () => {
										this.type(action.type)
									})
									this.collatable(action.type, action.collation, "column")
									this.at("using", () => {
										switch (action.using.kind) {
											case "expr":
												this.ddlExpr(action.using.expr, "expr")
												return
											case "placeholder":
												return
										}
									})
									return
								case "addConstraintUsingIndex":
									this.ident(action.name, "constraint", "name")
									this.ident(action.index, "index", "index")
									return
								case "dropColumn":
								case "dropDefault":
								case "setNotNull":
									this.ident(action.column, "column", "column")
									return
								case "validateConstraint":
								case "alterConstraintDeferral":
								case "dropConstraint":
									this.ident(action.name, "constraint", "name")
									return
								case "enableRowSecurity":
								case "disableRowSecurity":
								case "replicaIdentity":
									return
							}
						})
					}
				})
				return
			case "rename":
				if (statement.object === "ROLE" || statement.object === "SCHEMA") {
					this.ident(statement.name, Str.toLowerCase(statement.object), "name")
				} else {
					this.objectName(statement.name, Str.toLowerCase(statement.object), "name")
				}
				if (statement.object === "FUNCTION") {
					for (const [i, t] of statement.args.entries()) {
						this.at(`args[${i}]`, () => {
							this.type(t)
						})
					}
				}
				this.ident(statement.to, "new name", "to")
				return
			case "replaceConstant":
				this.at("constant", () => {
					this.constantHeader(statement.constant)
					this.argumentsBody(statement.constant.params, () => {
						this.at("body", () => {
							this.constantBody(statement.constant.body)
						})
					})
				})
				return
			case "renameColumn":
			case "renameConstraint":
				this.objectName(statement.table, "table", "table")
				this.ident(statement.from, "old name", "from")
				this.ident(statement.to, "new name", "to")
				return
			case "createDomain":
				this.objectName(statement.name, "domain", "name")
				this.at("base", () => {
					this.type(statement.base)
				})
				this.collatable(statement.base, statement.collation, "domain")
				this.uniqueNames(
					Arr.map(statement.constraints, (c) => c.name),
					"domain constraint"
				)
				for (const [i, c] of statement.constraints.entries()) {
					this.at("constraints", () => {
						this.at(i, () => {
							this.ident(c.name, "constraint", "name")
							this.domainPredicate(c.predicate)
						})
					})
				}
				return
			case "alterDomain": {
				this.objectName(statement.name, "domain", "name")
				const action = statement.action
				if (action.kind === "addConstraint") {
					this.ident(action.constraint.name, "constraint", "name")
					this.domainPredicate(action.constraint.predicate)
				} else {
					this.ident(action.name, "constraint", "name")
				}
				return
			}
			case "createIndex":
				this.ident(statement.name, "index", "name")
				this.objectName(statement.table, "table", "table")
				this.at("keys", () => {
					for (const [i, key] of statement.keys.entries()) {
						this.at(i, () => {
							if (key.key.kind === "column") {
								this.ident(key.key.column, "index column", "key")
							} else {
								this.ddlExpr(key.key.expr, "key")
							}
							if (key.collation !== undefined) {
								this.collation(key.collation, "collation")
							}
							if (key.opclass !== undefined) {
								this.objectName(key.opclass, "operator class", "opclass")
							}
						})
					}
				})
				this.at("include", () => {
					this.baseColumns(statement.include, "included column")
				})
				if (statement.where !== undefined) {
					this.ddlExpr(statement.where, "where")
				}
				return
			case "dropIndex":
				this.objectName(statement.name, "index", "name")
				return
			case "createStoredTable": {
				this.objectName(statement.name, "table", "name")
				this.at("columns", () => {
					this.baseColumns(statement.columns, "stored column")
				})
				if (statement.columns.length !== selectWidth(statement.query)) {
					this.report(
						"columnList",
						`a stored table of ${statement.columns.length} columns over ${selectWidth(statement.query)}`
					)
				}
				this.at("query", () => {
					this.select(statement.query, { pl: false, outermost: true, topLevel: false })
				})
				return
			}
			case "drop":
				if (statement.object === "ROLE") {
					this.ident(statement.name, "role", "name")
				} else if (statement.object === "SCHEMA") {
					this.ident(statement.name, "schema", "name")
				} else {
					this.objectName(statement.name, Str.toLowerCase(statement.object), "name")
				}
				return
			case "createView":
				this.objectName(statement.name, "view", "name")
				this.uniqueNames(statement.columns, "view column")
				for (const [i, c] of statement.columns.entries()) {
					this.ident(c, "view column", "columns", i)
				}
				this.at("query", () => {
					this.embedded(() => {
						this.select(statement.query, { pl: false, outermost: true, topLevel: true })
					})
				})
				return
			case "createPolicy": {
				this.ident(statement.name, "policy", "name")
				this.objectName(statement.table, "table", "table")
				this.ident(statement.role, "role", "role")
				/**
				 * A policy's predicate is a query's condition over its table's row, which it reads by the table's name and
				 * which may hold subqueries.
				 */
				const filter = context("query", false)
				this.at("filter", () => {
					this.expr(statement.filter, filter)
				})
				return
			}
			case "dropPolicy":
				this.ident(statement.name, "policy", "name")
				this.objectName(statement.table, "table", "table")
				return
			case "grantRole":
				this.ident(statement.role, "role", "role")
				this.ident(statement.to, "role", "to")
				return
			case "revokeRole":
				this.ident(statement.role, "role", "role")
				this.ident(statement.from, "role", "from")
				return
			case "grantColumns":
				this.objectName(statement.table, "table", "table")
				this.uniqueNames(statement.columns, "granted column")
				for (const [i, c] of statement.columns.entries()) {
					this.ident(c, "granted column", "columns", i)
				}
				this.ident(statement.to, "role", "to")
				return
			case "dropFunction":
				this.objectName(statement.name, "function", "name")
				return
			case "dropTrigger":
				this.ident(statement.name, "trigger", "name")
				this.objectName(statement.table, "table", "table")
				return
			case "createFunction":
				this.createFunction(statement)
				return
			case "createDeclaredFunction":
				this.objectName(statement.name, "function", "name")
				this.at("params", () => {
					for (const [i, param] of statement.params.entries()) {
						this.at(i, () => {
							this.ident(param.name, "argument", "name")
							this.type(param.type)
						})
					}
				})
				this.at("returns", () => {
					this.type("setOf" in statement.returns ? statement.returns.setOf : statement.returns)
				})
				this.at("namedAlone", () => {
					for (const [i, type] of statement.namedAlone.entries()) {
						this.at(i, () => this.type(type))
					}
				})
				return
			case "handOverFunction":
				this.objectName(statement.name, "function", "name")
				this.ident(statement.owner, "role", "owner")
				return
			case "createRowType":
				this.objectName(statement.name, "type", "name")
				this.at("attributes", () => {
					for (const [i, a] of statement.attributes.entries()) {
						this.at(i, () => {
							this.ident(a.name, "attribute", "name")
							this.type(a.type)
						})
					}
				})
				return
			case "alterRowType":
				this.objectName(statement.name, "type", "name")
				this.at("add", () => {
					this.ident(statement.add.name, "attribute", "name")
					this.type(statement.add.type)
				})
				return
			case "adoptRole":
				this.ident(statement.role, "role", "role")
				return
			case "endHolders":
				for (const [i, role] of statement.roles.entries()) {
					this.ident(role, "role", "roles", i)
				}
				return
			case "createConstant":
				this.constantHeader(statement)
				this.argumentsBody(statement.params, () => {
					this.at("body", () => {
						this.constantBody(statement.body)
					})
				})
				return
			case "stubConstant":
				this.constantHeader(statement)
				return
			case "packConstant": {
				this.objectName(statement.function, "function", "function")
				const layout = statement.layout
				if (layout.kind === "cells" ? layout.cells < 0n : layout.points < 1n) {
					this.report(
						"literal",
						"a pack's cells are a count, never below zero, and its payload space holds one code at least"
					)
				}
				this.at("text", () => {
					const elements = packArray.test(statement.text)
						? statement.text === "{}"
							? []
							: Str.split(",")(Str.slice(1, -1)(statement.text))
						: undefined
					const canonical = (e: string): boolean => e === "0" || !Str.startsWith("0")(e)
					const holds =
						elements !== undefined &&
						(layout.kind === "cells"
							? elements[0] === "-1" &&
								Arr.every(
									Arr.drop(elements, 1),
									(e, i) =>
										canonical(e) &&
										BigInt(e) < layout.cells &&
										BigInt(e) > BigInt(elements[i] ?? "-1")
								)
							: Arr.every(
									elements,
									(e) => canonical(e) && !Str.startsWith("-")(e) && BigInt(e) < layout.points
								))
					if (!holds) {
						this.report(
							"literal",
							"a pack's literal is its elements in braces, canonical decimal numerals, a cells literal's the sentinel -1 then strictly ascending indexes below its cells, a payloads literal's codes below its payload codes"
						)
					}
				})
				return
			}
			case "createGuardTrigger":
			case "createImmutableGuardTrigger":
			case "createConstraintTrigger":
			case "createTransitionTrigger":
				this.ident(statement.name, "trigger", "name")
				this.objectName(statement.table, "table", "table")
				this.objectName(statement.function, "function", "function")
				return
			case "createPublication":
				this.ident(statement.name, "publication", "name")
				for (const [i, published] of statement.tables.entries()) {
					this.objectName(published.table, "table", i)
					if (published.columns.kind === "listed") {
						for (const [j, column] of published.columns.columns.entries()) {
							this.ident(column, "column", "tables", i, "columns", j)
						}
					}
				}
				return
			case "dropPublication":
				this.ident(statement.name, "publication", "name")
				return
			case "createLiveSecret":
				this.objectName(statement.table, "table", "table")
				return
			case "guardBracket":
				for (const [i, g] of statement.guards.entries()) {
					this.ident(g.name, "trigger", i)
				}
				switch (statement.scope.kind) {
					case "tables":
						for (const [i, t] of statement.scope.tables.entries()) {
							this.objectName(t, "table", i)
						}
						return
					case "schemas":
						for (const [i, schema] of statement.scope.schemas.entries()) {
							this.ident(schema, "schema", i)
						}
						return
				}
			case "createRole":
				this.ident(statement.name, "role", "name")
				return
			case "alterRole":
				this.ident(statement.name, "role", "name")
				if (statement.action.kind === "set") {
					const value = storedSettingValue(statement.action.setting)
					if (Str.includes("\u0000")(value) || !isWellFormed(value)) {
						this.report("literal", "a setting value that is not well-formed text")
					}
				}
				return
			case "grant":
			case "revoke": {
				const on = statement.on
				if (on.kind === "SCHEMA") {
					for (const [i, name] of on.names.entries()) {
						this.ident(name, "schema", i)
					}
				} else if (on.kind !== "DATABASE") {
					for (const [i, name] of on.names.entries()) {
						this.objectName(name, Str.toLowerCase(on.kind), i)
					}
				}
				const grantees = statement.kind === "grant" ? statement.to : statement.from
				for (const [i, g] of grantees.entries()) {
					if (g.kind === "role") {
						this.ident(g.name, "role", i)
					}
				}
				return
			}
			case "alterDefaultPrivileges":
				if (statement.inSchema !== undefined) {
					this.ident(statement.inSchema, "schema", "inSchema")
				}
				for (const [i, g] of statement.from.entries()) {
					if (g.kind === "role") {
						this.ident(g.name, "role", i)
					}
				}
				return
			case "createExtension":
				this.ident(statement.name, "extension", "name")
				this.ident(statement.schema, "schema", "schema")
				return
			case "comment":
				this.commentTarget(statement.on)
				return
			case "lockTable":
				for (const [i, t] of statement.tables.entries()) {
					this.objectName(t, "table", i)
				}
				return
		}
	}

	domainPredicate(predicate: Expr): void {
		this.at("predicate", () => {
			this.expr(predicate, context("domain", false))
		})
	}
}

const bothSides: ReadonlySet<"old" | "new"> = new Set(["old", "new"])
const oldSide: ReadonlySet<"old" | "new"> = new Set(["old"])
const newSide: ReadonlySet<"old" | "new"> = new Set(["new"])

/**
 * Whether an INSERT returns the stored row its arbiter meets: its ON CONFLICT is DO SELECT or DO UPDATE, so its
 * RETURNING's old is that row, and NULL on a row it inserted.
 */
export const meetsStoredRow = (insert: Insert): boolean =>
	insert.onConflict?.kind === "columns" && insert.onConflict.action.kind !== "doNothing"

/** A builtin text column or domain is collatable and names the fixed collation; no other builtin type is collatable. */
const isBuiltinText = (type: TypeRef): boolean => type.kind === "builtin" && type.name === "text"

/**
 * Whether a collation is pg_catalog.pg_c_utf8. The AST type admits no other; this holds it for data that bypassed the
 * type, so it reads the collation's names as the strings they are.
 */
const isCUtf8 = (collation: { readonly schema: string; readonly name: string }): boolean =>
	collation.schema === "pg_catalog" && collation.name === "pg_c_utf8"

/** The builtin aggregates that yield NULL over no input row; count is zero there. */
const nullOnEmptyAggregates: ReadonlySet<string> = new Set([
	"sum",
	"avg",
	"min",
	"max",
	"bool_and",
	"bool_or",
	"range_agg",
	"array_agg",
	"jsonb_agg",
	"percentile_disc",
	"percentile_cont",
	"mode"
])

/**
 * Calls f on every function call of an expression that is not windowed, which in a query core is an aggregate when
 * it names one, and whose NULL can reach the expression's value: none before a COALESCE's last argument where that is a
 * literal, which no NULL is, so an aggregate's NULL over empty input falls through to it (lower/shapes/share/keyed.ts
 * carries a copy of no row at a driver row as the empty arrays, `coalesce(array_agg(x), '{}')`). Nested queries are not
 * entered: each is a core of its own.
 */
const forEachAggregateCall = (e: Expr, f: (call: FunctionCall) => void): void => {
	const all = (list: ReadonlyArray<Expr>): void => {
		for (const item of list) {
			forEachAggregateCall(item, f)
		}
	}
	const ordered = (items: ReadonlyArray<OrderItem>): void => {
		all(Arr.map(items, (item) => item.expr))
	}
	switch (e.kind) {
		case "column":
		case "excluded":
		case "returning":
		case "param":
		case "clock":
		case "literal":
		case "exists":
		case "subquery":
		case "array":
		case "mergeAction":
		case "domainValue":
		case "plVar":
		case "plSpecial":
		case "field":
		case "user":
		case "regclass":
			return
		case "cast":
		case "access":
		case "collate":
		case "negate":
		case "not":
		case "isTrue":
		case "complement":
		case "lowerAscii":
		case "inQuery":
			forEachAggregateCall(e.expr, f)
			return
		case "attribute":
			forEachAggregateCall(e.record, f)
			return
		case "nullif":
			all([e.expr, e.absent])
			return
		case "subscript":
			all([e.array, e.index])
			return
		case "binary":
			all([e.left, e.right])
			return
		case "and":
		case "or":
		case "greatest":
		case "least":
			all(e.args)
			return
		case "coalesce":
			all(Arr.lastNonEmpty(e.args).kind === "literal" ? [] : e.args)
			return
		case "between":
			all([e.expr, e.low, e.high])
			return
		case "equalsAny":
			all([e.expr, e.array])
			return
		case "inList":
			all([e.expr, ...e.list])
			return
		case "row":
			all(e.items)
			return
		case "case":
			if (e.operand !== undefined) {
				forEachAggregateCall(e.operand, f)
			}
			for (const branch of e.whens) {
				all([branch.when, branch.result])
			}
			forEachAggregateCall(e.else, f)
			return
		case "call":
			if (e.over === undefined) {
				f(e)
			}
			all(e.args)
			if (e.star && e.filter !== undefined) {
				forEachAggregateCall(e.filter, f)
			}
			if (!e.star) {
				ordered(e.orderBy)
				ordered(e.withinGroup)
			}
			if (e.over !== undefined) {
				all(e.over.partitionBy)
				ordered(e.over.orderBy)
			}
			return
	}
}

/**
 * The first query below a chain of parenthesized bodies without clauses that carries a WITH or a tail clause:
 * PostgreSQL folds every one of those parentheses, so its clauses merge with those of the query above the chain.
 */
const clausesBelow = (body: OperandBody): OperandSelect | undefined => {
	let current = body
	while (current.kind === "select") {
		if (hasClauses(current)) {
			return current
		}
		current = current.body
	}
	return undefined
}

/** Whether a query carries a WITH or a tail clause. */
const hasClauses = (select: OperandSelect): boolean =>
	select.with !== undefined ||
	select.orderBy.length > 0 ||
	select.limit !== undefined ||
	select.offset !== undefined

export interface StatementAudit {
	readonly violations: ReadonlyArray<SqlViolation>
	/** The type of each placeholder $1..$n, in order. */
	readonly params: ReadonlyArray<TypeRef>
}

/**
 * The test kernel's structural audit of emitted SQL: the emission discipline the AST's constructors and the printer
 * keep, checked over every statement the suites emit (checkedLowering, the installation and write kernels), never on
 * the compile path.
 *
 * Two layers, both structural:
 *
 * - The statement audit walks the AST and checks what its types cannot carry: single-assignment r<n>/c<n> naming with
 *   every relation alias defined once per statement, explicit column lists on CTEs and derived tables, generated names
 *   everywhere but the outermost output; contiguous,
 *   consistently typed parameters and none in DDL; identifier and literal validity; the fixed collation on every
 *   column and domain of type text; RETURNING old./new. only where every returned row has that version, or under IS
 *   TRUE an INSERT's old where its ON CONFLICT DO SELECT or DO UPDATE returns the stored row it meets; and no query
 *   body that PostgreSQL would merge with its enclosing query's clauses, through any chain of parentheses; a
 *   data-modifying CTE only in the statement's own WITH; UNION arms named by position with the union's names; no builtin function outside the catalogue of
 *   ast.ts; and none of the NULL-yielding aggregate and window forms: LEAD or LAG
 *   without its default (R27), or a NULL-on-empty aggregate in an ungrouped core.
 * - The text audit lexes the printed text (lexer.ts) and refuses, wherever they occur outside identifiers, strings,
 *   dollar bodies and comments: NULL (other than a column constraint's NOT NULL in table DDL), IS [NOT] NULL, ISNULL,
 *   NOTNULL, IS UNKNOWN, outer joins, SELECT * and RETURNING *, SKIP LOCKED, an uncast parameter,
 *   an untyped literal outside the positions SQL syntax requires a bare string, a table CHECK not of the form
 *   CHECK ((...) IS TRUE), a domain CHECK not of the form CHECK (VALUE IS NULL OR (...) IS TRUE), whose VALUE IS NULL
 *   is the one null test admitted, a CASE expression without ELSE, and a COLLATE naming any collation but
 *   pg_catalog.pg_c_utf8, but pg_catalog."C" as the one argument of a text's ASCII case fold,
 *   `pg_catalog.lower(x COLLATE pg_catalog."C") COLLATE pg_catalog.pg_c_utf8`. NULLIF, a closed read's absence that IS TRUE or NOT NULL around it refuses, and COALESCE, the
 *   pack's absent cell and a family write's value where no row supplies one, are admitted. A PL/pgSQL body is audited the same way. The AST cannot express most of what the text audit
 *   refuses, and the printer's output must pass it.
 *
 * An audit failure is a compiler defect, reported as a CompileError: MalformedDescription for a structurally malformed
 * statement, UnsupportedOperation for SQL the emission discipline forbids.
 *
 * That every name a statement reads is bound where it reads it (a column's qualifier by a relation in reach, a CTE by a
 * WITH in reach, a variable by its body, an unqualified column by its table or its operation's outputs) is no rule of
 * the audit: the printer holds every statement it prints to it, an internal compiler error (sql/scope.ts).
 */
export const auditStatementDetailed = (statement: SqlStatement): StatementAudit => {
	const auditor = new StatementAuditor()
	auditor.statement(statement)
	auditor.checkParamNumbering()
	return { violations: auditor.violations, params: auditor.params() }
}

export const auditStatementViolations = (statement: SqlStatement): ReadonlyArray<SqlViolation> =>
	auditStatementDetailed(statement).violations

export const auditStatement = (statement: SqlStatement): Result.Result<void, CompileError> =>
	firstOrOk(auditStatementViolations(statement), "sql statement")

const isWord = (token: Token | undefined, upper: string): boolean =>
	token?.kind === "word" && token.upper === upper

const isPunct = (token: Token | undefined, text: string): boolean =>
	token?.kind === "punct" && token.text === text

/**
 * Whether the "(" at `open`, closed by the token after it, is a column list PostgreSQL writes empty only by leaving it
 * out: an alias's (`AS "r1"()`), a CTE's (`"r1"() AS (`) or an INSERT's (`INSERT INTO "s"."t"()`). A table's column
 * definitions (`CREATE TABLE "t" ()`) and a call's arguments (`"pg_catalog"."now"()`) are neither.
 */
const isEmptiedList = (tokens: ReadonlyArray<Token>, open: number): boolean => {
	const name = tokens[open - 1]
	if (name?.kind !== "quotedIdent" && name?.kind !== "word") {
		return false
	}
	const before = tokens[open - 2]
	const body = tokens[open + 3]
	const cte =
		!isPunct(before, ".") &&
		isWord(tokens[open + 2], "AS") &&
		(isPunct(body, "(") || isWord(body, "MATERIALIZED") || isWord(body, "NOT"))
	return isWord(before, "AS") || cte || insertsInto(tokens, open - 1)
}

/** Whether the name ending at `last`, a qualified name read backwards through its dots, follows INSERT INTO. */
const insertsInto = (tokens: ReadonlyArray<Token>, last: number): boolean => {
	let first = last
	while (isPunct(tokens[first - 1], ".")) {
		first -= 2
	}
	return isWord(tokens[first - 1], "INTO") && isWord(tokens[first - 2], "INSERT")
}

/** (-<number>)::type, the printer's form for a negative typed constant, around the number at `i`. */
const negativeTyped = (tokens: ReadonlyArray<Token>, i: number): boolean => {
	const prev = tokens[i - 1]
	return (
		prev?.kind === "operator" &&
		prev.text === "-" &&
		isPunct(tokens[i - 2], "(") &&
		isPunct(tokens[i + 1], ")") &&
		isPunct(tokens[i + 2], "::")
	)
}

/** Whether the `*` at `i` is a column wildcard: after SELECT, DISTINCT, ALL, RETURNING, ",", "." or "(" other than
 * pg_catalog's count(*), as the printer qualifies it. */
const isColumnWildcard = (tokens: ReadonlyArray<Token>, i: number): boolean => {
	const prev = tokens[i - 1]
	const afterWord = prev?.kind === "word" && starPredecessors.has(prev.upper)
	const afterPunct = isPunct(prev, ",") || isPunct(prev, ".")
	const count = tokens[i - 2]
	const countStar =
		isPunct(prev, "(") &&
		count?.kind === "quotedIdent" &&
		count.text === "count" &&
		isPunct(tokens[i - 3], ".") &&
		isPunct(tokens[i + 1], ")")
	return afterWord || afterPunct || (isPunct(prev, "(") && !countStar)
}

/** Words that end a query clause at its own depth: the next clause's, a set operation's, or PL/pgSQL's after a query. */
const clauseEnders: ReadonlySet<string> = new Set([
	"SELECT",
	"FROM",
	"WHERE",
	"HAVING",
	"WINDOW",
	"ORDER",
	"LIMIT",
	"OFFSET",
	"FETCH",
	"FOR",
	"UNION",
	"INTERSECT",
	"EXCEPT",
	"RETURNING",
	"INTO",
	"LOOP"
])

/** Words that may follow a clause item that ends at its last token: a sort's direction or ordering, or the next clause. */
const itemEnders: ReadonlySet<string> = new Set([...clauseEnders, "ASC", "DESC", "NULLS", "USING"])

/** The "(" whose parenthesis holds the token at `i`, if one does: the last before it one level out. */
const enclosingParen = (
	tokens: ReadonlyArray<Token>,
	depths: ReadonlyArray<number>,
	i: number
): number | undefined => {
	const depth = depths[i] ?? 0
	for (let k = i - 1; k >= 0; k--) {
		if (isPunct(tokens[k], "(") && depths[k] === depth - 1) {
			return k
		}
	}
	return undefined
}

/**
 * Whether the ORDER BY whose BY is at `i` orders a query: it stands in no parenthesis, or in one a query opens, and not
 * in a call's, after its quoted name, a window's, after OVER, or WITHIN GROUP's.
 */
const ordersQuery = (
	tokens: ReadonlyArray<Token>,
	depths: ReadonlyArray<number>,
	i: number
): boolean => {
	const open = enclosingParen(tokens, depths, i)
	if (open === undefined) {
		return true
	}
	const before = tokens[open - 1]
	if (before?.kind === "quotedIdent" || isWord(before, "OVER") || isWord(before, "GROUP")) {
		return false
	}
	let first = open + 1
	while (isPunct(tokens[first], "(")) {
		first += 1
	}
	return (
		isWord(tokens[first], "SELECT") ||
		isWord(tokens[first], "WITH") ||
		isWord(tokens[first], "VALUES")
	)
}

/** The first token of each item of the clause whose first item starts at `start`, the items its own depth's "," part. */
const clauseItemStarts = (
	tokens: ReadonlyArray<Token>,
	depths: ReadonlyArray<number>,
	start: number
): ReadonlyArray<number> => {
	const depth = depths[start]
	if (depth === undefined) {
		return []
	}
	const starts: Array<number> = [start]
	for (let j = start; j < tokens.length; j++) {
		const t = tokens[j]
		const level: number = depths[j] ?? depth
		if (
			level < depth ||
			isPunct(t, ";") ||
			(level === depth && t?.kind === "word" && clauseEnders.has(t.upper))
		) {
			break
		}
		if (level === depth && isPunct(t, ",")) {
			starts.push(j + 1)
		}
	}
	return starts
}

/**
 * Whether the item starting at `start` is a bare constant as PostgreSQL's grammar reads one: a number, string, dollar
 * string, TRUE or FALSE, in any parentheses, a number under any unary minus too, which gram.y folds into it (doNegate),
 * and nothing after it within the item. NULL is the null rule's.
 */
const bareConstantAt = (tokens: ReadonlyArray<Token>, start: number): boolean => {
	let j = start
	let opened = 0
	let negated = false
	for (
		let t = tokens[j];
		isPunct(t, "(") || (t?.kind === "operator" && t.text === "-");
		t = tokens[j]
	) {
		opened += isPunct(t, "(") ? 1 : 0
		negated ||= !isPunct(t, "(")
		j += 1
	}
	const constant = tokens[j]
	const bare =
		constant?.kind === "number" ||
		(!negated &&
			(constant?.kind === "string" ||
				constant?.kind === "dollar" ||
				isWord(constant, "TRUE") ||
				isWord(constant, "FALSE")))
	if (!bare) {
		return false
	}
	for (let k = 0; k < opened; k++) {
		j += 1
		if (!isPunct(tokens[j], ")")) {
			return false
		}
	}
	const after = tokens[j + 1]
	return (
		after === undefined ||
		isPunct(after, ",") ||
		isPunct(after, ")") ||
		isPunct(after, ";") ||
		(after.kind === "word" && itemEnders.has(after.upper))
	)
}

/** Index of the punct ")" matching the "(" at `open`, if one does. */
const matchingParen = (tokens: ReadonlyArray<Token>, open: number): Option.Option<number> => {
	let depth = 0
	for (let i = open; i < tokens.length; i++) {
		const t = tokens[i]
		depth += isPunct(t, "(") ? 1 : isPunct(t, ")") ? -1 : 0
		if (isPunct(t, ")") && depth === 0) {
			return Option.some(i)
		}
	}
	return Option.none()
}

/** The numeric constants PostgreSQL types integer by themselves: plain digits within int4. */
const isInt4Constant = (text: string): boolean => {
	for (const c of text) {
		if (c < "0" || c > "9") {
			return false
		}
	}
	return BigInt(text) <= integerRanges.int4[1]
}

/** Words that introduce a statement whose syntax requires bare strings in fixed places, or column NOT NULL. */
type StatementShape =
	| "createTable"
	| "alterTable"
	| "domain"
	| "settings"
	| "function"
	| "do"
	| "comment"
	| "other"

const statementShape = (tokens: ReadonlyArray<Token>): StatementShape => {
	const w = (i: number): string | undefined => {
		const t = tokens[i]
		return t?.kind === "word" ? t.upper : undefined
	}
	if (w(0) === "CREATE" && w(1) === "TABLE") {
		return "createTable"
	}
	if (w(0) === "CREATE" && (w(1) === "TEMPORARY" || w(1) === "TEMP") && w(2) === "TABLE") {
		return "createTable"
	}
	if (w(0) === "ALTER" && w(1) === "TABLE") {
		return "alterTable"
	}
	if ((w(0) === "CREATE" || w(0) === "ALTER") && w(1) === "DOMAIN") {
		return "domain"
	}
	if (w(0) === "ALTER" && w(1) === "ROLE") {
		return "settings"
	}
	if (
		w(0) === "CREATE" &&
		(w(1) === "FUNCTION" || (w(1) === "OR" && w(2) === "REPLACE" && w(3) === "FUNCTION"))
	) {
		return "function"
	}
	if (w(0) === "DO") {
		return "do"
	}
	if (w(0) === "COMMENT" && w(1) === "ON") {
		return "comment"
	}
	return "other"
}

/**
 * The prefixes of the string constants grizzle writes, each held to its cast as any string: a bit string's hex digits,
 * X'' (sql/print.ts), and a constant holding a line feed inside a PL/pgSQL block, its escape string E'' (sql/escape.ts
 * lineFeedsEscaped). A string of every other prefix, a binary B'' among them, is refused.
 */
const writtenPrefixes: ReadonlySet<string> = new Set(["X", "E"])

const raiseLevels: ReadonlySet<string> = new Set([
	"EXCEPTION",
	"NOTICE",
	"WARNING",
	"INFO",
	"LOG",
	"DEBUG"
])
/** Where a PL/pgSQL CASE statement can begin. */
const statementStarters: ReadonlySet<string> = new Set(["THEN", "ELSE", "LOOP", "BEGIN"])
/** Before a "*" that is a column wildcard rather than multiplication. */
const starPredecessors: ReadonlySet<string> = new Set(["SELECT", "DISTINCT", "ALL", "RETURNING"])

/**
 * The words a column constraint's NOT NULL may follow: the last word of a builtin type, the end of a stored
 * generation, ALTER COLUMN ... SET, and a boolean DEFAULT. PostgreSQL has no `<operand> NOT NULL` expression, so after
 * one of these, or after a quoted name, a number, ")" or "]", NOT NULL can only be the constraint. After an operator,
 * "(", ",", or any other word (AND, IS, DROP, DEFAULT, WHEN, AS, ...) it is the expression NOT(NULL), a NULL.
 */
const notNullPredecessors: ReadonlySet<string> = new Set([
	...Arr.map(builtinTypeNames, (name) => {
		const upper = Str.toUpperCase(name)
		return Option.match(Str.lastIndexOf(" ")(upper), {
			onNone: () => upper,
			onSome: (at) => Str.slice(at + 1)(upper)
		})
	}),
	"STORED",
	"SET",
	"TRUE",
	"FALSE",
	Str.toUpperCase(placeholderToken)
])

/**
 * Whether the CHECK at `i` is a domain's, `CHECK (VALUE IS NULL OR (<predicate>) IS TRUE)`: NULL is a value of every
 * domain, which a column's NOT NULL refuses, and a present value is admitted only where the predicate is true.
 */
const isDomainCheck = (tokens: ReadonlyArray<Token>, i: number): boolean => {
	const outerClose = isPunct(tokens[i + 1], "(") ? matchingParen(tokens, i + 1) : Option.none()
	const innerClose = isPunct(tokens[i + 6], "(") ? matchingParen(tokens, i + 6) : Option.none()
	return (
		Option.isSome(outerClose) &&
		Option.isSome(innerClose) &&
		isWord(tokens[i + 2], "VALUE") &&
		isWord(tokens[i + 3], "IS") &&
		isWord(tokens[i + 4], "NULL") &&
		isWord(tokens[i + 5], "OR") &&
		isWord(tokens[innerClose.value + 1], "IS") &&
		isWord(tokens[innerClose.value + 2], "TRUE") &&
		innerClose.value + 3 === outerClose.value
	)
}

/** Whether NULL at `i` is a domain CHECK's own null test, the `VALUE IS NULL` that opens it (`isDomainCheck`). */
const isDomainNullTest = (
	tokens: ReadonlyArray<Token>,
	i: number,
	shape: StatementShape
): boolean =>
	shape === "domain" &&
	isWord(tokens[i - 1], "IS") &&
	isWord(tokens[i - 2], "VALUE") &&
	isPunct(tokens[i - 3], "(") &&
	isWord(tokens[i - 4], "CHECK") &&
	isDomainCheck(tokens, i - 4)

/**
 * Whether NULL at `i` ends a column constraint NOT NULL: in table DDL, at the column-definition level (inside the
 * CREATE TABLE element list, or at the top of an ALTER TABLE action), after a predecessor that ends a column type or
 * definition.
 */
const isColumnNotNull = (
	tokens: ReadonlyArray<Token>,
	depths: ReadonlyArray<number>,
	i: number,
	shape: StatementShape
): boolean => {
	if (shape !== "createTable" && shape !== "alterTable") {
		return false
	}
	if (!isWord(tokens[i - 1], "NOT")) {
		return false
	}
	if (depths[i] !== (shape === "createTable" ? 1 : 0)) {
		return false
	}
	return endsColumnDefinition(tokens[i - 2])
}

/** Whether `before`, the token before a NOT NULL, ends a column's type or definition. */
const endsColumnDefinition = (before: Token | undefined): boolean => {
	if (before === undefined) {
		return false
	}
	switch (before.kind) {
		case "quotedIdent":
		case "number":
			return true
		case "punct":
			return before.text === ")" || before.text === "]"
		case "word":
			return notNullPredecessors.has(before.upper)
		case "string":
		case "dollar":
		case "param":
		case "operator":
			return false
	}
}

/**
 * Whether NULL at `i`, in a PL/pgSQL body, ends a column constraint NOT NULL of a session table's CREATE TEMPORARY
 * TABLE "pg_temp".<name> (<columns>) the body runs: a rule judge's delta or sentinel, stood up by a table's stand-up
 * (physical/ddl/rules.ts addStandUps), at the level of the table's element list, after a predecessor that ends a column's
 * definition.
 */
const isSessionTableNotNull = (
	tokens: ReadonlyArray<Token>,
	depths: ReadonlyArray<number>,
	i: number,
	pl: boolean
): boolean => {
	if (!pl || !isWord(tokens[i - 1], "NOT")) {
		return false
	}
	const level = (depths[i] ?? 0) - 1
	const opener = Arr.findLastIndex(
		tokens.slice(0, i),
		(t, k) => isPunct(t, "(") && depths[k] === level
	)
	return Option.exists(
		opener,
		(j) =>
			tokens[j - 1]?.kind === "quotedIdent" &&
			isPunct(tokens[j - 2], ".") &&
			part(tokens[j - 3], "pg_temp") &&
			isWord(tokens[j - 4], "TABLE") &&
			isWord(tokens[j - 5], "TEMPORARY") &&
			isWord(tokens[j - 6], "CREATE") &&
			endsColumnDefinition(tokens[i - 2])
	)
}

const part = (t: Token | undefined, name: string): boolean =>
	(t?.kind === "quotedIdent" && t.text === name) ||
	(t?.kind === "word" && t.upper === Str.toUpperCase(name))

/** Whether the tokens at `i` spell the one collation, quoted or bare: pg_catalog.pg_c_utf8. */
const isCUtf8Name = (tokens: ReadonlyArray<Token>, i: number): boolean =>
	part(tokens[i], "pg_catalog") && isPunct(tokens[i + 1], ".") && part(tokens[i + 2], "pg_c_utf8")

/**
 * Whether the COLLATE at `i` is a text's ASCII case fold's, `pg_catalog.lower(x COLLATE pg_catalog."C") COLLATE
 * pg_catalog.pg_c_utf8` (sql/ast.ts Expr's lowerAscii): it names the C collation, quoted, and closes the one argument of
 * a call of pg_catalog.lower whose result is collated pg_c_utf8 at once, so no C collation reaches anything but lower.
 */
const isAsciiFoldCollate = (
	tokens: ReadonlyArray<Token>,
	depths: ReadonlyArray<number>,
	i: number
): boolean => {
	const name = tokens[i + 3]
	if (
		!part(tokens[i + 1], "pg_catalog") ||
		!isPunct(tokens[i + 2], ".") ||
		name?.kind !== "quotedIdent" ||
		name.text !== "C" ||
		!isPunct(tokens[i + 4], ")") ||
		!isWord(tokens[i + 5], "COLLATE") ||
		!isCUtf8Name(tokens, i + 6)
	) {
		return false
	}
	const depth = depths[i] ?? 0
	const open = Arr.findLastIndex(
		Arr.take(tokens, i),
		(t, j) => isPunct(t, "(") && depths[j] === depth - 1
	)
	return Option.exists(
		open,
		(o) =>
			part(tokens[o - 3], "pg_catalog") &&
			isPunct(tokens[o - 2], ".") &&
			part(tokens[o - 1], "lower")
	)
}

/** The paren depth at each token: the number of "(" open before it. */
const parenDepths = (tokens: ReadonlyArray<Token>): ReadonlyArray<number> => {
	const depths: Array<number> = []
	let depth = 0
	for (const t of tokens) {
		if (isPunct(t, ")")) {
			depth -= 1
		}
		depths.push(depth)
		if (isPunct(t, "(")) {
			depth += 1
		}
	}
	return depths
}

/**
 * An open CASE: a PL/pgSQL CASE statement or a CASE expression, whether its ELSE was met, where it starts, whether it
 * opens a column's generation `GENERATED ALWAYS AS (CASE`, and how many WHENs it has met.
 */
interface CaseFrame {
	readonly statement: boolean
	readonly elseSeen: boolean
	readonly start: number
	readonly generation: boolean
	readonly whens: number
}

/** The CASEs open at a token, innermost last; each statement starts with none. */
type OpenCases = ReadonlyArray<CaseFrame>

class TextAuditor {
	readonly violations: Array<SqlViolation> = []
	readonly base: number
	/** How many guarded terms the text may still hold: its statement's partial generations not yet met (guardedTermsOf). */
	#guarded: number
	constructor(base: number, guarded: number) {
		this.base = base
		this.#guarded = guarded
	}

	/**
	 * Whether a CASE of a guarded term's shape is one of its statement's partial generations: admitted while the
	 * statement's count of them lasts, each once. A text cannot tell a partial generation from a stored generation of a
	 * CASE whose ELSE went missing, whose print is that shape too, so the statement's AST says how many there are.
	 */
	admitsGuardedTerm(): boolean {
		if (this.#guarded === 0) {
			return false
		}
		this.#guarded -= 1
		return true
	}

	report(rule: AuditRule, offset: number, detail: string): void {
		this.violations.push({ rule, where: `offset ${this.base + offset}`, detail })
	}

	/**
	 * One statement's tokens. `pl` marks a PL/pgSQL body, where SQL statements are not split by the caller.
	 *
	 * RENAME VALUE '<label>' TO '<label>'.
	 *
	 * COMMENT ON <object> IS '<text>': the string right after IS is a string constant of COMMENT's own grammar, which
	 * takes no expression there (`IS 'x'::text` is a syntax error), whatever follows it: tokens after it break another
	 * rule, never this one.
	 *
	 * RAISE [level] '<format>'.
	 *
	 * The body of CREATE FUNCTION ... AS $tag$ ... $tag$, or of DO $tag$ ... $tag$, is PL/pgSQL, audited the
	 * same way.
	 *
	 * A column wildcard: after SELECT, DISTINCT, ALL, RETURNING, ",", "." or "(" other than count(*).
	 */
	statement(tokens: ReadonlyArray<Token>, pl: boolean): void {
		const shape: StatementShape = pl ? "other" : statementShape(tokens)
		const depths = parenDepths(tokens)
		let cases: OpenCases = []
		for (const [i, t] of tokens.entries()) {
			cases = this.token(tokens, depths, i, t, shape, pl, cases)
		}
		for (const frame of cases) {
			if (!frame.statement) {
				this.report("caseWithoutElse", frame.start, "an unterminated CASE")
			}
		}
	}

	/** One token of a statement, judged by its kind, under the CASEs open before it; returns those open after it. */
	token(
		tokens: ReadonlyArray<Token>,
		depths: ReadonlyArray<number>,
		i: number,
		t: Token,
		shape: StatementShape,
		pl: boolean,
		cases: OpenCases
	): OpenCases {
		const prev = tokens[i - 1]
		const next = tokens[i + 1]
		switch (t.kind) {
			case "word":
				return this.word(tokens, depths, i, t, shape, pl, cases)
			case "param":
				if (!isPunct(next, "::")) {
					this.report("uncastParam", t.start, `$${t.index} is not cast`)
				}
				break
			case "string": {
				if (t.prefix !== undefined && !writtenPrefixes.has(t.prefix)) {
					this.report("untypedLiteral", t.start, `a ${t.prefix}'' string literal`)
					break
				}
				if (isPunct(next, "::")) {
					break
				}
				if (shape === "comment" && isWord(prev, "IS")) {
					break
				}
				/**
				 * SET <parameter> = '<value>' and SET <parameter> TO '<value>', the parameter a name or an
				 * extension's qualified `<prefix>.<name>` (hnsw.iterative_scan).
				 */
				const assigned = (prev?.kind === "operator" && prev.text === "=") || isWord(prev, "TO")
				const setsParameter =
					isWord(tokens[i - 3], "SET") ||
					(isPunct(tokens[i - 3], ".") && isWord(tokens[i - 5], "SET"))
				if ((shape === "settings" || shape === "function") && assigned && setsParameter) {
					break
				}
				if (
					pl &&
					(isWord(prev, "RAISE") ||
						(prev?.kind === "word" &&
							raiseLevels.has(prev.upper) &&
							isWord(tokens[i - 2], "RAISE")))
				) {
					break
				}
				this.report("untypedLiteral", t.start, "a string literal without a cast")
				break
			}
			case "dollar":
				if (
					(shape === "function" && isWord(prev, "AS")) ||
					(shape === "do" && isWord(prev, "DO"))
				) {
					this.plBody(t)
				} else if (!isPunct(next, "::")) {
					this.report("untypedLiteral", t.start, "a dollar-quoted literal without a cast")
				}
				break
			case "number":
				if (!isInt4Constant(t.text) && !isPunct(next, "::") && !negativeTyped(tokens, i)) {
					this.report("untypedLiteral", t.start, `the numeric constant ${t.text} without a cast`)
				}
				break
			case "operator":
				if (t.text === "*" && isColumnWildcard(tokens, i)) {
					this.report("selectStar", t.start, "a column wildcard")
				}
				break
			case "punct":
				if (t.text === "(" && isPunct(next, ")") && isEmptiedList(tokens, i)) {
					this.report(
						"emptyList",
						t.start,
						"an empty column list, which PostgreSQL spells by leaving the list out"
					)
				}
				break
			case "quotedIdent":
				break
		}
		return cases
	}

	/**
	 * A query's ORDER BY, GROUP BY and DISTINCT ON read a bare constant item as an output column's position, an integer
	 * one, and refuse any other (parse_clause.c findTargetlistEntrySQL92): never the constant it spells. A window's and
	 * an aggregate's ORDER BY read their items as values.
	 */
	positionalItems(
		tokens: ReadonlyArray<Token>,
		depths: ReadonlyArray<number>,
		start: number,
		clause: string
	): void {
		for (const at of clauseItemStarts(tokens, depths, start)) {
			const t = tokens[at]
			if (t !== undefined && bareConstantAt(tokens, at)) {
				this.report(
					"positional",
					t.start,
					`a bare constant ${clause} item, which PostgreSQL reads as an output column's position or refuses`
				)
			}
		}
	}

	/** The body of CREATE FUNCTION ... AS $tag$ ... $tag$ or DO $tag$ ... $tag$, audited as PL/pgSQL. */
	plBody(t: Extract<Token, { kind: "dollar" }>): void {
		const body = lex(t.body)
		if (body.error !== undefined) {
			this.report("lex", t.bodyStart + body.error.offset, body.error.message)
			return
		}
		const inner = new TextAuditor(this.base + t.bodyStart, 0)
		inner.statement(body.tokens, true)
		appendAll(this.violations, inner.violations)
	}

	/**
	 * NOT NULL is a column constraint in table DDL; anywhere else, IS NOT NULL and DROP NOT NULL included,
	 * NULL is a NULL.
	 *
	 * A table's CHECK ((<predicate>) IS TRUE) and a domain's CHECK (VALUE IS NULL OR (<predicate>) IS TRUE), and
	 * nothing else: a table refuses a row its predicate leaves unknown, and a domain admits NULL, which a column's NOT
	 * NULL refuses, so its VALUE IS NULL is the one null test the audit admits. A policy's WITH CHECK (<predicate>)
	 * is no constraint: row security admits a row only when the predicate is true, so NULL refuses it already, and an
	 * IS TRUE around the predicate would only hide it from the planner's index quals.
	 *
	 * The CASE of END CASE closes a statement; it opens nothing.
	 *
	 * A CASE expression without ELSE yields NULL when no branch matches. The one CASE without ELSE is a law column's
	 * guarded term, `GENERATED ALWAYS AS (CASE WHEN φ THEN t END) STORED`, whose NULL outside φ is the column's
	 * design: a key over it holds apart only the rows φ selects, and a reference out of it binds only those.
	 */
	word(
		tokens: ReadonlyArray<Token>,
		depths: ReadonlyArray<number>,
		i: number,
		t: Extract<Token, { kind: "word" }>,
		shape: StatementShape,
		pl: boolean,
		cases: OpenCases
	): OpenCases {
		const prev = tokens[i - 1]
		const next = tokens[i + 1]
		switch (t.upper) {
			case "NULL":
				if (
					!isColumnNotNull(tokens, depths, i, shape) &&
					!isSessionTableNotNull(tokens, depths, i, pl) &&
					!isDomainNullTest(tokens, i, shape)
				) {
					this.report("null", t.start, "NULL")
				}
				return cases
			case "COLLATE":
				if (!isCUtf8Name(tokens, i + 1) && !isAsciiFoldCollate(tokens, depths, i)) {
					this.report(
						"collation",
						t.start,
						"a COLLATE naming a collation other than pg_catalog.pg_c_utf8, but in a text's ASCII case fold"
					)
				}
				return cases
			case "ISNULL":
			case "NOTNULL":
				this.report("null", t.start, `the null test ${t.upper}`)
				return cases
			case "UNKNOWN":
				if (isWord(prev, "IS") || (isWord(prev, "NOT") && isWord(tokens[i - 2], "IS"))) {
					this.report("null", t.start, "the null test IS UNKNOWN")
				}
				return cases
			case "OUTER":
				this.report("outerJoin", t.start, "an outer join")
				return cases
			case "LEFT":
			case "RIGHT":
			case "FULL":
				if (isWord(next, "JOIN") || isWord(next, "OUTER")) {
					this.report("outerJoin", t.start, `a ${t.upper} JOIN`)
				}
				return cases
			case "BY": {
				const clause = isWord(prev, "GROUP")
					? "GROUP BY"
					: isWord(prev, "ORDER") && ordersQuery(tokens, depths, i)
						? "ORDER BY"
						: undefined
				if (clause !== undefined) {
					this.positionalItems(tokens, depths, i + 1, clause)
				}
				return cases
			}
			case "ON":
				if (isWord(prev, "DISTINCT") && isPunct(next, "(")) {
					this.positionalItems(tokens, depths, i + 2, "DISTINCT ON")
				}
				return cases
			case "SKIP":
				if (isWord(next, "LOCKED")) {
					this.report("skipLocked", t.start, "SKIP LOCKED")
				}
				return cases
			case "CHECK": {
				if (isWord(prev, "WITH")) {
					return cases
				}
				if (shape === "domain") {
					if (!isDomainCheck(tokens, i)) {
						this.report(
							"domainCheckRefusingNull",
							t.start,
							"a domain CHECK not of the form CHECK (VALUE IS NULL OR (...) IS TRUE)"
						)
					}
					return cases
				}
				const outer = i + 1
				const outerClose = isPunct(tokens[outer], "(")
					? matchingParen(tokens, outer)
					: Option.none()
				const inner = outer + 1
				const innerClose = isPunct(tokens[inner], "(")
					? matchingParen(tokens, inner)
					: Option.none()
				const wrapped =
					Option.isSome(outerClose) &&
					Option.isSome(innerClose) &&
					isWord(tokens[innerClose.value + 1], "IS") &&
					isWord(tokens[innerClose.value + 2], "TRUE") &&
					innerClose.value + 3 === outerClose.value
				if (!wrapped) {
					this.report("checkWithoutIsTrue", t.start, "a CHECK not wrapped as CHECK ((...) IS TRUE)")
				}
				return cases
			}
			case "CASE": {
				if (isWord(prev, "END")) {
					return cases
				}
				/**
				 * A PL/pgSQL CASE statement starts a statement; inside a CASE expression every CASE is an expression.
				 */
				const statement =
					pl &&
					Option.match(Arr.last(cases), { onNone: () => true, onSome: (top) => top.statement }) &&
					(prev === undefined ||
						isPunct(prev, ";") ||
						(prev.kind === "word" && statementStarters.has(prev.upper)))
				const generation =
					isPunct(prev, "(") &&
					isWord(tokens[i - 2], "AS") &&
					isWord(tokens[i - 3], "ALWAYS") &&
					isWord(tokens[i - 4], "GENERATED")
				return Arr.append(cases, {
					statement,
					elseSeen: false,
					start: t.start,
					generation,
					whens: 0
				})
			}
			case "WHEN":
				return Arr.matchRight(cases, {
					onEmpty: () => cases,
					onNonEmpty: (outer, top) =>
						top.statement ? cases : Arr.append(outer, { ...top, whens: top.whens + 1 })
				})
			case "ELSE":
				return Arr.matchRight(cases, {
					onEmpty: () => cases,
					onNonEmpty: (outer, top) =>
						top.statement ? cases : Arr.append(outer, { ...top, elseSeen: true })
				})
			case "END":
				return Arr.matchRight(cases, {
					onEmpty: () => cases,
					onNonEmpty: (outer, top) => {
						if (top.statement) {
							return isWord(next, "CASE") ? outer : cases
						}
						const guardedTerm =
							top.generation &&
							top.whens === 1 &&
							isPunct(next, ")") &&
							isWord(tokens[i + 2], "STORED")
						if (!top.elseSeen && !(guardedTerm && this.admitsGuardedTerm())) {
							this.report("caseWithoutElse", top.start, "a CASE expression without ELSE")
						}
						return outer
					}
				})
			default:
				return cases
		}
	}
}

/** Splits a script's tokens into statements at top-level ";". */
const splitStatements = (tokens: ReadonlyArray<Token>): ReadonlyArray<ReadonlyArray<Token>> => {
	let current: Array<Token> = []
	const statements: Array<Array<Token>> = [current]
	for (const t of tokens) {
		if (isPunct(t, ";")) {
			current = []
			statements.push(current)
		} else {
			current.push(t)
		}
	}
	return Arr.filter(statements, (s) => s.length > 0)
}

export const auditTextViolations = (text: string, guarded: number): ReadonlyArray<SqlViolation> =>
	auditLexedViolations(lex(text), guarded)

/**
 * The guarded terms a statement prints, `GENERATED ALWAYS AS (CASE WHEN φ THEN t END) STORED`: its columns' partial
 * generations (StoredGeneration `partial`), the one CASE without ELSE the text audit admits, and only as many times.
 */
export const guardedTermsOf = (statement: SqlStatement): number => {
	const partial = (g: StoredGeneration | undefined): number => (g?.kind === "partial" ? 1 : 0)
	if (statement.kind === "createTable") {
		return Arr.reduce(statement.columns, 0, (n, c) => n + partial(c.generated))
	}
	return statement.kind !== "alterTable"
		? 0
		: Arr.reduce(statement.actions, 0, (n, a) => {
				switch (a.kind) {
					case "addColumn":
					case "addColumnPlaceholder":
					case "addColumnDefault":
					case "addColumnUnchecked":
						return n + partial(a.column.generated)
					case "setExpression":
						return n + partial(a.generation)
					case "setNotNull":
					case "dropColumn":
					case "dropDefault":
					case "alterColumnType":
					case "addConstraint":
					case "addConstraintUsingIndex":
					case "validateConstraint":
					case "alterConstraintDeferral":
					case "dropConstraint":
					case "enableRowSecurity":
					case "disableRowSecurity":
					case "replicaIdentity":
						return n
				}
			})
}

/** The text audit of a text's tokens, as lex read them, its statement holding `guarded` guarded terms. */
const auditLexedViolations = (lexed: Lexed, guarded: number): ReadonlyArray<SqlViolation> => {
	if (lexed.error !== undefined) {
		return [{ rule: "lex", where: `offset ${lexed.error.offset}`, detail: lexed.error.message }]
	}
	const auditor = new TextAuditor(0, guarded)
	for (const statement of splitStatements(lexed.tokens)) {
		auditor.statement(statement, false)
	}
	return auditor.violations
}
