/**
 * grizzle's library (ir/physical.ts LibraryFn): the SQL functions of its own a Compute operation's SQL calls, each a
 * constant of parameters (sql/ast.ts CreateConstant), `LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN <body>`, its body
 * this module's, named by its definition's digest (core/identity.ts libraryFunction), which an installation installs
 * where a persistent expression of its schema calls it (`libraryCalls`), after its schema and before every object that
 * calls it, as every constant is (physical/ddl/context.ts addConstant), and revoked from PUBLIC, so a role is granted
 * EXECUTE on it as on every constant it may call (physical/ddl/roles.ts).
 */
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	flatMapNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { xmlSchemaBlocks } from "@bjornpagen/grizzle-text/regex/xml"
import { xsdCategoryNames } from "@bjornpagen/grizzle-text/regex/xsd"
import { everyProperty } from "#compiler/core/canonical.ts"
import { constantDigest } from "#compiler/core/fingerprint.ts"
import { type Identity, identity, type KeyImage } from "#compiler/core/identity.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { exprClosure } from "#compiler/ir/expr.ts"
import type { LibraryFn } from "#compiler/ir/physical.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { persistentExprs } from "#compiler/physical/ddl/constants.ts"
import { constantRevoke, type InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { enforcement } from "#compiler/physical/obligations/graph.ts"
import { libraryOf, nativeOp } from "#compiler/scalar/compute/registry.ts"
import type {
	CreateConstant,
	Expr,
	FrameBound,
	FromItem,
	FromSource,
	Cte,
	FunctionParam,
	OperandSelect,
	TypeRef
} from "#compiler/sql/ast.ts"
import {
	and,
	arrayOf,
	asc,
	binary,
	call,
	col,
	core,
	countStar,
	cte,
	cteRef,
	cUtf8Collation,
	derived,
	desc,
	eq,
	firstNonNull,
	ge,
	gt,
	isIn,
	le,
	lit,
	lt,
	ne,
	not,
	operandSelect,
	operandUnionAll,
	or,
	param,
	provedCore,
	select,
	simpleSelect,
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

/**
 * The classes of a pattern's characters the recognizer's table reads (xsdPatternDefinition), each a column of it, in
 * the order of `xsdClassKeys` for the first fifteen: the metacharacters and punctuation Appendix F reads by themselves,
 * then the decimal digits, the letters of the single-character escapes no metacharacter spells (n, r, t), those of the
 * multi-character escapes, those of the category escapes (p, P), and every other character.
 */
const xsdClasses = [
	"\\",
	"[",
	"]",
	"(",
	")",
	"{",
	"}",
	"|",
	"?",
	"*",
	"+",
	"-",
	"^",
	",",
	".",
	"digit",
	"entry",
	"multi",
	"property",
	"other"
] as const

type XsdClass = (typeof xsdClasses)[number]

/** Each character a class other than `other` holds, and its class. */
const xsdClassKeys: ReadonlyArray<readonly [string, XsdClass]> = [
	...xsdClasses.slice(0, 15).map((c): readonly [string, XsdClass] => [c, c]),
	..."0123456789".split("").map((c): readonly [string, XsdClass] => [c, "digit"]),
	..."nrt".split("").map((c): readonly [string, XsdClass] => [c, "entry"]),
	..."sSiIcCdDwW".split("").map((c): readonly [string, XsdClass] => [c, "multi"]),
	..."pP".split("").map((c): readonly [string, XsdClass] => [c, "property"])
]

/**
 * The class of each ASCII code point, by the code point: the table the recognizer finds a character's class in, every
 * character past it of class `other`, as every character no key names.
 *
 * @formatConstant the ASCII code points, 0 to 127
 */
const asciiClasses: ReadonlyArray<XsdClass> = Array.from({ length: 0x80 }, (_, point) => {
	const keyed = xsdClassKeys.find(([key]) => key.codePointAt(0) === point)
	return keyed === undefined ? "other" : keyed[1]
})

/**
 * The recognizer's states, each a row of its table, what the reader (regex/xsd.ts) is reading: a branch where no
 * quantifier may stand (its start, after `|`, `(` or a quantifier), after an atom, an escape, a category escape's brace
 * and name, a count's `{`, least digits, comma and greatest digits, and in a class: just opened, no member yet, members,
 * a `-` before any member or after one, a character that may begin a range, it and a `-`, an escape, an escape ending a
 * range, a category escape's brace and name, a subtraction's `]` that its class's `]` must follow; and refused.
 */
const xsdStates = [
	"branch",
	"atom",
	"escape",
	"propertyBrace",
	"propertyName",
	"countOpen",
	"least",
	"comma",
	"most",
	"classOpen",
	"classEmpty",
	"classMembers",
	"dashEmpty",
	"dashMembers",
	"char",
	"charDash",
	"classEscape",
	"rangeEscape",
	"classPropertyBrace",
	"classPropertyName",
	"subtracted",
	"refused"
] as const

type XsdState = (typeof xsdStates)[number]

/**
 * What a move does beside its state, each over the recognizer's registers: open or close a group (the open groups'
 * count), open a class or a subtraction or close one (the open classes' count, closing into `atom` or `subtracted` by
 * it), a range's first code point from a character or an escape and a range's last checked against it, a category
 * escape's name begun, extended and checked against the names Appendix F's tables hold, and a count's least and
 * greatest numerals begun, extended and checked in order.
 */
const xsdOps = [
	"none",
	"openGroup",
	"closeGroup",
	"openClass",
	"openSubtraction",
	"closeClass",
	"firstChar",
	"firstEscape",
	"lastChar",
	"lastEscape",
	"nameOpen",
	"nameAdd",
	"nameClose",
	"leastOpen",
	"leastAdd",
	"mostOpen",
	"mostAdd",
	"ordered"
] as const

type XsdOp = (typeof xsdOps)[number]

/** A move of the recognizer's table: the next state and what it does. */
type Move = readonly [XsdState, XsdOp]

const refused: Move = ["refused", "none"]

/** The classes whose escape names one character: a metacharacter's own, and n, r and t (regex/xsd.ts singleCharacterEscapes). */
const entryEscapes: ReadonlySet<XsdClass> = new Set([
	"\\",
	"|",
	".",
	"?",
	"*",
	"+",
	"(",
	")",
	"{",
	"}",
	"-",
	"[",
	"]",
	"^",
	"entry"
])

/** A branch's move, where no quantifier stands: `|`, a group, an escape, a class, a closing bracket or an atom. */
const branchMove = (c: XsdClass): Move => {
	switch (c) {
		case "\\":
			return ["escape", "none"]
		case "[":
			return ["classOpen", "openClass"]
		case "(":
			return ["branch", "openGroup"]
		case ")":
			return ["atom", "closeGroup"]
		case "|":
			return ["branch", "none"]
		case "]":
		case "{":
		case "}":
		case "?":
		case "*":
		case "+":
			return refused
		case "-":
		case "^":
		case ",":
		case ".":
		case "digit":
		case "entry":
		case "multi":
		case "property":
		case "other":
			return ["atom", "none"]
	}
}

/** A class's move once it holds a member: its `]`, a `-`, an escape, or a character that may begin a range. */
const membersMove = (c: XsdClass): Move => {
	switch (c) {
		case "]":
			return ["atom", "closeClass"]
		case "[":
			return refused
		case "-":
			return ["dashMembers", "none"]
		case "\\":
			return ["classEscape", "none"]
		case "(":
		case ")":
		case "{":
		case "}":
		case "|":
		case "?":
		case "*":
		case "+":
		case "^":
		case ",":
		case ".":
		case "digit":
		case "entry":
		case "multi":
		case "property":
		case "other":
			return ["char", "firstChar"]
	}
}

/** A state's move on a character of class `c`: the table's cell, written as the reader reads (regex/xsd.ts Reader). */
const moveOf = (state: XsdState, c: XsdClass): Move => {
	switch (state) {
		case "branch":
			return branchMove(c)
		case "atom":
			return c === "?" || c === "*" || c === "+"
				? ["branch", "none"]
				: c === "{"
					? ["countOpen", "none"]
					: branchMove(c)
		case "escape":
			return entryEscapes.has(c) || c === "multi"
				? ["atom", "none"]
				: c === "property"
					? ["propertyBrace", "none"]
					: refused
		case "propertyBrace":
			return c === "{" ? ["propertyName", "nameOpen"] : refused
		case "propertyName":
			return c === "}" ? ["atom", "nameClose"] : ["propertyName", "nameAdd"]
		case "countOpen":
			return c === "digit" ? ["least", "leastOpen"] : refused
		case "least":
			return c === "digit"
				? ["least", "leastAdd"]
				: c === ","
					? ["comma", "none"]
					: c === "}"
						? ["branch", "none"]
						: refused
		case "comma":
			return c === "digit" ? ["most", "mostOpen"] : c === "}" ? ["branch", "none"] : refused
		case "most":
			return c === "digit" ? ["most", "mostAdd"] : c === "}" ? ["branch", "ordered"] : refused
		case "classOpen":
			return c === "^" ? ["classEmpty", "none"] : moveOf("classEmpty", c)
		case "classEmpty":
			return c === "]" || c === "["
				? refused
				: c === "-"
					? ["dashEmpty", "none"]
					: c === "\\"
						? ["classEscape", "none"]
						: ["char", "firstChar"]
		case "classMembers":
			return membersMove(c)
		case "dashEmpty":
			return c === "[" ? refused : membersMove(c)
		case "dashMembers":
			return c === "["
				? ["classOpen", "openSubtraction"]
				: c === "]"
					? ["atom", "closeClass"]
					: refused
		case "char":
			return c === "-" ? ["charDash", "none"] : membersMove(c)
		case "charDash":
			return c === "]"
				? ["atom", "closeClass"]
				: c === "["
					? ["classOpen", "openSubtraction"]
					: c === "-"
						? refused
						: c === "\\"
							? ["rangeEscape", "none"]
							: ["classMembers", "lastChar"]
		case "classEscape":
			return entryEscapes.has(c)
				? ["char", "firstEscape"]
				: c === "multi"
					? ["classMembers", "none"]
					: c === "property"
						? ["classPropertyBrace", "none"]
						: refused
		case "rangeEscape":
			return entryEscapes.has(c) ? ["classMembers", "lastEscape"] : refused
		case "classPropertyBrace":
			return c === "{" ? ["classPropertyName", "nameOpen"] : refused
		case "classPropertyName":
			return c === "}" ? ["classMembers", "nameClose"] : ["classPropertyName", "nameAdd"]
		case "subtracted":
			return c === "]" ? ["atom", "closeClass"] : refused
		case "refused":
			return refused
	}
}

/** The number of a state, a class or an op: its place in its roster. */
const placeOf = <T extends string>(roster: ReadonlyArray<T>, member: T): number =>
	roster.indexOf(member)

/** An integer[] constant of `values`, `'{…}'::integer[]`. */
const integers = (values: ReadonlyArray<number>): Expr =>
	lit.text(`{${values.join(",")}}`, defined(arrayOf(types.integer), "an integer array type"))

/** `array[index]`, counted from 1. */
const subscript = (array: Expr, index: Expr): Expr => ({ kind: "subscript", array, index })

/** The code point of a one-unit ASCII character. */
const cp = (ch: string): number => ch.charCodeAt(0)

/**
 * isXsdPattern(text): whether a text is a string of XML Schema 1.0's regExp production (Part 2, Appendix F), as
 * @bjornpagen/grizzle-text's regex/xsd.ts reader reads it on the host: the same grammar, with no state budget and no
 * bound on a count.
 *
 * The grammar is not regular (groups nest, and a class subtraction nests `[a-[b-[c]]]`), but its nesting needs only
 * counts, so its recognizer is a table of moves over its characters (xsdStates, xsdClasses, moveOf), the reader's own
 * loop as data, and a few registers: the open groups, the open classes, a range's first code point, the name of a
 * category escape or a count's greatest digits, and its least digits. The text's code points are read once into an
 * integer array (`t`, MATERIALIZED, so it is computed once and never per row of the recursion, as an inlined CTE would
 * be), whose element any row reads in constant time; a recursive query then reads them in order, one row a character,
 * each row the state and the registers after it: a character's class by an ASCII table (asciiClasses, every other
 * character of class `other`), the move by its place in two integer arrays, the state's row and the class's column,
 * and the registers by what the move does (xsdOps); a refusal ends it. The text is a member where the last row stands
 * in a branch or after an atom with every group closed. A category escape's name is one of the General_Category values
 * or `Is` and a block of XML Schema's table, which grizzle-text's own tables give, and a count's numerals are compared
 * as written, by their length without leading zeros and then by code point, so no count is too large to compare. It
 * reads no regular expression but the split of the text into its characters, and builds nothing per character but its
 * row: 10,001 code points of groups nested 2,000 deep take 114 ms, and 100,000 code points 2.2 s, on cassowary at a
 * load of 700.
 */
const xsdPatternDefinition = (): LibraryDefinition => {
	const pattern = param(1, types.text)
	const width = xsdClasses.length
	const nexts = xsdStates.flatMap((s) => xsdClasses.map((c) => placeOf(xsdStates, moveOf(s, c)[0])))
	const ops = xsdStates.flatMap((s) => xsdClasses.map((c) => placeOf(xsdOps, moveOf(s, c)[1])))
	const state = (s: XsdState): Expr => integer(placeOf(xsdStates, s))
	const op = (o: XsdOp): Expr => integer(placeOf(xsdOps, o))
	const r = (column: string): Expr => col("r", column)
	const c = col("h", "c")
	const character = call("chr", [c])
	const moved = col("m", "op")
	const next = col("m", "next")
	/** A move's effect on one register: its value under each op that sets it, the register as it was under any other. */
	const register = (kept: Expr, set: NonEmptyReadonlyArray<readonly [XsdOp, Expr]>): Expr => ({
		kind: "case",
		operand: moved,
		whens: mapNonEmpty(set, ([o, value]) => ({ when: op(o), result: value })),
		else: kept
	})
	/** The state a move leads to, or refused where its check fails. */
	const unless = (holds: Expr): Expr => when(holds, next, state("refused"))
	const escaped: Expr = {
		kind: "case",
		operand: c,
		whens: [
			{ when: integer(cp("n")), result: integer(0x0a) },
			{ when: integer(cp("r")), result: integer(0x0d) },
			{ when: integer(cp("t")), result: integer(0x09) }
		],
		else: c
	}
	const names = [...xsdCategoryNames, ...[...xmlSchemaBlocks.keys()].map((b) => `Is${b}`)]
	const digits = (numeral: Expr): Expr => call("ltrim", [numeral, text("0")])
	const least = digits(r("lo"))
	const most = digits(r("acc"))
	const inCodePointOrder = (e: Expr): Expr => ({
		kind: "collate",
		expr: e,
		collation: cUtf8Collation
	})
	const split: FromSource = {
		kind: "function",
		call: call("regexp_split_to_table", [pattern, text("")]),
		alias: "p",
		columns: ["c", "k"],
		lateral: false,
		ordinality: true
	}
	const characters: Cte = {
		...cte(
			"t",
			["cs", "n"],
			simpleSelect(
				[
					targetAs(
						{
							...call("array_agg", [call("ascii", [col("p", "c")])]),
							orderBy: [asc(col("p", "k"))]
						},
						"cs"
					),
					targetAs(length(pattern), "n")
				],
				[split],
				undefined
			)
		),
		materialized: "MATERIALIZED"
	}
	const start = core(
		[
			targetAs(integer(1), "i"),
			targetAs(state("branch"), "s"),
			targetAs(integer(0), "parens"),
			targetAs(integer(0), "depth"),
			targetAs(integer(0), "first"),
			targetAs(text(""), "acc"),
			targetAs(text(""), "lo")
		],
		[],
		undefined
	)
	const cell = binary(
		"+",
		binary("+", binary("*", r("s"), integer(width)), col("k", "k")),
		integer(1)
	)
	const following = core(
		[
			targetAs(binary("+", r("i"), integer(1)), "i"),
			...["s", "parens", "depth", "first", "acc", "lo"].map((x) => targetAs(col("x", x), x))
		],
		[
			cteRef("r"),
			cteRef("t"),
			step("h", [["c", subscript(col("t", "cs"), r("i"))]], true),
			step(
				"k",
				[
					[
						"k",
						firstNonNull([
							subscript(
								integers(asciiClasses.map((k) => placeOf(xsdClasses, k))),
								binary("+", c, integer(1))
							),
							integer(placeOf(xsdClasses, "other"))
						])
					]
				],
				true
			),
			step(
				"m",
				[
					["next", subscript(integers(nexts), cell)],
					["op", subscript(integers(ops), cell)]
				],
				true
			),
			step(
				"x",
				[
					[
						"s",
						register(next, [
							["closeGroup", unless(gt(r("parens"), integer(0)))],
							["closeClass", when(eq(r("depth"), integer(1)), state("atom"), state("subtracted"))],
							["lastChar", unless(ge(c, r("first")))],
							["lastEscape", unless(ge(escaped, r("first")))],
							[
								"nameClose",
								unless({
									kind: "equalsAny",
									expr: r("acc"),
									array: lit.text(
										`{${names.map((n) => `"${n}"`).join(",")}}`,
										defined(arrayOf(types.text), "a text array type")
									),
									schema: undefined
								})
							],
							[
								"ordered",
								unless(
									or([
										lt(length(least), length(most)),
										and([
											eq(length(least), length(most)),
											binary("<=", inCodePointOrder(least), inCodePointOrder(most))
										])
									])
								)
							]
						])
					],
					[
						"parens",
						register(r("parens"), [
							["openGroup", binary("+", r("parens"), integer(1))],
							["closeGroup", binary("-", r("parens"), integer(1))]
						])
					],
					[
						"depth",
						register(r("depth"), [
							["openClass", integer(1)],
							["openSubtraction", binary("+", r("depth"), integer(1))],
							["closeClass", binary("-", r("depth"), integer(1))]
						])
					],
					[
						"first",
						register(r("first"), [
							["firstChar", c],
							["firstEscape", escaped]
						])
					],
					[
						"acc",
						register(r("acc"), [
							["nameOpen", text("")],
							["nameAdd", concat(r("acc"), character)],
							["mostOpen", character],
							["mostAdd", concat(r("acc"), character)]
						])
					],
					[
						"lo",
						register(r("lo"), [
							["leastOpen", character],
							["leastAdd", concat(r("lo"), character)]
						])
					]
				],
				true
			)
		],
		and([le(r("i"), col("t", "n")), ne(r("s"), state("refused"))])
	)
	const read = cte(
		"r",
		["i", "s", "parens", "depth", "first", "acc", "lo"],
		operandSelect(operandUnionAll([start, following]))
	)
	const last: OperandSelect = {
		...operandSelect(
			core(
				[
					targetAs(
						and([isIn(r("s"), [state("branch"), state("atom")]), eq(r("parens"), integer(0))]),
						"member"
					)
				],
				[cteRef("r")],
				undefined
			)
		),
		with: { recursive: true, ctes: [characters, read] },
		orderBy: [desc(r("i"))],
		limit: integer(1)
	}
	return {
		params: [{ name: "pattern", type: types.text }],
		returns: types.boolean,
		body: { kind: "subquery", query: last }
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
	isXsdPattern: xsdPatternDefinition(),
	resolveReference: resolveReferenceDefinition(),
	textDigest: textDigestDefinition()
}

/** Each library function's identity, by its name and its definition's digest, minted once. */
const identities: { readonly [F in LibraryFn]: Identity<"libraryFunction"> } = {
	isXsdPattern: identity.libraryFunction(
		"isXsdPattern",
		constantDigest("library-function", definitions.isXsdPattern, everyProperty)
	),
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
const imageFunctions: { readonly [I in KeyImage]: LibraryFn } = Object.freeze({
	textDigest: "textDigest"
})

/** A library function's CREATE in the schema `schema`: an installation's, or a session's pg_temp. */
export const libraryCreate = (schema: string, fn: LibraryFn): CreateConstant => ({
	kind: "createConstant",
	language: "sql",
	name: { schema, name: libraryIdentity(fn).identifier },
	...definitions[fn]
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
				ddl: [create, constantRevoke(create)],
				reasons: [enforcement(`the library function ${fn}`)]
			},
			[b.schemaNode]
		)
	}
}
