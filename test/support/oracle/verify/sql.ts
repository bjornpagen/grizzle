import { Array as Arr, Option, Order, Result, String as Str } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { CompileError, prose } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import {
	type Analyze,
	builtinFunctionNames,
	builtinTypeNames,
	type Call,
	type Collation,
	type ColumnDef,
	type CommentTarget,
	type CreateCarrier,
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
	type MergeWhen,
	type ObjectName,
	type OrderItem,
	type PlStatement,
	type Select,
	type SelectBody,
	type SelectCore,
	type SqlFunction,
	type SqlStatement,
	type TableConstraint,
	type TableName,
	type Target,
	type TriggerEvent,
	type TypeRef,
	tableConstraints,
	type Update
} from "#compiler/sql/ast.ts"
import { types } from "#compiler/sql/build.ts"
import { type Lexed, lex, type Token } from "#compiler/sql/lexer.ts"
import { bodyPositionNames, isDecimal } from "#compiler/sql/naming.ts"
import { placeholderToken, printType, storedSettingValue } from "#compiler/sql/print.ts"
import { identityHooks, transformExpr } from "#compiler/sql/transform.ts"

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
	| "scope"
	| "context"
	| "positional"
	| "function"
	| "collation"
	| "nullif"
	| "coalesce"
	| "lex"
	| "null"
	| "outerJoin"
	| "selectStar"
	| "skipLocked"
	| "uncastParam"
	| "untypedLiteral"
	| "checkWithoutIsTrue"
	| "caseWithoutElse"
	| "emptyList"

interface SqlViolation {
	readonly rule: AuditRule
	/** A path into the statement ("body.targets[0].expr") or a text offset ("offset 42"). */
	readonly where: string
	readonly detail: string
}

/** Rules whose violation is SQL the discipline forbids rather than a malformed statement. */
const disciplineRules: ReadonlySet<AuditRule> = new Set<AuditRule>([
	"function",
	"collation",
	"null",
	"nullif",
	"coalesce",
	"outerJoin",
	"selectStar",
	"skipLocked",
	"uncastParam",
	"untypedLiteral",
	"checkWithoutIsTrue",
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

const builtinFunctions: ReadonlySet<string> = new Set(builtinFunctionNames)

/**
 * The rule a call of the builtin function `name` breaks, or undefined for a function of the catalogue. The AST type
 * admits only the catalogue; this holds it for data that bypassed the type, so it reads the name as the string it is.
 * COALESCE and NULLIF keep their own rules.
 */
const builtinCallRule = (name: string): AuditRule | undefined => {
	if (builtinFunctions.has(name)) {
		return undefined
	}
	const lower = Str.toLowerCase(name)
	return lower === "coalesce" ? "coalesce" : lower === "nullif" ? "nullif" : "function"
}

const maxIdentifierBytes = 63

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

const integerBounds: Readonly<Record<string, readonly [bigint, bigint]>> = {
	smallint: [-32768n, 32767n],
	integer: [-2147483648n, 2147483647n],
	bigint: [-9223372036854775808n, 9223372036854775807n]
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

/** A relation visible to column references: its columns when the statement defines them, undefined for a table. */
interface Relation {
	readonly columns: ReadonlySet<string> | undefined
}

class Scope {
	readonly relations = new Map<string, Relation>()
	readonly parent: Scope | undefined
	constructor(parent: Scope | undefined) {
		this.parent = parent
	}
	resolve(name: string): Relation | undefined {
		return this.relations.get(name) ?? this.parent?.resolve(name)
	}
}

/** A scope under `parent` holding the relations `arms` names. */
const scopeOver = (
	parent: Scope | undefined,
	arms: ReadonlyArray<readonly [string, Relation]>
): Scope => {
	const scope = new Scope(parent)
	for (const [name, relation] of arms) {
		scope.relations.set(name, relation)
	}
	return scope
}

/** A paren range of tokens: the "(" at `open` and its matching ")" at `close`. */
interface ParenRange {
	readonly open: number
	readonly close: number
}

class CteScope {
	readonly ctes = new Map<string, Relation>()
	readonly parent: CteScope | undefined
	constructor(parent: CteScope | undefined) {
		this.parent = parent
	}
	resolve(name: string): Relation | undefined {
		return this.ctes.get(name) ?? this.parent?.resolve(name)
	}
}

/** Where an expression sits, which decides which reference forms it may use. */
interface ExprContext {
	/**
	 * "query": column references are qualified and resolve in `scope`; "ddl": unqualified, of `tableColumns` when
	 * known; "output": unqualified output names of a set operation, for its ORDER BY; "domain": no column
	 * references, VALUE allowed; "pl": PL/pgSQL expressions outside a query.
	 */
	readonly mode: "query" | "ddl" | "output" | "domain" | "pl"
	readonly scope: Scope | undefined
	readonly ctes: CteScope | undefined
	/** The columns an unqualified reference may name, or undefined when they are not known. */
	readonly tableColumns: ReadonlySet<string> | undefined
	/** Whether EXCLUDED is in reach: inside ON CONFLICT. */
	readonly excluded: boolean
	/**
	 * The row images RETURNING may name: only those every returned row has, since PostgreSQL returns NULL for an
	 * absent one. UPDATE has both; DELETE only old; MERGE old unless it inserts and new unless it
	 * deletes. Undefined outside RETURNING.
	 */
	readonly returningSides: ReadonlySet<"old" | "new"> | undefined
	/** Whether merge_action() is in reach: inside MERGE ... RETURNING. */
	readonly mergeAction: boolean
	/** The PL/pgSQL variables in scope, or undefined outside PL/pgSQL. */
	readonly plVars: ReadonlySet<string> | undefined
}

/**
 * An expression context of `mode` over `scope` and `ctes`, inside PL/pgSQL when `plVars` names its variables, with no
 * table columns known and neither EXCLUDED, RETURNING nor merge_action() in reach.
 */
const context = (
	mode: ExprContext["mode"],
	scope: Scope | undefined,
	ctes: CteScope | undefined,
	plVars: ReadonlySet<string> | undefined
): ExprContext => ({
	mode,
	scope,
	ctes,
	tableColumns: undefined,
	excluded: false,
	returningSides: undefined,
	mergeAction: false,
	plVars
})

/** The row images a trigger's WHEN may read, by its event: an INSERT's NEW, a DELETE's OLD, an UPDATE's both. */
const eventImages: Readonly<Record<TriggerEvent["kind"], ReadonlySet<"NEW" | "OLD">>> = {
	INSERT: new Set(["NEW"]),
	DELETE: new Set(["OLD"]),
	UPDATE: new Set(["NEW", "OLD"])
}

/** The row images an expression reads a field of. */
const imagesRead = (e: Expr): ReadonlySet<"NEW" | "OLD"> => {
	const read = new Set<"NEW" | "OLD">()
	transformExpr(e, {
		...identityHooks,
		expr: (x) => {
			if (x.kind === "field" && x.record.kind === "plSpecial") {
				read.add(x.record.name)
			}
			return x
		}
	})
	return read
}

/**
 * Where a query body sits: its enclosing scope and CTEs, its PL/pgSQL variables, and whether it is the outermost
 * output, whose names may be public.
 */
interface BodyContext {
	readonly scope: Scope | undefined
	readonly ctes: CteScope | undefined
	readonly plVars: ReadonlySet<string> | undefined
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
const bodyWidth = (body: SelectBody): number => {
	switch (body.kind) {
		case "core":
			return body.targets.length
		case "setOp":
			return bodyWidth(body.arms[0])
		case "select":
			return bodyWidth(body.body)
	}
}

const selectWidth = (select: Select): number => bodyWidth(select.body)

/**
 * Whether a query reads the unit relation: one core of no target or of the unit marker alone (`true`), whose rows hold
 * no column a reader names, so a CTE over it lists none.
 */
export const isUnitRead = (select: Select): boolean => {
	const body = select.body
	if (body.kind !== "core") {
		return false
	}
	if (!Arr.isReadonlyArrayNonEmpty(body.targets)) {
		return true
	}
	const [only, ...rest] = body.targets
	return (
		rest.length === 0 &&
		only.alias === undefined &&
		only.expr.kind === "literal" &&
		only.expr.value.kind === "bool" &&
		only.expr.value.value
	)
}

/**
 * The aliases a set operation's later arm writes, position by position (its own first core's); PostgreSQL ignores
 * them, which is why they must agree with the union's names when present.
 */
const bodyAliases = (body: SelectBody): ReadonlyArray<string | undefined> => {
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

	tableName(table: TableName, at: string | number): void {
		if (typeof table === "string") {
			this.ident(table, "carrier", at)
		} else {
			this.objectName(table, "table", at)
		}
	}

	/** A relation alias the statement defines: r<n>, once per statement. */
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
	 * builtin type, and not a named one, whose collation is its own (a text domain carries the fixed one, and an enum or
	 * an extension type takes none).
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
		if (!Number.isSafeInteger(type.precision) || type.precision < 1 || type.precision > 1000) {
			this.report("type", `numeric precision ${type.precision} is outside 1..1000`)
		}
		if (
			type.scale !== undefined &&
			(!Number.isSafeInteger(type.scale) || type.scale < -1000 || type.scale > 1000)
		) {
			this.report("type", `numeric scale ${type.scale} is outside -1000..1000`)
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
			case "text":
				if (Str.includes("\u0000")(value.value)) {
					this.report("literal", "a text literal contains NUL")
				} else if (!isWellFormed(value.value)) {
					this.report("literal", "a text literal is not well-formed UTF-16")
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
			case "literal":
				this.literal(e.value, e.type)
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
					this.expr(e.expr, ctx)
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
				if (ctx.plVars === undefined) {
					this.report("context", `${e.name} outside PL/pgSQL`)
				}
				return
			case "field":
				this.ident(e.field, "record field")
				if (e.record.kind === "plVar") {
					this.plVar(e.record.name, ctx)
				} else if (ctx.plVars === undefined) {
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

	plVar(name: string, ctx: ExprContext): void {
		this.ident(name, "PL/pgSQL variable")
		if (ctx.plVars === undefined) {
			this.report("context", `variable "${name}" outside PL/pgSQL`)
		} else if (!ctx.plVars.has(name)) {
			this.report("scope", `variable "${name}" is not declared`)
		}
	}

	/** In a query every column is referenced as r<n>.c<n> or r<n>.<stored column>. */
	column(e: Extract<Expr, { kind: "column" }>, ctx: ExprContext): void {
		this.ident(e.column, "column")
		if (ctx.mode === "domain") {
			this.report("context", `column "${e.column}" inside a domain CHECK`)
			return
		}
		if (ctx.mode === "ddl" || ctx.mode === "output") {
			const where = ctx.mode === "ddl" ? "inside DDL" : "in a set operation's ORDER BY"
			if (e.table !== undefined) {
				this.report("scope", `column "${e.table}"."${e.column}" is qualified ${where}`)
			} else if (ctx.tableColumns !== undefined && !ctx.tableColumns.has(e.column)) {
				this.report(
					"scope",
					`column "${e.column}" is not ${ctx.mode === "ddl" ? "a column of the table" : "an output column"}`
				)
			}
			return
		}
		if (e.table === undefined) {
			this.report("scope", `column "${e.column}" is unqualified`)
			return
		}
		this.ident(e.table, "column qualifier")
		const relation = ctx.scope?.resolve(e.table)
		if (relation === undefined) {
			this.report("scope", `"${e.table}" is not a relation in scope`)
		} else if (relation.columns !== undefined && !relation.columns.has(e.column)) {
			this.report("scope", `"${e.table}" has no column "${e.column}"`)
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

	/**
	 * A literal item of a query's GROUP BY, ORDER BY or DISTINCT ON is an output-column ordinal when it is an integer
	 * and an error otherwise: never the constant it spells. A constant grouping key is a column the input carries.
	 */
	positional(items: ReadonlyArray<Expr>, clause: string, at: string): void {
		for (const [i, item] of items.entries()) {
			if (item.kind === "literal") {
				this.report(
					"positional",
					`a literal ${clause} item is a positional reference, not a constant`,
					`${at}[${i}]`
				)
			}
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

	/** A query nested in an expression: it sees the enclosing scope for correlation. */
	subquery(query: Select, ctx: ExprContext): void {
		if (ctx.mode === "pl") {
			this.embedded(() => {
				this.select(query, {
					scope: undefined,
					ctes: undefined,
					plVars: ctx.plVars,
					outermost: false,
					topLevel: false
				})
			})
			return
		}
		if (ctx.mode !== "query") {
			this.report(
				"context",
				`a subquery in ${ctx.mode === "output" ? "a set operation's ORDER BY" : "DDL"}`
			)
		}
		this.select(query, {
			scope: ctx.scope,
			ctes: ctx.ctes,
			plVars: ctx.plVars,
			outermost: false,
			topLevel: false
		})
	}

	/** `topLevel`: the WITH of the statement itself, the only one that may hold a data-modifying CTE. */
	with(
		w: ReadonlyArray<Cte>,
		recursive: boolean,
		outer: CteScope | undefined,
		scope: Scope | undefined,
		plVars: ReadonlySet<string> | undefined,
		topLevel: boolean
	): CteScope {
		const ctes = new CteScope(outer)
		const relationOf = (cte: Cte): Relation => ({ columns: cteColumns(cte) })
		this.at("with", () => {
			if (recursive) {
				for (const [i, cte] of w.entries()) {
					this.at(i, () => {
						this.defineRelation(cte.name, "name")
					})
					ctes.ctes.set(cte.name, relationOf(cte))
				}
			}
			for (const [i, cte] of w.entries()) {
				this.at(i, () => {
					if (!recursive) {
						this.defineRelation(cte.name, "name")
					}
					this.cte(cte, ctes, scope, plVars, topLevel)
					if (!recursive) {
						ctes.ctes.set(cte.name, relationOf(cte))
					}
				})
			}
		})
		return ctes
	}

	/**
	 * A query CTE lists its columns, matching its width, or none over a unit read (`isUnitRead`): a relation of no
	 * column, whose columns nothing reads by name.
	 *
	 * PostgreSQL refuses a data-modifying CTE in any WITH but the statement's own: in a derived table, a subquery,
	 * a set operation's arm, a CTE body, an INSERT's source query or the WITH of another data-modifying CTE
	 * (0A000).
	 */
	cte(
		cte: Cte,
		ctes: CteScope,
		scope: Scope | undefined,
		plVars: ReadonlySet<string> | undefined,
		topLevel: boolean
	): void {
		const body = cte.query
		const listed = cte.columns
		if (listed.length > 0) {
			this.at("columns", () => this.columnList(listed, "CTE", true))
		}
		if (body.kind === "select") {
			if (listed.length === 0 && !isUnitRead(body)) {
				this.report("columnList", `CTE "${cte.name}" has no column list`)
			} else if (listed.length > 0 && listed.length !== selectWidth(body)) {
				this.report(
					"columnList",
					`CTE "${cte.name}" lists ${listed.length} columns for ${selectWidth(body)}`
				)
			}
			this.at("query", () => {
				this.select(body, { scope, ctes, plVars, outermost: false, topLevel: false })
			})
			return
		}
		if (!topLevel) {
			this.report(
				"context",
				`data-modifying CTE "${cte.name}" in a WITH that is not the statement's own`
			)
		}
		/** A data-modifying CTE is named by its RETURNING aliases unless it lists columns. */
		const returning = body.returning
		if (returning.length === 0) {
			this.report("columnList", `data-modifying CTE "${cte.name}" has no RETURNING`)
		}
		if (listed.length === 0 && Arr.some(returning, (target) => target.alias === undefined)) {
			this.report("columnList", `data-modifying CTE "${cte.name}" has an unnamed RETURNING column`)
		}
		if (listed.length > 0 && listed.length !== returning.length) {
			this.report(
				"columnList",
				`CTE "${cte.name}" lists ${listed.length} columns for ${returning.length}`
			)
		}
		this.at("query", () => {
			this.dml(body, ctes, false)
		})
	}

	/**
	 * A parenthesized query is no query boundary in PostgreSQL: its WITH and tail clauses merge with the enclosing
	 * query's, so `(... LIMIT 5) ORDER BY x` sorts before limiting and two LIMITs are a syntax error. Only one
	 * level of a chain of parenthesized bodies may carry clauses, and a level without any is no boundary either, so
	 * the check looks through it to the next level that has some. A lowering that needs both nests a derived table
	 * or a CTE instead.
	 */
	select(select: Select, ctx: SelectContext): void {
		if (hasClauses(select) && clausesBelow(select.body) !== undefined) {
			this.report(
				"context",
				"a query body and its enclosing query both carry clauses, which PostgreSQL merges into one",
				"body"
			)
		}
		const ctes =
			select.with === undefined
				? ctx.ctes
				: this.with(
						select.with.ctes,
						select.with.recursive,
						ctx.ctes,
						ctx.scope,
						ctx.plVars,
						ctx.topLevel
					)
		const coreScope = this.at("body", () =>
			this.body(select.body, {
				scope: ctx.scope,
				ctes,
				plVars: ctx.plVars,
				outermost: ctx.outermost
			})
		)
		/** ORDER BY over a set operation names its output columns, unqualified; over a core it sees the core's FROM. */
		const tail: ExprContext =
			coreScope === undefined
				? {
						...context("output", undefined, ctes, ctx.plVars),
						tableColumns: outputNames(bodyPositionNames(select.body))
					}
				: context("query", coreScope, ctes, ctx.plVars)
		this.positional(
			Arr.map(select.orderBy, (item) => item.expr),
			"ORDER BY",
			"orderBy"
		)
		this.orderBy(select.orderBy, tail, "orderBy")
		const bound = context("query", ctx.scope, ctes, ctx.plVars)
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

	/** Returns the FROM scope of a core body, for ORDER BY. */
	body(body: SelectBody, ctx: BodyContext): Scope | undefined {
		switch (body.kind) {
			case "core":
				return this.core(body, ctx)
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
						this.at(i, () => this.body(arm, ctx))
					}
				})
				return undefined
			}
			case "select":
				this.select(body, { ...ctx, topLevel: false })
				return undefined
		}
	}

	/**
	 * An ungrouped aggregate query yields one row over empty input, and every aggregate but count is NULL there.
	 * An aggregate-only query groups by a constant column its input carries, so empty input yields no row.
	 */
	core(core: SelectCore, ctx: BodyContext): Scope {
		const scope = new Scope(ctx.scope)
		const exprCtx = context("query", scope, ctx.ctes, ctx.plVars)
		this.at("from", () => {
			for (const [i, item] of core.from.entries()) {
				this.at(i, () => this.fromItem(item, scope, ctx.scope, ctx.ctes, ctx.plVars))
			}
		})
		if (typeof core.distinct === "object") {
			const on = core.distinct.on
			this.positional(on, "DISTINCT ON", "distinct")
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
		this.positional(core.groupBy, "GROUP BY", "groupBy")
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
		return scope
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
	 * Registers a FROM item's relations in `scope`, in order, and returns them. `scope` holds the FROM entries audited
	 * so far over `outer`: a LATERAL item sees them all, inside a join tree too, while a non-lateral derived table,
	 * function or VALUES list sees only `outer`. A join's ON sees only its own two arms over `outer`: PostgreSQL
	 * refuses a reference from ON to an earlier comma-separated entry or to an enclosing join's other arm.
	 */
	fromItem(
		item: FromItem,
		scope: Scope,
		outer: Scope | undefined,
		ctes: CteScope | undefined,
		plVars: ReadonlySet<string> | undefined
	): ReadonlyArray<readonly [string, Relation]> {
		const register = (
			name: string,
			relation: Relation
		): ReadonlyArray<readonly [string, Relation]> => {
			scope.relations.set(name, relation)
			return [[name, relation]]
		}
		switch (item.kind) {
			case "table":
				this.tableName(item.table, "table")
				this.defineRelation(item.alias, "alias")
				return register(item.alias, { columns: undefined })
			case "cte": {
				this.ident(item.name, "CTE reference", "name")
				const cte = ctes?.resolve(item.name)
				if (cte === undefined) {
					this.report("scope", `"${item.name}" is not a CTE in scope`, "name")
				}
				if (item.alias !== undefined) {
					this.defineRelation(item.alias, "alias")
				}
				return register(item.alias ?? item.name, { columns: cte?.columns })
			}
			case "enclosing":
				this.ident(item.name, "enclosing CTE", "name")
				this.defineRelation(item.alias, "alias")
				return register(item.alias, { columns: undefined })
			case "derived": {
				const columns = this.at("columns", () =>
					this.columnList(item.columns, "derived table", true)
				)
				if (item.columns.length !== selectWidth(item.query)) {
					this.report(
						"columnList",
						`derived table "${item.alias}" lists ${item.columns.length} columns for ${selectWidth(item.query)}`
					)
				}
				this.at("query", () => {
					this.select(item.query, {
						scope: item.lateral ? scope : outer,
						ctes,
						plVars,
						outermost: false,
						topLevel: false
					})
				})
				this.defineRelation(item.alias, "alias")
				return register(item.alias, { columns })
			}
			case "function": {
				const columns = this.at("columns", () => this.columnList(item.columns, "function", true))
				const ctx = context("query", item.lateral ? scope : outer, ctes, plVars)
				this.at("call", () => {
					this.call(item.call, ctx)
				})
				this.defineRelation(item.alias, "alias")
				return register(item.alias, { columns })
			}
			case "recordset": {
				const columns = this.at("columns", () => {
					for (const [i, column] of item.columns.entries()) {
						this.at(i, () => {
							this.type(column.type)
							this.collatable(column.type, column.collation, "column definition")
						})
					}
					return this.columnList(
						Arr.map(item.columns, (column) => column.name),
						"recordset",
						true
					)
				})
				this.at("source", () => {
					this.placeholder(item.source.number, types.jsonb)
				})
				this.defineRelation(item.alias, "alias")
				return register(item.alias, { columns })
			}
			case "context": {
				this.claimKey(item.context, "context")
				const columns = this.at("columns", () => {
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
				return register(item.alias, { columns })
			}
			case "values": {
				const columns = this.at("columns", () => this.columnList(item.columns, "VALUES", true))
				this.valuesRows(item.rows, item.columns.length, context("query", outer, ctes, plVars))
				this.defineRelation(item.alias, "alias")
				return register(item.alias, { columns })
			}
			case "joins": {
				const joined: Array<readonly [string, Relation]> = []
				const add = (relations: ReadonlyArray<readonly [string, Relation]>): void => {
					for (const relation of relations) {
						joined.push(relation)
					}
				}
				add(this.at("first", () => this.fromItem(item.first, scope, outer, ctes, plVars)))
				this.at("steps", () => {
					for (const [i, step] of item.steps.entries()) {
						this.at(i, () => {
							add(this.at("source", () => this.fromItem(step.source, scope, outer, ctes, plVars)))
							if (step.kind === "on") {
								const on = scopeOver(outer, joined)
								this.at("on", () => {
									this.expr(step.on, context("query", on, ctes, plVars))
								})
							}
						})
					}
				})
				return joined
			}
		}
	}

	/**
	 * The FROM, USING or USING-source items of a write. They never see the write's target: PostgreSQL refuses a
	 * reference to it from a join's ON or a LATERAL item. The target and the items together form the scope of the
	 * write's own clauses.
	 */
	writeScope(
		alias: string,
		items: ReadonlyArray<FromItem>,
		at: string,
		ctes: CteScope | undefined
	): Scope {
		this.defineRelation(alias, "alias")
		const from = new Scope(undefined)
		this.at(at, () => {
			for (const [i, item] of items.entries()) {
				this.at(i, () => this.fromItem(item, from, undefined, ctes, undefined))
			}
		})
		const scope = new Scope(undefined)
		scope.relations.set(alias, { columns: undefined })
		for (const [name, relation] of from.relations) {
			scope.relations.set(name, relation)
		}
		return scope
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

	/** `topLevel`: the statement's own output, whose RETURNING may carry public names. */
	dml(statement: CteBody, ctes: CteScope | undefined, topLevel: boolean): void {
		switch (statement.kind) {
			case "select":
				this.select(statement, {
					scope: undefined,
					ctes,
					plVars: undefined,
					outermost: topLevel,
					topLevel
				})
				return
			case "insert":
				this.insert(statement, ctes, topLevel)
				return
			case "update":
				this.update(statement, ctes, topLevel)
				return
			case "delete":
				this.delete(statement, ctes, topLevel)
				return
			case "merge":
				this.merge(statement, ctes, topLevel)
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

	insert(insert: Insert, outer: CteScope | undefined, topLevel: boolean): void {
		const ctes =
			insert.with === undefined
				? outer
				: this.with(insert.with.ctes, insert.with.recursive, outer, undefined, undefined, topLevel)
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
					this.select(source.query, {
						scope: undefined,
						ctes,
						plVars: undefined,
						outermost: false,
						topLevel: false
					})
				})
			} else {
				this.valuesRows(
					source.rows,
					insert.columns.length,
					context("query", undefined, ctes, undefined)
				)
			}
		})
		const scope = new Scope(undefined)
		if (insert.alias !== undefined) {
			this.defineRelation(insert.alias, "alias")
			scope.relations.set(insert.alias, { columns: undefined })
		}
		if (insert.onConflict !== undefined) {
			const conflict = insert.onConflict
			this.at("onConflict", () => {
				if (conflict.kind === "constraint") {
					this.ident(conflict.constraint, "arbiter constraint", "constraint")
					return
				}
				this.at("columns", () => {
					this.baseColumns(conflict.columns, "arbiter column")
				})
				const ctx: ExprContext = { ...context("query", scope, ctes, undefined), excluded: true }
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
		this.returning(insert.returning, context("query", scope, ctes, undefined), topLevel)
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

	update(update: Update, outer: CteScope | undefined, topLevel: boolean): void {
		const ctes =
			update.with === undefined
				? outer
				: this.with(update.with.ctes, update.with.recursive, outer, undefined, undefined, topLevel)
		this.objectName(update.table, "table", "table")
		const scope = this.writeScope(update.alias, update.from, "from", ctes)
		const ctx = context("query", scope, ctes, undefined)
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
	delete(del: Delete, outer: CteScope | undefined, topLevel: boolean): void {
		const ctes =
			del.with === undefined
				? outer
				: this.with(del.with.ctes, del.with.recursive, outer, undefined, undefined, topLevel)
		this.tableName(del.table, "table")
		const scope = this.writeScope(del.alias, del.using, "using", ctes)
		const ctx = context("query", scope, ctes, undefined)
		if (del.where !== undefined) {
			const where = del.where
			this.at("where", () => {
				this.expr(where, ctx)
			})
		}
		this.returning(del.returning, { ...ctx, returningSides: oldSide }, topLevel)
	}

	/** The source never sees the target (see writeScope). */
	merge(merge: Merge, outer: CteScope | undefined, topLevel: boolean): void {
		const ctes =
			merge.with === undefined
				? outer
				: this.with(merge.with.ctes, merge.with.recursive, outer, undefined, undefined, topLevel)
		this.objectName(merge.table, "table", "table")
		this.defineRelation(merge.alias, "alias")
		const source = new Scope(undefined)
		this.at("using", () => this.fromItem(merge.using, source, undefined, ctes, undefined))
		const target = new Scope(undefined)
		target.relations.set(merge.alias, { columns: undefined })
		const scope = new Scope(undefined)
		scope.relations.set(merge.alias, { columns: undefined })
		for (const [name, relation] of source.relations) {
			scope.relations.set(name, relation)
		}
		const ctx = context("query", scope, ctes, undefined)
		/**
		 * A WHEN NOT MATCHED row has no target row and a WHEN NOT MATCHED BY SOURCE row no source row, so PostgreSQL
		 * lets their condition and action name only the side that exists.
		 */
		const whenCtx = (match: MergeWhen["match"]): ExprContext =>
			match === "MATCHED"
				? ctx
				: context("query", match === "NOT MATCHED" ? source : target, ctes, undefined)
		this.at("on", () => {
			this.expr(merge.on, ctx)
		})
		this.at("whens", () => {
			for (const [i, when] of merge.whens.entries()) {
				this.at(i, () => {
					const inner = whenCtx(when.match)
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
		/**
		 * A row a WHEN NOT MATCHED BY SOURCE action updated or deleted has no source row, whose every column
		 * PostgreSQL returns as NULL there; RETURNING then names only the target.
		 */
		const sourceless = Arr.some(merge.whens, (when) => when.match === "NOT MATCHED BY SOURCE")
		this.returning(
			merge.returning,
			{
				...context("query", sourceless ? target : scope, ctes, undefined),
				returningSides: sides,
				mergeAction: true
			},
			topLevel
		)
	}

	ddlExpr(e: Expr, tableColumns: ReadonlySet<string> | undefined, at: string): void {
		this.at(at, () => {
			this.expr(e, { ...context("ddl", undefined, undefined, undefined), tableColumns })
		})
	}

	columnDef(column: ColumnDef, tableColumns: ReadonlySet<string> | undefined): void {
		this.ident(column.name, "column", "name")
		this.at("type", () => {
			this.type(column.type)
		})
		this.collatable(column.type, column.collation, "column")
		if (column.generated?.kind === "identity") {
			this.objectName(column.generated.sequence, "sequence", "generated")
		}
		if (column.generated?.kind === "stored") {
			this.ddlExpr(column.generated.expr, tableColumns, "generated")
		}
	}

	/** A span key's span, and a PERIOD reference's span, is the last column. */
	keyColumns(
		columns: ReadonlyArray<SpanColumn>,
		tableColumns: ReadonlySet<string> | undefined,
		at: string
	): void {
		this.at(at, () => {
			const seen = new Set<string>()
			for (const [i, c] of columns.entries()) {
				this.ident(c.column, "key column", i)
				if (seen.has(c.column)) {
					this.report("columnList", `key column "${c.column}" is listed twice`, i)
				}
				seen.add(c.column)
				if (tableColumns !== undefined && !tableColumns.has(c.column)) {
					this.report("scope", `key column "${c.column}" is not a column of the table`, i)
				}
				if (c.span && i !== columns.length - 1) {
					this.report("columnList", `the span "${c.column}" is not the key's last column`, i)
				}
			}
		})
	}

	constraint(constraint: TableConstraint, tableColumns: ReadonlySet<string> | undefined): void {
		this.ident(constraint.name, "constraint", "name")
		switch (constraint.kind) {
			case "primaryKey":
			case "unique":
				this.keyColumns(Arr.map(constraint.columns, keySpan), tableColumns, "columns")
				return
			case "foreignKey": {
				this.keyColumns(Arr.map(constraint.columns, periodSpan), tableColumns, "columns")
				this.objectName(constraint.references, "referenced table", "references")
				this.keyColumns(
					Arr.map(constraint.referencedColumns, periodSpan),
					undefined,
					"referencedColumns"
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
				this.ddlExpr(constraint.predicate, tableColumns, "predicate")
				return
			case "exclude":
				this.keyColumns(
					Arr.map(constraint.elements, (e) => ({ column: e.column, span: false })),
					tableColumns,
					"elements"
				)
				return
		}
	}

	/** A table's or a carrier's columns, each declared once; returns their names. */
	tableColumns(columns: ReadonlyArray<ColumnDef>): ReadonlySet<string> {
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
					this.columnDef(column, names)
				})
			}
		})
		return names
	}

	createCarrier(carrier: CreateCarrier): void {
		this.tableColumns(carrier.columns)
	}

	createTable(table: CreateTable): void {
		this.objectName(table.table, "table", "table")
		const columns = this.tableColumns(table.columns)
		this.uniqueNames(
			Arr.map(tableConstraints(table), (c) => c.name),
			"constraint"
		)
		this.at("primaryKey", () => {
			this.constraint(table.primaryKey, columns)
		})
		this.at("secondary", () => {
			for (const [i, c] of table.secondary.entries()) {
				this.at(i, () => {
					this.constraint(c, columns)
				})
			}
		})
	}

	/** ANALYZE names carriers, each at most once. */
	analyze(statement: Analyze): void {
		this.uniqueNames(statement.carriers, "analyzed carrier")
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
			this.plStatements(fn.body.body, vars)
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
		const saved = { allowed: this.#paramsAllowed, params: new Map(this.#params) }
		this.#paramsAllowed = true
		this.#params.clear()
		this.embedded(() => {
			this.at("body", () => {
				this.expr(fn.body, context("pl", undefined, undefined, new Set()))
			})
		})
		for (const [index, used] of this.#params) {
			const arg = fn.params[index - 1]
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

	plStatements(statements: ReadonlyArray<PlStatement>, vars: ReadonlySet<string>): void {
		for (const [i, s] of statements.entries()) {
			this.at(i, () => {
				this.plStatement(s, vars)
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
	plStatement(statement: PlStatement, vars: ReadonlySet<string>): void {
		const ctx = context("pl", undefined, undefined, vars)
		const embeddedSelect = (query: Select): void => {
			this.embedded(() => {
				this.select(query, {
					scope: undefined,
					ctes: undefined,
					plVars: vars,
					outermost: false,
					topLevel: false
				})
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
								this.plStatements(branch.body, vars)
							})
						})
					})
				}
				this.at("else", () => {
					this.plStatements(statement.else, vars)
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
						this.select(statement.query, {
							scope: undefined,
							ctes: undefined,
							plVars: vars,
							outermost: false,
							topLevel: true
						})
					})
				})
				this.at("body", () => {
					this.plStatements(statement.body, vars)
				})
				return
			case "perform":
				this.at("query", () => {
					embeddedSelect({ kind: "select", with: undefined, ...statement.query })
				})
				return
			case "whenAbsent":
				this.at("probe", () => {
					embeddedSelect({ kind: "select", with: undefined, ...statement.probe })
				})
				this.at("body", () => {
					this.plStatements(statement.body, vars)
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
								this.plStatements(branch.body, vars)
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
				this.select(statement, {
					scope: undefined,
					ctes: undefined,
					plVars: undefined,
					outermost: true,
					topLevel: true
				})
				return
			case "insert":
			case "update":
			case "delete":
			case "merge":
				this.dml(statement, undefined, true)
				return
			case "begin":
			case "commit":
			case "rollback":
				return
			case "refresh":
				this.objectName(statement.view, "materialized view", "view")
				return
			case "analyze":
				this.analyze(statement)
				return
			case "createCarrier":
				this.withoutParams(() => {
					this.createCarrier(statement)
				})
				return
			case "createSchema":
			case "createTable":
			case "alterTable":
			case "rename":
			case "renameColumn":
			case "renameConstraint":
			case "createDomain":
			case "alterDomain":
			case "createEnum":
			case "alterEnumAddValue":
			case "alterEnumRenameValue":
			case "createIndex":
			case "dropIndex":
			case "createMaterializedView":
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
			case "createConstraintTrigger":
			case "createGuardTrigger":
			case "alterDatabaseDefault":
			case "createRole":
			case "alterRole":
			case "grant":
			case "revoke":
			case "alterDefaultPrivileges":
			case "createExtension":
			case "createStatistics":
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
			case "MATERIALIZED VIEW":
			case "TYPE":
			case "DOMAIN":
			case "SEQUENCE":
			case "INDEX":
			case "STATISTICS":
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

	/**
	 * The conversion reads the table's columns, the old value among them.
	 *
	 * Its parameter and value are the AST type's one pair.
	 */
	ddl(statement: Ddl): void {
		switch (statement.kind) {
			case "createSchema":
				this.ident(statement.name, "schema", "name")
				if (statement.authorization !== undefined) {
					this.ident(statement.authorization, "role", "authorization")
				}
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
								case "addColumn":
								case "addColumnPlaceholder":
									this.at("column", () => {
										this.columnDef(action.column, undefined)
									})
									return
								case "addConstraint":
									this.at("constraint", () => {
										this.constraint(action.constraint, undefined)
									})
									return
								case "addIdentity":
									this.ident(action.column, "column", "column")
									this.objectName(action.sequence, "sequence", "sequence")
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
												this.ddlExpr(action.using.expr, undefined, "expr")
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
								case "dropIdentity":
									this.ident(action.column, "column", "column")
									return
								case "validateConstraint":
								case "dropConstraint":
									this.ident(action.name, "constraint", "name")
									return
								case "enableRowSecurity":
								case "disableRowSecurity":
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
				this.ident(statement.to, "new name", "to")
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
			case "createEnum": {
				this.objectName(statement.name, "enum", "name")
				if (statement.labels.length === 0) {
					this.report("arity", "an enum without labels")
				}
				const seen = new Set<string>()
				for (const [i, label] of statement.labels.entries()) {
					this.enumLabel(label, i)
					if (seen.has(label)) {
						this.report("columnList", `enum label "${label}" is declared twice`, i)
					}
					seen.add(label)
				}
				return
			}
			case "alterEnumAddValue":
				this.objectName(statement.name, "enum", "name")
				this.enumLabel(statement.label, "label")
				if (statement.position !== undefined) {
					this.enumLabel(statement.position.label, "position")
				}
				return
			case "alterEnumRenameValue":
				this.objectName(statement.name, "enum", "name")
				this.enumLabel(statement.from, "from")
				this.enumLabel(statement.to, "to")
				return
			case "createIndex":
				this.ident(statement.name, "index", "name")
				this.objectName(statement.table, "table", "table")
				this.at("keys", () => {
					for (const [i, key] of statement.keys.entries()) {
						this.at(i, () => {
							if (key.key.kind === "column") {
								this.ident(key.key.column, "index column", "key")
							} else {
								this.ddlExpr(key.key.expr, undefined, "key")
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
					this.ddlExpr(statement.where, undefined, "where")
				}
				return
			case "dropIndex":
				this.objectName(statement.name, "index", "name")
				return
			case "createMaterializedView": {
				this.objectName(statement.name, "materialized view", "name")
				this.at("columns", () => {
					this.baseColumns(statement.columns, "view column")
				})
				if (statement.columns.length !== selectWidth(statement.query)) {
					this.report(
						"columnList",
						`a view of ${statement.columns.length} columns over ${selectWidth(statement.query)}`
					)
				}
				this.at("query", () => {
					this.select(statement.query, {
						scope: undefined,
						ctes: undefined,
						plVars: undefined,
						outermost: true,
						topLevel: false
					})
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
						this.select(statement.query, {
							scope: undefined,
							ctes: undefined,
							plVars: undefined,
							outermost: true,
							topLevel: true
						})
					})
				})
				return
			case "createPolicy": {
				this.ident(statement.name, "policy", "name")
				this.objectName(statement.table, "table", "table")
				this.ident(statement.role, "role", "role")
				/**
				 * A policy's predicate is a query's condition over its table's row, which it reads by the table's name and
				 * which may hold subqueries: the one relation in its scope is the table, under that name.
				 */
				const scope = new Scope(undefined)
				scope.relations.set(statement.table.name, { columns: undefined })
				this.at("filter", () => {
					this.expr(statement.filter, context("query", scope, undefined, undefined))
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
			case "createConstraintTrigger": {
				this.ident(statement.name, "trigger", "name")
				this.objectName(statement.table, "table", "table")
				this.objectName(statement.function, "function", "function")
				const event = statement.event
				if (event.kind === "UPDATE") {
					this.at("event", () => {
						this.baseColumns(event.of, "UPDATE OF column")
					})
				}
				const when = statement.when
				if (when !== undefined) {
					this.at("when", () => {
						this.expr(when, context("ddl", undefined, undefined, new Set()))
						for (const image of imagesRead(when)) {
							if (!eventImages[event.kind].has(image)) {
								this.report("context", `a ${event.kind} trigger's WHEN reading ${image}`)
							}
						}
					})
				}
				return
			}
			case "createGuardTrigger":
				this.ident(statement.name, "trigger", "name")
				this.objectName(statement.table, "table", "table")
				this.objectName(statement.function, "function", "function")
				return
			case "alterDatabaseDefault":
				return
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
				} else {
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
				if (statement.forRole !== undefined) {
					this.ident(statement.forRole, "role", "forRole")
				}
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
			case "createStatistics":
				this.objectName(statement.name, "statistics", "name")
				this.objectName(statement.table, "table", "table")
				this.at("columns", () => {
					this.baseColumns(statement.columns, "statistics column")
				})
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
			this.expr(predicate, context("domain", undefined, undefined, undefined))
		})
	}

	enumLabel(label: string, at: string | number): void {
		if (Str.includes("\u0000")(label) || !isWellFormed(label)) {
			this.report("literal", "an enum label that is not well-formed text", at)
		} else if (utf8Length(label) > maxIdentifierBytes) {
			this.report("literal", `enum label "${label}" exceeds ${maxIdentifierBytes} bytes`, at)
		}
	}
}

const bothSides: ReadonlySet<"old" | "new"> = new Set(["old", "new"])
const oldSide: ReadonlySet<"old" | "new"> = new Set(["old"])

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
 * it names one. Nested queries are not entered: each is a core of its own.
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
		case "collate":
		case "negate":
		case "not":
		case "isTrue":
		case "inQuery":
			forEachAggregateCall(e.expr, f)
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
		case "between":
			all([e.expr, e.low, e.high])
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
const clausesBelow = (body: SelectBody): Select | undefined => {
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
const hasClauses = (select: Select): boolean =>
	select.with !== undefined ||
	select.orderBy.length > 0 ||
	select.limit !== undefined ||
	select.offset !== undefined

/**
 * A set operation's output names, for its ORDER BY: known only when PostgreSQL's name for every position is, and
 * undefined otherwise.
 */
const outputNames = (names: ReadonlyArray<string | undefined>): ReadonlySet<string> | undefined => {
	const known: Array<string> = []
	for (const name of names) {
		if (name === undefined) {
			return undefined
		}
		known.push(name)
	}
	return new Set(known)
}

const cteColumns = (cte: Cte): ReadonlySet<string> | undefined => {
	if (cte.columns.length > 0 || cte.query.kind === "select") {
		return new Set(cte.columns)
	}
	const names: Array<string> = []
	for (const target of cte.query.returning) {
		if (target.alias === undefined) {
			return undefined
		}
		names.push(target.alias)
	}
	return new Set(names)
}

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
 *   every relation alias defined once per statement, explicit column lists on CTEs and derived tables, every column
 *   reference qualified by a visible relation, generated names everywhere but the outermost output; contiguous,
 *   consistently typed parameters and none in DDL; identifier and literal validity; the fixed collation on every
 *   column and domain of type text; RETURNING old./new. only where every returned row has that version; and no query
 *   body that PostgreSQL would merge with its enclosing query's clauses, through any chain of parentheses; a
 *   data-modifying CTE only in the statement's own WITH; MERGE WHEN clauses and RETURNING naming only the rows their
 *   match has; UNION arms named by position with the union's names; no builtin function outside the catalogue of
 *   ast.ts (COALESCE and NULLIF among them); and none of the NULL-yielding aggregate and window forms: LEAD or LAG
 *   without its default (R27), or a NULL-on-empty aggregate in an ungrouped core. A program audit
 *   holds each ANALYZE of a write program to carriers it created.
 * - The text audit lexes the printed text (lexer.ts) and refuses, wherever they occur outside identifiers, strings,
 *   dollar bodies and comments: NULL (other than a column constraint's NOT NULL in table DDL), IS [NOT] NULL, ISNULL,
 *   NOTNULL, IS UNKNOWN, NULLIF, COALESCE, outer joins, SELECT * and RETURNING *, SKIP LOCKED, an uncast parameter,
 *   an untyped literal outside the positions SQL syntax requires a bare string, a CHECK not of the form
 *   CHECK ((...) IS TRUE), a CASE expression without ELSE, and a COLLATE naming any collation but
 *   pg_catalog.pg_c_utf8. A PL/pgSQL body is audited the same way. The AST cannot express most of what the text audit
 *   refuses, and the printer's output must pass it.
 *
 * An audit failure is a compiler defect, reported as a CompileError: MalformedDescription for a structurally malformed
 * statement, UnsupportedOperation for SQL the emission discipline forbids.
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

/**
 * The program audit of a write program's carriers, over its statements in execution order: every ANALYZE names only
 * carriers an earlier statement of the program created as CREATE TEMPORARY TABLE, so it can analyze nothing but the
 * program's own transaction-scoped carriers. `where` is the statement's position.
 */
export const auditCarrierProgramViolations = (
	statements: ReadonlyArray<SqlStatement>
): ReadonlyArray<SqlViolation> => {
	const created = new Set<string>()
	const violations: Array<SqlViolation> = []
	for (const [i, statement] of statements.entries()) {
		if (statement.kind === "createCarrier") {
			created.add(statement.name)
		}
		if (statement.kind !== "analyze") {
			continue
		}
		for (const name of statement.carriers) {
			if (!created.has(name)) {
				violations.push({
					rule: "context",
					where: `statement ${i}`,
					detail: `ANALYZE of "${name}", which no earlier statement of the program creates`
				})
			}
		}
	}
	return violations
}

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
	return text.length <= 10 && BigInt(text) <= 2147483647n
}

/** Words that introduce a statement whose syntax requires bare strings in fixed places, or column NOT NULL. */
type StatementShape =
	| "createTable"
	| "alterTable"
	| "enum"
	| "alterType"
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
	if (w(0) === "CREATE" && w(1) === "TYPE") {
		return "enum"
	}
	if (w(0) === "ALTER" && w(1) === "TYPE") {
		return "alterType"
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
	const before = tokens[i - 2]
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

const part = (t: Token | undefined, name: string): boolean =>
	(t?.kind === "quotedIdent" && t.text === name) ||
	(t?.kind === "word" && t.upper === Str.toUpperCase(name))

/** Whether the tokens at `i` spell the one collation, quoted or bare: pg_catalog.pg_c_utf8. */
const isCUtf8Name = (tokens: ReadonlyArray<Token>, i: number): boolean =>
	part(tokens[i], "pg_catalog") && isPunct(tokens[i + 1], ".") && part(tokens[i + 2], "pg_c_utf8")

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

/** An open CASE: a PL/pgSQL CASE statement or a CASE expression, whether its ELSE was met, and where it starts. */
interface CaseFrame {
	readonly statement: boolean
	readonly elseSeen: boolean
	readonly start: number
}

/** The CASEs open at a token, innermost last; each statement starts with none. */
type OpenCases = ReadonlyArray<CaseFrame>

class TextAuditor {
	readonly violations: Array<SqlViolation> = []
	readonly base: number
	constructor(base: number) {
		this.base = base
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
		/** The paren range of CREATE TYPE ... AS ENUM ( ... ), whose labels are bare strings by syntax. */
		const enumRange: Option.Option<ParenRange> =
			shape === "enum"
				? Option.flatMap(
						Arr.findFirstIndex(tokens, (t, i) => isWord(t, "ENUM") && isPunct(tokens[i + 1], "(")),
						(at) => Option.map(matchingParen(tokens, at + 1), (close) => ({ open: at + 1, close }))
					)
				: Option.none()
		let cases: OpenCases = []
		for (const [i, t] of tokens.entries()) {
			cases = this.token(tokens, depths, i, t, shape, pl, enumRange, cases)
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
		enumRange: Option.Option<ParenRange>,
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
				if (t.prefix !== undefined) {
					this.report("untypedLiteral", t.start, `a ${t.prefix}'' string literal`)
					break
				}
				if (isPunct(next, "::")) {
					break
				}
				if (Option.exists(enumRange, (range) => i > range.open && i < range.close)) {
					break
				}
				if (shape === "comment" && isWord(prev, "IS")) {
					break
				}
				if (
					shape === "alterType" &&
					(isWord(prev, "VALUE") ||
						isWord(prev, "BEFORE") ||
						isWord(prev, "AFTER") ||
						(isWord(prev, "TO") &&
							tokens[i - 2]?.kind === "string" &&
							isWord(tokens[i - 3], "VALUE")) ||
						(isWord(prev, "EXISTS") && isWord(tokens[i - 2], "NOT") && isWord(tokens[i - 3], "IF")))
				) {
					break
				}
				/**
				 * SET <parameter> = '<value>' and SET <parameter> TO '<value>', the parameter a name or an
				 * extension's qualified `<prefix>.<name>` (hnsw.ef_search).
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

	/** The body of CREATE FUNCTION ... AS $tag$ ... $tag$ or DO $tag$ ... $tag$, audited as PL/pgSQL. */
	plBody(t: Extract<Token, { kind: "dollar" }>): void {
		const body = lex(t.body)
		if (body.error !== undefined) {
			this.report("lex", t.bodyStart + body.error.offset, body.error.message)
			return
		}
		const inner = new TextAuditor(this.base + t.bodyStart)
		inner.statement(body.tokens, true)
		appendAll(this.violations, inner.violations)
	}

	/**
	 * NOT NULL is a column constraint in table DDL; anywhere else, IS NOT NULL and DROP NOT NULL included,
	 * NULL is a NULL.
	 *
	 * CHECK ((<predicate>) IS TRUE) and nothing else. A policy's WITH CHECK (<predicate>) is no constraint: row
	 * security admits a row only when the predicate is true, so NULL refuses it already, and an IS TRUE around
	 * the predicate would only hide it from the planner's index quals.
	 *
	 * The CASE of END CASE closes a statement; it opens nothing.
	 *
	 * A CASE expression without ELSE yields NULL when no branch matches.
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
				if (!isColumnNotNull(tokens, depths, i, shape)) {
					this.report("null", t.start, "NULL")
				}
				return cases
			case "COLLATE":
				if (!isCUtf8Name(tokens, i + 1)) {
					this.report(
						"collation",
						t.start,
						"a COLLATE naming a collation other than pg_catalog.pg_c_utf8"
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
			case "NULLIF":
				this.report("nullif", t.start, "NULLIF")
				return cases
			case "COALESCE":
				this.report("coalesce", t.start, "COALESCE")
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
			case "SKIP":
				if (isWord(next, "LOCKED")) {
					this.report("skipLocked", t.start, "SKIP LOCKED")
				}
				return cases
			case "CHECK": {
				if (isWord(prev, "WITH")) {
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
				return Arr.append(cases, { statement, elseSeen: false, start: t.start })
			}
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
						if (!top.elseSeen) {
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

export const auditTextViolations = (text: string): ReadonlyArray<SqlViolation> =>
	auditLexedViolations(lex(text))

/** The text audit of a text's tokens, as lex read them. */
const auditLexedViolations = (lexed: Lexed): ReadonlyArray<SqlViolation> => {
	if (lexed.error !== undefined) {
		return [{ rule: "lex", where: `offset ${lexed.error.offset}`, detail: lexed.error.message }]
	}
	const auditor = new TextAuditor(0)
	for (const statement of splitStatements(lexed.tokens)) {
		auditor.statement(statement, false)
	}
	return auditor.violations
}
