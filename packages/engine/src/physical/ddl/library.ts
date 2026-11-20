/**
 * grizzle's library (ir/physical.ts LibraryFn): the SQL functions of its own a Compute operation's SQL calls, each a
 * constant of parameters (sql/ast.ts CreateConstant), `LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN <body>`, its body
 * this module's, named by its definition's digest (core/identity.ts libraryFunction), which an installation installs
 * where a persistent expression of its schema calls it (`libraryCalls`), after its schema and before every object that
 * calls it, as every constant is (physical/ddl/context.ts addConstant), and revoked from PUBLIC, so a role is granted
 * EXECUTE on it as on every constant it may call (physical/ddl/roles.ts).
 */
import {
	flatMapNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { everyProperty } from "#compiler/core/canonical.ts"
import { constantDigest } from "#compiler/core/fingerprint.ts"
import { type Identity, identity, type KeyImage } from "#compiler/core/identity.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { exprClosure } from "#compiler/ir/expr.ts"
import type { LibraryFn } from "#compiler/ir/physical.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { persistentExprs } from "#compiler/physical/ddl/constants.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { enforcement } from "#compiler/physical/obligations/graph.ts"
import { libraryOf, nativeOp } from "#compiler/scalar/compute/registry.ts"
import type {
	CreateConstant,
	Expr,
	FrameBound,
	FromItem,
	FromSource,
	FunctionParam,
	SqlStatement,
	TypeRef
} from "#compiler/sql/ast.ts"
import {
	and,
	asc,
	binary,
	call,
	col,
	core,
	countStar,
	derived,
	eq,
	firstNonNull,
	ge,
	gt,
	lit,
	lt,
	not,
	operandSelect,
	or,
	param,
	provedCore,
	select,
	targetAs,
	types,
	windowOf
} from "#compiler/sql/build.ts"

/** A library function's definition: its parameters, read by position in its body, its result type and its body. */
interface LibraryDefinition {
	readonly params: ReadonlyArray<FunctionParam>
	readonly returns: TypeRef
	readonly body: Expr
}

const text = (value: string): Expr => lit.text(value, types.text)
const integer = (value: number): Expr => lit.int(value, types.integer)
const length = (x: Expr): Expr => call("char_length", [x])
/** Whether a part holds any character: a component it stands for is stated, its delimiter at least. */
const stated = (part: Expr): Expr => gt(length(part), integer(0))
const unstated = (part: Expr): Expr => eq(length(part), integer(0))
const concat = (first: Expr, ...rest: ReadonlyArray<Expr>): Expr =>
	rest.reduce((joined, next) => binary("||", joined, next), first)
const when = (condition: Expr, then: Expr, otherwise: Expr): Expr => ({
	kind: "case",
	operand: undefined,
	whens: [{ when: condition, result: then }],
	else: otherwise
})
/** The text before `x`'s first `delimiter`, all of it where it holds none. */
const before = (x: Expr, delimiter: string): Expr =>
	call("split_part", [x, text(delimiter), integer(1)])
/** `x` from its character `at`, counted from 1, to its end: none past its end. */
const from = (x: Expr, at: Expr): Expr => call("substring", [x, at])
/** `x` from its first `delimiter` on, the delimiter included: none where it holds none. */
const fromFirst = (x: Expr, delimiter: string): Expr =>
	from(x, binary("+", length(before(x, delimiter)), integer(1)))

/** Named columns of a derived table or a step: each its name and its value. */
type Columns = NonEmptyReadonlyArray<readonly [string, Expr]>

/**
 * A derived table of `columns` over `sources`, `(SELECT … FROM sources) AS alias(columns)`, LATERAL where it reads the
 * sources before it.
 */
const table = (
	alias: string,
	columns: Columns,
	sources: ReadonlyArray<FromItem>,
	lateral: boolean
): FromSource =>
	derived(
		operandSelect(
			core(
				columns.map(([name, value]) => targetAs(value, name)),
				sources,
				undefined
			)
		),
		alias,
		columns.map(([name]) => name),
		lateral
	)

/** One row of `columns` over the sources before it, `LATERAL (SELECT …) AS alias(columns)`, or over none. */
const step = (alias: string, columns: Columns, lateral: boolean): FromSource =>
	table(alias, columns, [], lateral)

/** A window's rows: from `start` to `end`, the segments in order. */
interface Frame {
	readonly start: FrameBound
	readonly end: FrameBound
}

/** Every row from the first through this one. */
const throughHere: Frame = { start: { kind: "unboundedPreceding" }, end: { kind: "currentRow" } }

/** Every row after this one. */
const afterHere: Frame = {
	start: { kind: "offset", offset: 1n, direction: "FOLLOWING" },
	end: { kind: "unboundedFollowing" }
}

/** The window function `name` of `arg` over the rows `frame` names, the segments in order of `alias`'s `k`. */
const windowed = (name: "sum" | "min", arg: Expr, frame: Frame, alias: string): Expr => ({
	...call(name, [arg]),
	over: { ...windowOf([], [asc(col(alias, "k"))]), frame }
})

/** Whether `segment` is a dot segment, `.` or `..`. */
const dotSegment = (segment: Expr): Expr => ({
	kind: "inList",
	expr: segment,
	list: [text("."), text("..")],
	not: false
})

/**
 * remove_dot_segments (RFC 3986 §5.2.4) of the path `input`, over its segments, `string_to_table(input, '/') WITH
 * ORDINALITY`, each `t` numbered `k` from 1: the loop of rules A to E is a stack of the units it moves to its output
 * buffer, each segment pushing one, popping one, or neither, so the output is every unit no later pop removes, in
 * order.
 *
 * - While every segment before it is `.` or `..` (`lead`: rule A strips those a `/` follows, rule D the last), a
 *   segment pushes itself, slashless, unless it is one of them: rule E's first move of a path that does not begin
 *   with `/`, which an empty first segment, one that does, pushes harmlessly beneath every other.
 * - After it, a `.` pushes `/` where it is the last segment and nothing otherwise (rule B), a `..` pops and pushes `/`
 *   where it is the last (rule C), and any other segment pushes `/` and itself (rule E).
 *
 * A push survives where no later run of segments pops more than it pushes: with `n` the running count of pushes less
 * pops, unclamped, the push of a segment survives where every later segment's count before its push (`n` less its
 * own push) is at least its own `n`, so the empty stack a pop leaves alone needs no case. The segments are read once,
 * by each window and by the aggregate, so the work is the path's length and the sort of its segments, and no regular
 * expression is read.
 */
const removeDotSegments = (input: Expr): Expr => {
	const segments: FromSource = {
		kind: "function",
		call: call("string_to_table", [input, text("/")]),
		alias: "s",
		columns: ["t", "k"],
		lateral: false,
		ordinality: true
	}
	const counted = table(
		"g",
		[
			["t", col("s", "t")],
			["k", col("s", "k")],
			["dot", dotSegment(col("s", "t"))],
			["count", { ...countStar(), over: windowOf([], []) }],
			[
				"plain",
				windowed("sum", when(dotSegment(col("s", "t")), integer(0), integer(1)), throughHere, "s")
			]
		],
		[segments],
		false
	)
	const led = table(
		"l",
		[
			["t", col("g", "t")],
			["k", col("g", "k")],
			["dot", col("g", "dot")],
			["last", eq(col("g", "k"), col("g", "count"))],
			["lead", eq(col("g", "plain"), when(col("g", "dot"), integer(0), integer(1)))]
		],
		[counted],
		false
	)
	const moves = table(
		"p",
		[
			["k", col("l", "k")],
			[
				"unit",
				{
					kind: "case",
					operand: undefined,
					whens: [
						{ when: col("l", "lead"), result: col("l", "t") },
						{ when: col("l", "dot"), result: text("/") }
					],
					else: concat(text("/"), col("l", "t"))
				}
			],
			[
				"push",
				{
					kind: "case",
					operand: undefined,
					whens: [
						{ when: not(col("l", "dot")), result: integer(1) },
						{ when: col("l", "lead"), result: integer(0) },
						{ when: col("l", "last"), result: integer(1) }
					],
					else: integer(0)
				}
			],
			[
				"pop",
				when(and([not(col("l", "lead")), eq(col("l", "t"), text(".."))]), integer(1), integer(0))
			]
		],
		[led],
		false
	)
	const running = table(
		"n",
		[
			["k", col("p", "k")],
			["unit", col("p", "unit")],
			["push", col("p", "push")],
			["n", windowed("sum", binary("-", col("p", "push"), col("p", "pop")), throughHere, "p")]
		],
		[moves],
		false
	)
	const later = table(
		"a",
		[
			["k", col("n", "k")],
			["unit", col("n", "unit")],
			["push", col("n", "push")],
			["n", col("n", "n")],
			["later", windowed("min", binary("-", col("n", "n"), col("n", "push")), afterHere, "n")]
		],
		[running],
		false
	)
	const kept = and([
		eq(col("a", "push"), integer(1)),
		ge(firstNonNull([col("a", "later"), col("a", "n")]), col("a", "n"))
	])
	const joined: Expr = {
		...call("string_agg", [col("a", "unit"), text("")]),
		orderBy: [asc(col("a", "k"))]
	}
	return firstNonNull([
		{
			kind: "subquery",
			query: select(provedCore("oneRow", [targetAs(joined, "path")], [later], kept))
		},
		text("")
	])
}

/** The two texts resolveReference splits, the base's parts named `b_…` in a step and the reference's `r_…`. */
const sides = ["b", "r"] as const
type Side = (typeof sides)[number]
const part = (alias: string, side: Side, name: string): Expr => col(alias, `${side}_${name}`)
/** A step's columns: `f`'s parts of the base, then of the reference. */
const bothSides = (f: (side: Side) => Columns): Columns =>
	flatMapNonEmpty(sides, (side) =>
		mapNonEmpty(f(side), ([name, value]) => [`${side}_${name}`, value] as const)
	)

/**
 * resolveReference(base, reference): the target of `reference` resolved against `base` (RFC 3986 §5.2.2, strict, then
 * §5.3's recomposition), as @bjornpagen/grizzle-text's uri.ts resolveReference computes it on the host.
 *
 * Each text is split as Appendix B splits a reference, each component with the delimiter that states it, `scheme:`,
 * `//authority`, the path, `?query` and `#fragment`, so a component the text does not state is the empty text, one it
 * states empty its delimiter alone, and the target their concatenation: the fragment from the first `#`, the query from
 * the first `?` before it, the scheme before the first `:` where that is no empty text and holds no `/`, the authority
 * after `//` up to the next `/`, and the path the rest. Each step is one row that reads the steps before it, so no part
 * is computed twice. The target's path is the base's where the reference states no scheme, authority or path, and
 * otherwise its dot segments removed (removeDotSegments) from the reference's where it states a scheme or an authority
 * or begins with `/`, or from its merge with the base's (§5.2.3): `/` and it where the base states an authority and an
 * empty path, else the base's up to its last `/` and it.
 */
const resolveReferenceDefinition = (): LibraryDefinition => {
	const texts: { readonly [S in Side]: Expr } = {
		b: param(1, types.text),
		r: param(2, types.text)
	}
	const fragments = step(
		"s1",
		[
			["b_before", before(texts.b, "#")],
			["r_before", before(texts.r, "#")],
			["r_fragment", fromFirst(texts.r, "#")]
		],
		false
	)
	const queries = step(
		"s2",
		bothSides((side) => [
			["hier", before(part("s1", side, "before"), "?")],
			["query", fromFirst(part("s1", side, "before"), "?")]
		]),
		true
	)
	const heads = step(
		"s3",
		bothSides((side) => [["head", before(part("s2", side, "hier"), ":")]]),
		true
	)
	const schemes = step(
		"s4",
		bothSides((side) => {
			const head = part("s3", side, "head")
			const scheme = when(
				and([
					stated(head),
					lt(length(head), length(part("s2", side, "hier"))),
					eq(length(before(head, "/")), length(head))
				]),
				concat(head, text(":")),
				text("")
			)
			return [["scheme", scheme]]
		}),
		true
	)
	const afters = step(
		"s5",
		bothSides((side) => [
			[
				"after",
				from(part("s2", side, "hier"), binary("+", length(part("s4", side, "scheme")), integer(1)))
			]
		]),
		true
	)
	const authorities = step(
		"s6",
		bothSides((side) => {
			const after = part("s5", side, "after")
			const authority = when(
				call("starts_with", [after, text("//")]),
				concat(text("//"), before(from(after, integer(3)), "/")),
				text("")
			)
			return [["authority", authority]]
		}),
		true
	)
	const paths = step(
		"s7",
		bothSides((side) => [
			[
				"path",
				from(
					part("s5", side, "after"),
					binary("+", length(part("s6", side, "authority")), integer(1))
				)
			]
		]),
		true
	)
	const baseAuthority = part("s6", "b", "authority")
	const basePath = part("s7", "b", "path")
	const referenceScheme = part("s4", "r", "scheme")
	const referencePath = part("s7", "r", "path")
	const named = or([stated(referenceScheme), stated(part("s6", "r", "authority"))])
	const merged = when(
		and([stated(baseAuthority), unstated(basePath)]),
		concat(text("/"), referencePath),
		concat(
			call("left", [
				basePath,
				binary("-", length(basePath), length(before(call("reverse", [basePath]), "/")))
			]),
			referencePath
		)
	)
	const targets = step(
		"t",
		[
			["scheme", when(stated(referenceScheme), referenceScheme, part("s4", "b", "scheme"))],
			["authority", when(named, part("s6", "r", "authority"), baseAuthority)],
			["kept", and([not(named), unstated(referencePath)])],
			[
				"input",
				when(or([named, call("starts_with", [referencePath, text("/")])]), referencePath, merged)
			]
		],
		true
	)
	const kept = col("t", "kept")
	const query = when(
		and([kept, unstated(part("s2", "r", "query"))]),
		part("s2", "b", "query"),
		part("s2", "r", "query")
	)
	const target = concat(
		col("t", "scheme"),
		col("t", "authority"),
		when(kept, basePath, removeDotSegments(col("t", "input"))),
		query,
		part("s1", "r", "fragment")
	)
	return {
		params: [
			{ name: "base", type: types.text },
			{ name: "reference", type: types.text }
		],
		returns: types.text,
		body: {
			kind: "subquery",
			query: operandSelect(
				core(
					[targetAs(target, "target")],
					[fragments, queries, heads, schemes, afters, authorities, paths, targets],
					undefined
				)
			)
		}
	}
}

/** Each library function's definition, made once. */
/**
 * textDigest(text): the SHA-256 digest of a text's UTF-8 bytes, `sha256(convert_to($1, 'UTF8'))`, 32 bytes: the image a
 * text of no byte bound is keyed by (Compute.sha256 over text writes it as lowercase hex). An installation's database is
 * UTF8 (grizzle refuses another at its first migration), so convert_to converts nothing and copies the text's bytes
 * as they are stored; convert_to is STABLE in pg_proc only because a conversion's result can depend on the database's
 * encoding, which a database never changes, and sha256 is IMMUTABLE, so the digest is one value of a text wherever it
 * stands, a generated column among them, and the function is declared IMMUTABLE as PostgreSQL's own digests are.
 */
const textDigestDefinition = (): LibraryDefinition => ({
	params: [{ name: "text", type: types.text }],
	returns: types.bytea,
	body: call("sha256", [call("convert_to", [param(1, types.text), text("UTF8")])])
})

const definitions: { readonly [F in LibraryFn]: LibraryDefinition } = {
	resolveReference: resolveReferenceDefinition(),
	textDigest: textDigestDefinition()
}

/** Each library function's identity, by its name and its definition's digest, minted once. */
const identities: { readonly [F in LibraryFn]: Identity<"libraryFunction"> } = {
	resolveReference: identity.libraryFunction(
		"resolveReference",
		constantDigest("library-function", definitions.resolveReference, everyProperty)
	),
	textDigest: identity.libraryFunction(
		"textDigest",
		constantDigest("library-function", definitions.textDigest, everyProperty)
	)
}

/** The identity a library function is named by (core/identity.ts libraryFunction). */
export const libraryIdentity = (fn: LibraryFn): Identity<"libraryFunction"> => identities[fn]

/**
 * The library functions the persistent expressions of `model` call (constants.ts persistentExprs), and each key image's
 * (laws/model/plan.ts keyedAs), in name order: those its installation installs. A contract's predicate, a derived
 * relation's definition and a role's statements call only those, or are refused as UninstalledFunction where they are
 * compiled.
 */
export const libraryCalls = (model: LawModel): ReadonlyArray<LibraryFn> => {
	const called = new Set<LibraryFn>()
	for (const e of exprClosure(persistentExprs(model))) {
		const sql = e.kind === "op" ? nativeOp(e.op)?.sql : undefined
		const fn = sql === undefined ? undefined : libraryOf(sql)
		if (fn !== undefined) {
			called.add(fn)
		}
	}
	for (const { object: o } of model.natives) {
		if (o.kind === "LawColumn" && o.value.kind === "image") {
			called.add(imageFunctions[o.value.image])
		}
	}
	return [...called].toSorted(compareStrings)
}

/** The library function each key image is computed by: a text's digest by textDigest. */
export const imageFunctions: { readonly [I in KeyImage]: LibraryFn } = Object.freeze({
	textDigest: "textDigest"
})

/** A library function's CREATE in the schema `schema`: an installation's, or a session's pg_temp. */
export const libraryCreate = (schema: string, fn: LibraryFn): CreateConstant => ({
	kind: "createConstant",
	name: { schema, name: libraryIdentity(fn).identifier },
	...definitions[fn]
})

/** A library function's revoke from PUBLIC, which holds EXECUTE on every new function. */
const revokeOf = (create: CreateConstant): SqlStatement => ({
	kind: "revoke",
	privileges: ["ALL"],
	on: { kind: "FUNCTION", names: [{ ...create.name, args: create.params.map((p) => p.type) }] },
	from: [{ kind: "PUBLIC" }]
})

/** The library functions the installation installs as its objects, after its schema, each its CREATE and its revoke. */
export const addLibrary = (b: InstallBuilder): void => {
	for (const fn of b.library) {
		const named = libraryIdentity(fn)
		b.name(named)
		const create = libraryCreate(b.schema, fn)
		b.addConstant(
			named,
			{
				ddl: [create, revokeOf(create)],
				reasons: [enforcement(`the library function ${fn}`)]
			},
			[b.schemaNode]
		)
	}
}
