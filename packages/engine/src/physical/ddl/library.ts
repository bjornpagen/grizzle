/**
 * grizzle's library (ir/physical.ts LibraryFn): the SQL functions of its own a scalar operation's SQL calls, each a
 * constant of parameters (sql/ast.ts LibraryConstant), `LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE RETURN <body>`,
 * STRICT exactly where the host term over it is (strictOf), its body this module's, named by its definition's digest,
 * its strictness among it (core/identity.ts libraryFunction), which an installation installs
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
import { millisPerDay, wallCycle } from "#compiler/core/clock.ts"
import { constantDigest } from "#compiler/core/fingerprint.ts"
import { type Identity, identity } from "#compiler/core/identity.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { exprClosure, type ScalarExpr } from "#compiler/ir/expr.ts"
import { type LibraryFn, libraryFns } from "#compiler/ir/physical.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { persistentExprs } from "#compiler/physical/ddl/constants.ts"
import { constantRevoke, type InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { enforcement } from "#compiler/physical/obligations/graph.ts"
import { libraryOf, nativeOp, nativeOps, nullRules } from "#compiler/scalar/compute/registry.ts"
import type {
	Expr,
	FrameBound,
	FromItem,
	FromSource,
	Cte,
	FunctionParam,
	LibraryConstant,
	OperandSelect,
	QualifiedFunctionRef,
	TypeRef
} from "#compiler/sql/ast.ts"
import {
	and,
	arrayOf,
	asc,
	binary,
	call,
	cast,
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
	targetAs,
	types,
	windowOf
} from "#compiler/sql/build.ts"
import { freshNames, NameSupply } from "#compiler/sql/naming.ts"
import { inertVisitor, visitExpr } from "#compiler/sql/transform.ts"

/** A library function's body: its parameters, read by position in it, its result type and its expression. */
interface LibraryBody {
	readonly params: ReadonlyArray<FunctionParam>
	readonly returns: TypeRef
	readonly body: Expr
}

/** A library function's definition: its body, and whether it is STRICT (strictOf). */
interface LibraryDefinition extends LibraryBody {
	readonly strict: boolean
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

/** Named columns of a derived table or a step: each the name the body reads it by and its value. */
type Columns = NonEmptyReadonlyArray<readonly [string, Expr]>

/** A name origin of the library: a body's relation or column, by what it holds. */
const internal = (purpose: string) => ({ kind: "internal", purpose: `library ${purpose}` }) as const

/**
 * A relation of a library body: its alias and its columns, each minted by the body's name supply (sql/naming.ts
 * NameSupply), as every statement grizzle emits names its relations and columns, so no name a body holds is a name a
 * caller or another body could hold, and the structural audit reads every one as generated. The body reads each column
 * by the name it states it by (`read`), which no SQL spells.
 */
interface Named {
	readonly alias: string
	/** The minted columns, in the order the body states them. */
	readonly columns: NonEmptyReadonlyArray<string>
	/** The minted name of the column the body states as `name`. */
	readonly column: (name: string) => string
	/** The column the body states as `name`, read through the relation's alias. */
	readonly read: (name: string) => Expr
}

/** A relation of `what`, of the columns the body states as `heading`, its alias and each column minted by `names`. */
const relationOf = (
	names: NameSupply,
	what: string,
	heading: NonEmptyReadonlyArray<string>
): Named => {
	const alias = names.relation(internal(what))
	const columns = mapNonEmpty(heading, (name) => names.column(internal(`${what} ${name}`)))
	const minted = new Map(heading.map((name, i) => [name, columns[i]] as const))
	const column = (name: string): string =>
		defined(minted.get(name), `the column ${name} of the library's ${what}`)
	return { alias, columns, column, read: (name) => col(alias, column(name)) }
}

/** A derived table and its columns as the body reads them (`Named`). */
interface Table {
	readonly source: FromSource
	readonly read: (name: string) => Expr
}

/**
 * `relation` as a derived table of `columns` over `sources`, `(SELECT … FROM sources) AS alias(columns)`, LATERAL where
 * it reads the sources before it, each column the relation's own, which states them in the same order.
 */
const tableOf = (
	relation: Named,
	columns: Columns,
	sources: ReadonlyArray<FromItem>,
	lateral: boolean
): Table => ({
	source: derived(
		operandSelect(
			core(
				columns.map(([name, value]) => targetAs(value, relation.column(name))),
				sources,
				undefined
			)
		),
		relation.alias,
		columns.map(([name]) => relation.column(name)),
		lateral
	),
	read: relation.read
})

/** A derived table of `what` over `sources` (`tableOf`), its names minted by `names`. */
const table = (
	names: NameSupply,
	what: string,
	columns: Columns,
	sources: ReadonlyArray<FromItem>,
	lateral: boolean
): Table =>
	tableOf(
		relationOf(
			names,
			what,
			mapNonEmpty(columns, ([name]) => name)
		),
		columns,
		sources,
		lateral
	)

/** One row of `columns` over the sources before it, `LATERAL (SELECT …) AS alias(columns)`, or over none. */
const step = (names: NameSupply, what: string, columns: Columns, lateral: boolean): Table =>
	table(names, what, columns, [], lateral)

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

/** The window function `name` of `arg` over the rows `frame` names, the segments in order of `order`. */
const windowed = (name: "sum" | "min", arg: Expr, frame: Frame, order: Expr): Expr => ({
	...call(name, [arg]),
	over: { ...windowOf([], [asc(order)]), frame }
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
const removeDotSegments = (names: NameSupply, input: Expr): Expr => {
	const split = relationOf(names, "path segments", ["t", "k"])
	const segments: FromSource = {
		kind: "function",
		call: call("string_to_table", [input, text("/")]),
		alias: split.alias,
		columns: split.columns,
		lateral: false,
		ordinality: true
	}
	const s = split.read
	const counted = table(
		names,
		"counted segments",
		[
			["t", s("t")],
			["k", s("k")],
			["dot", dotSegment(s("t"))],
			["count", { ...countStar(), over: windowOf([], []) }],
			[
				"plain",
				windowed("sum", when(dotSegment(s("t")), integer(0), integer(1)), throughHere, s("k"))
			]
		],
		[segments],
		false
	)
	const g = counted.read
	const led = table(
		names,
		"led segments",
		[
			["t", g("t")],
			["k", g("k")],
			["dot", g("dot")],
			["last", eq(g("k"), g("count"))],
			["lead", eq(g("plain"), when(g("dot"), integer(0), integer(1)))]
		],
		[counted.source],
		false
	)
	const l = led.read
	const moves = table(
		names,
		"segment moves",
		[
			["k", l("k")],
			[
				"unit",
				{
					kind: "case",
					operand: undefined,
					whens: [
						{ when: l("lead"), result: l("t") },
						{ when: l("dot"), result: text("/") }
					],
					else: concat(text("/"), l("t"))
				}
			],
			[
				"push",
				{
					kind: "case",
					operand: undefined,
					whens: [
						{ when: not(l("dot")), result: integer(1) },
						{ when: l("lead"), result: integer(0) },
						{ when: l("last"), result: integer(1) }
					],
					else: integer(0)
				}
			],
			["pop", when(and([not(l("lead")), eq(l("t"), text(".."))]), integer(1), integer(0))]
		],
		[led.source],
		false
	)
	const p = moves.read
	const running = table(
		names,
		"running pushes",
		[
			["k", p("k")],
			["unit", p("unit")],
			["push", p("push")],
			["n", windowed("sum", binary("-", p("push"), p("pop")), throughHere, p("k"))]
		],
		[moves.source],
		false
	)
	const n = running.read
	const later = table(
		names,
		"later pushes",
		[
			["k", n("k")],
			["unit", n("unit")],
			["push", n("push")],
			["n", n("n")],
			["later", windowed("min", binary("-", n("n"), n("push")), afterHere, n("k"))]
		],
		[running.source],
		false
	)
	const a = later.read
	const kept = and([eq(a("push"), integer(1)), ge(firstNonNull([a("later"), a("n")]), a("n"))])
	const joined: Expr = {
		...call("string_agg", [a("unit"), text("")]),
		orderBy: [asc(a("k"))]
	}
	return firstNonNull([
		{
			kind: "subquery",
			query: select(
				provedCore(
					"oneRow",
					[targetAs(joined, names.column(internal("path without dot segments")))],
					[later.source],
					kept
				)
			)
		},
		text("")
	])
}

/** The two texts resolveReference splits, the base's parts named `b_…` in a step and the reference's `r_…`. */
const sides = ["b", "r"] as const
type Side = (typeof sides)[number]
const part = (row: Table, side: Side, name: string): Expr => row.read(`${side}_${name}`)
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
const resolveReferenceDefinition = (): LibraryBody => {
	const names = new NameSupply(freshNames)
	const texts: { readonly [S in Side]: Expr } = {
		b: param(1, types.text),
		r: param(2, types.text)
	}
	const fragments = step(
		names,
		"fragments",
		[
			["b_before", before(texts.b, "#")],
			["r_before", before(texts.r, "#")],
			["r_fragment", fromFirst(texts.r, "#")]
		],
		false
	)
	const queries = step(
		names,
		"queries",
		bothSides((side) => [
			["hier", before(part(fragments, side, "before"), "?")],
			["query", fromFirst(part(fragments, side, "before"), "?")]
		]),
		true
	)
	const heads = step(
		names,
		"heads",
		bothSides((side) => [["head", before(part(queries, side, "hier"), ":")]]),
		true
	)
	const schemes = step(
		names,
		"schemes",
		bothSides((side) => {
			const head = part(heads, side, "head")
			const scheme = when(
				and([
					stated(head),
					lt(length(head), length(part(queries, side, "hier"))),
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
		names,
		"afters",
		bothSides((side) => [
			[
				"after",
				from(
					part(queries, side, "hier"),
					binary("+", length(part(schemes, side, "scheme")), integer(1))
				)
			]
		]),
		true
	)
	const authorities = step(
		names,
		"authorities",
		bothSides((side) => {
			const after = part(afters, side, "after")
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
		names,
		"paths",
		bothSides((side) => [
			[
				"path",
				from(
					part(afters, side, "after"),
					binary("+", length(part(authorities, side, "authority")), integer(1))
				)
			]
		]),
		true
	)
	const baseAuthority = part(authorities, "b", "authority")
	const basePath = part(paths, "b", "path")
	const referenceScheme = part(schemes, "r", "scheme")
	const referencePath = part(paths, "r", "path")
	const named = or([stated(referenceScheme), stated(part(authorities, "r", "authority"))])
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
		names,
		"resolved target",
		[
			["scheme", when(stated(referenceScheme), referenceScheme, part(schemes, "b", "scheme"))],
			["authority", when(named, part(authorities, "r", "authority"), baseAuthority)],
			["kept", and([not(named), unstated(referencePath)])],
			[
				"input",
				when(or([named, call("starts_with", [referencePath, text("/")])]), referencePath, merged)
			]
		],
		true
	)
	const kept = targets.read("kept")
	const query = when(
		and([kept, unstated(part(queries, "r", "query"))]),
		part(queries, "b", "query"),
		part(queries, "r", "query")
	)
	const target = concat(
		targets.read("scheme"),
		targets.read("authority"),
		when(kept, basePath, removeDotSegments(names, targets.read("input"))),
		query,
		part(fragments, "r", "fragment")
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
					[targetAs(target, names.column(internal("resolved reference")))],
					[fragments, queries, heads, schemes, afters, authorities, paths, targets].map(
						(t) => t.source
					),
					undefined
				)
			)
		}
	}
}

/**
 * cutBefore(text, chars) and cutFrom(text, chars): `text` before its first character among `chars`, all of it where it
 * holds none, and `text` from that character on, the empty text where it holds none, as @bjornpagen/grizzle-text's
 * text.ts cutBefore and cutFrom compute it on the host, so the two concatenate to `text`. The cut is at the least
 * strpos of `text` over each character of `chars`, `substring(chars, i, 1)` for each place `i` of `chars` from 1, and
 * past `text`'s last character where none is found (min over no place found, or over `chars` empty, is NULL): `left`
 * of `text` to the character before it, or `substring` of `text` from it. strpos, left and substring count code points, as
 * the host does, and each reads `text` once a character of `chars`, which allocates nothing past `text`'s own bytes.
 */
const cutDefinition = (fn: "cutBefore" | "cutFrom"): LibraryBody => {
	const names = new NameSupply(freshNames)
	const subject = param(1, types.text)
	const chars = param(2, types.text)
	const places = relationOf(names, "set places", ["i"])
	const series: FromSource = {
		kind: "function",
		call: call("generate_series", [integer(1), length(chars)]),
		alias: places.alias,
		columns: places.columns,
		lateral: false,
		ordinality: false
	}
	const found = call("strpos", [subject, call("substring", [chars, places.read("i"), integer(1)])])
	const at = firstNonNull([
		call("min", [{ kind: "nullif", expr: found, absent: integer(0) }]),
		binary("+", length(subject), integer(1))
	])
	const cut =
		fn === "cutBefore" ? call("left", [subject, binary("-", at, integer(1))]) : from(subject, at)
	return {
		params: [
			{ name: "text", type: types.text },
			{ name: "chars", type: types.text }
		],
		returns: types.text,
		body: {
			kind: "subquery",
			query: operandSelect(
				core([targetAs(cut, names.column(internal("cut")))], [series], undefined)
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
const xsdPatternDefinition = (): LibraryBody => {
	const pattern = param(1, types.text)
	const width = xsdClasses.length
	const nexts = xsdStates.flatMap((s) => xsdClasses.map((c) => placeOf(xsdStates, moveOf(s, c)[0])))
	const ops = xsdStates.flatMap((s) => xsdClasses.map((c) => placeOf(xsdOps, moveOf(s, c)[1])))
	const state = (s: XsdState): Expr => integer(placeOf(xsdStates, s))
	const op = (o: XsdOp): Expr => integer(placeOf(xsdOps, o))
	const names = new NameSupply(freshNames)
	const lengthNames = relationOf(names, "pattern length", ["n"])
	const splitNames = relationOf(names, "pattern characters", ["c", "k"])
	const charactersNames = relationOf(names, "pattern code points", ["cs", "n"])
	const readNames = relationOf(names, "pattern read", [
		"i",
		"s",
		"parens",
		"depth",
		"first",
		"acc",
		"lo"
	])
	const charNames = relationOf(names, "pattern character", ["c"])
	const classNames = relationOf(names, "pattern class", ["k"])
	const moveNames = relationOf(names, "pattern move", ["next", "op"])
	const afterNames = relationOf(names, "pattern registers", [
		"s",
		"parens",
		"depth",
		"first",
		"acc",
		"lo"
	])
	const r = readNames.read
	const c = charNames.read("c")
	const character = call("chr", [c])
	const moved = moveNames.read("op")
	const next = moveNames.read("next")
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
	const categories = [...xsdCategoryNames, ...[...xmlSchemaBlocks.keys()].map((b) => `Is${b}`)]
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
		alias: splitNames.alias,
		columns: splitNames.columns,
		lateral: false,
		ordinality: true
	}
	/** The pattern's length, one row, carried beside its characters so their aggregate groups by it: a pattern of no
	 * character holds no row of them, and no group, and the recursion reads none, as it reads none of a pattern of n = 0. */
	const counted = tableOf(lengthNames, [["n", length(pattern)]], [], false)
	const characters: Cte = {
		...cte(
			charactersNames.alias,
			charactersNames.columns,
			operandSelect({
				...core(
					[
						targetAs(
							{
								...call("array_agg", [call("ascii", [splitNames.read("c")])]),
								orderBy: [asc(splitNames.read("k"))]
							},
							charactersNames.column("cs")
						),
						targetAs(counted.read("n"), charactersNames.column("n"))
					],
					[counted.source, split],
					undefined
				),
				groupBy: [counted.read("n")]
			})
		),
		materialized: "MATERIALIZED"
	}
	const start = core(
		[
			targetAs(integer(1), readNames.column("i")),
			targetAs(state("branch"), readNames.column("s")),
			targetAs(integer(0), readNames.column("parens")),
			targetAs(integer(0), readNames.column("depth")),
			targetAs(integer(0), readNames.column("first")),
			targetAs(text(""), readNames.column("acc")),
			targetAs(text(""), readNames.column("lo"))
		],
		[],
		undefined
	)
	const cell = binary(
		"+",
		binary("+", binary("*", r("s"), integer(width)), classNames.read("k")),
		integer(1)
	)
	const following = core(
		[
			targetAs(binary("+", r("i"), integer(1)), readNames.column("i")),
			...["s", "parens", "depth", "first", "acc", "lo"].map((x) =>
				targetAs(afterNames.read(x), readNames.column(x))
			)
		],
		[
			cteRef(readNames.alias),
			cteRef(charactersNames.alias),
			tableOf(charNames, [["c", subscript(charactersNames.read("cs"), r("i"))]], [], true).source,
			tableOf(
				classNames,
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
				[],
				true
			).source,
			tableOf(
				moveNames,
				[
					["next", subscript(integers(nexts), cell)],
					["op", subscript(integers(ops), cell)]
				],
				[],
				true
			).source,
			tableOf(
				afterNames,
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
										`{${categories.map((n) => `"${n}"`).join(",")}}`,
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
				[],
				true
			).source
		],
		and([le(r("i"), charactersNames.read("n")), ne(r("s"), state("refused"))])
	)
	const read = cte(
		readNames.alias,
		readNames.columns,
		operandSelect(operandUnionAll([start, following]))
	)
	const last: OperandSelect = {
		...operandSelect(
			core(
				[
					targetAs(
						and([isIn(r("s"), [state("branch"), state("atom")]), eq(r("parens"), integer(0))]),
						names.column(internal("pattern member"))
					)
				],
				[cteRef(readNames.alias)],
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

/**
 * textDigest(text): the SHA-256 digest of a text's UTF-8 bytes, `sha256(convert_to($1, 'UTF8'))`, 32 bytes, the digest
 * Crypto.sha256 over a text is on the host too (scalar/values/sha256.ts Sha256.ofText), a digest field a key may be
 * declared over. An installation's
 * database is UTF8 (grizzle refuses another at its first migration), so convert_to converts nothing and copies the
 * text's bytes as they are stored; convert_to is STABLE in pg_proc only because a conversion's result can depend on the database's
 * encoding, which a database never changes, and sha256 is IMMUTABLE, so the digest is one value of a text wherever it
 * stands, a generated column among them, and the function is declared IMMUTABLE as PostgreSQL's own digests are.
 */
const textDigestDefinition = (): LibraryBody => ({
	params: [{ name: "text", type: types.text }],
	returns: types.bytea,
	body: call("sha256", [call("convert_to", [param(1, types.text), text("UTF8")])])
})

/**
 * wall(bigint, text): a zone's wall clock at an instant, both counted in milliseconds, the instant's since the Unix epoch
 * and the wall clock's since the local epoch, 1970-01-01 00:00 on the zone's clock: the instant plus the zone's offset
 * from UT at it, as PostgreSQL's tzdata reads the zone its IANA name names (registry.ts zoneWall). The instant becomes a
 * timestamp of its UTC wall clock exactly, by integers alone: its day, floored, `'1970-01-01'::date + d`, and its
 * milliseconds into it, `r * '1 millisecond'::interval`, r below a day's, so the product's microseconds are an integer a
 * double holds exactly. The offset at it is the zone's wall clock less that one, `extract('epoch', timezone(zone,
 * timezone('0 seconds'::interval, utc))) - extract('epoch', utc)`, exact numerics of seconds: the timestamptz of the
 * instant is made at offset zero, with no zone looked up. An instant in the first or the last Gregorian cycle of
 * timestamptz's range has its offset read one cycle in (core/clock.ts wallCycle), where it is the same, so no wall clock
 * past the range is built: wall is defined on every instant timestamptz holds. Every function and operator it reads is
 * IMMUTABLE in pg_proc.
 */
const wallDefinition = (): LibraryBody => {
	const instant = param(1, types.bigint)
	const zone = param(2, types.text)
	const bigint = (value: bigint): Expr => lit.int(value, types.bigint)
	const day = bigint(millisPerDay)
	const shift: Expr = {
		kind: "case",
		operand: undefined,
		whens: [
			{ when: lt(instant, bigint(wallCycle.below)), result: bigint(wallCycle.millis) },
			{ when: gt(instant, bigint(wallCycle.above)), result: bigint(-wallCycle.millis) }
		],
		else: bigint(0n)
	}
	const read = binary("+", instant, shift)
	const intoDay = binary("%", binary("+", binary("%", read, day), day), day)
	const days = binary("/", binary("-", read, intoDay), day)
	const utc = binary(
		"+",
		binary("+", lit.text("1970-01-01", types.date), cast(days, types.integer)),
		binary("*", intoDay, lit.text("1 millisecond", types.interval))
	)
	const seconds = (timestamp: Expr): Expr =>
		call("extract", [lit.text("epoch", types.text), timestamp])
	const offsetAt = (timestamp: Expr): Expr =>
		binary(
			"-",
			seconds(
				call("timezone", [
					zone,
					call("timezone", [lit.text("0 seconds", types.interval), timestamp])
				])
			),
			seconds(timestamp)
		)
	const offset = offsetAt(utc)
	return {
		params: [
			{ name: "instant", type: types.bigint },
			{ name: "zone", type: types.text }
		],
		returns: types.bigint,
		body: binary(
			"+",
			instant,
			cast(binary("*", offset, lit.int(1000n, types.integer)), types.bigint)
		)
	}
}

/**
 * Whether the library function `fn` is STRICT: exactly where every native node that calls it (registry.ts libraryOf)
 * meets a NULL operand by the strict rule (registry.ts nullRules), which the host evaluator applies to it, so a call of
 * a NULL argument is NULL in PostgreSQL, which returns it without running the body, as it is on the host. One that is
 * not meets a NULL as its body says, which must then be the host's rule.
 */
const strictOf = (fn: LibraryFn): boolean =>
	nativeOps.every((op) => libraryOf(op.sql) !== fn || nullRules[op.fn] === "strict")

/** `fn`'s definition: its body, and its strictness (strictOf). */
const definedAs = (fn: LibraryFn, body: LibraryBody): LibraryDefinition => ({
	...body,
	strict: strictOf(fn)
})

/** Each library function's definition, made once. */
const definitions: { readonly [F in LibraryFn]: LibraryDefinition } = {
	cutBefore: definedAs("cutBefore", cutDefinition("cutBefore")),
	cutFrom: definedAs("cutFrom", cutDefinition("cutFrom")),
	isXsdPattern: definedAs("isXsdPattern", xsdPatternDefinition()),
	resolveReference: definedAs("resolveReference", resolveReferenceDefinition()),
	textDigest: definedAs("textDigest", textDigestDefinition()),
	wall: definedAs("wall", wallDefinition())
}

/** Each library function's identity, by its name and its definition's digest, minted once. */
const identities: { readonly [F in LibraryFn]: Identity<"libraryFunction"> } = {
	cutBefore: identity.libraryFunction(
		"cutBefore",
		constantDigest("library-function", definitions.cutBefore, everyProperty)
	),
	cutFrom: identity.libraryFunction(
		"cutFrom",
		constantDigest("library-function", definitions.cutFrom, everyProperty)
	),
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
	),
	wall: identity.libraryFunction(
		"wall",
		constantDigest("library-function", definitions.wall, everyProperty)
	)
}

/**
 * Whether a library function's body reads no table, read off the body itself: each FROM item of it is a CTE's, a
 * derived table's, a VALUES list's, a function's or its parameters' rows, every function it calls is PostgreSQL's own,
 * and so none reads a stored table, a write's met rows, a trigger's transition table, an enclosing statement's rows or
 * the session's claims. A body that calls a function of a schema may read what that function reads, so it is no such
 * body.
 */
const bodyReadsNoTable = (body: Expr): boolean => {
	let reads = false
	visitExpr(body, {
		...inertVisitor,
		fromItem: (item) => {
			switch (item.kind) {
				case "cte":
				case "derived":
				case "values":
				case "function":
				case "arrays":
				case "joins":
					return
				case "table":
				case "probe":
				case "met":
				case "metRows":
				case "transition":
				case "enclosing":
				case "context":
					reads = true
			}
		},
		expr: (e) => {
			if (e.kind === "call" && e.fn.kind === "qualified") {
				reads = true
			}
		}
	})
	return !reads
}

/**
 * Each library function whose definition reads no table (bodyReadsNoTable), read off its definition once: what the
 * certifier reads a call of as no read of any relation (program/isolation/certification.ts extractNames).
 */
export const tablelessLibrary: ReadonlyArray<LibraryFn> = libraryFns.filter((fn) =>
	bodyReadsNoTable(definitions[fn].body)
)

/** The library function an expression calls, by its native operation's SQL (registry.ts libraryOf), or none. */
export const calledLibrary = (e: ScalarExpr): LibraryFn | undefined => {
	const sql = e.kind === "op" ? nativeOp(e.op)?.sql : undefined
	return sql === undefined ? undefined : libraryOf(sql)
}

/** The identity a library function is named by (core/identity.ts libraryFunction). */
export const libraryIdentity = (fn: LibraryFn): Identity<"libraryFunction"> => identities[fn]

/** A library function as an installation in `schema` creates it (libraryCreate) and a statement calls it. */
export const libraryRef = (schema: string, fn: LibraryFn): QualifiedFunctionRef => ({
	kind: "qualified",
	schema,
	name: libraryIdentity(fn).identifier
})

/**
 * The library functions the persistent expressions of `model` call (constants.ts persistentExprs), in name order: what
 * the installation's one collector of its artifacts' objects reads for them beside its checked DAGs' calls
 * (physical/install/plan.ts artifactObjects).
 */
export const libraryCalls = (model: LawModel): ReadonlyArray<LibraryFn> => {
	const called = new Set<LibraryFn>()
	for (const e of exprClosure(persistentExprs(model))) {
		const fn = calledLibrary(e)
		if (fn !== undefined) {
			called.add(fn)
		}
	}
	return [...called].toSorted(compareStrings)
}

/** A library function's CREATE in the schema `schema`: an installation's, or a session's pg_temp. */
export const libraryCreate = (schema: string, fn: LibraryFn): LibraryConstant => ({
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
