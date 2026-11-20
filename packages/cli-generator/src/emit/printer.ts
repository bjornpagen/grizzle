import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import { regex } from "arkregex"
import {
	Array as Arr,
	Brand,
	Data,
	Effect,
	Formatter,
	Match,
	Option,
	Order,
	Predicate,
	Record,
	String as Str
} from "effect"
import {
	guardTemplateCurly,
	jsDoc,
	stringLiteral,
	lineWidth,
	identifierPattern,
	keyText,
	numberText
} from "#emit/escape.ts"
import type { JsDocText } from "#emit/escape.ts"
import type { Json } from "#model/pointer.ts"

const reservedWords: ReadonlySet<string> = new Set([
	"arguments",
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"eval",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"implements",
	"import",
	"in",
	"instanceof",
	"interface",
	"let",
	"new",
	"null",
	"package",
	"private",
	"protected",
	"public",
	"return",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"undefined",
	"var",
	"void",
	"while",
	"with",
	"yield"
])

/**
 * A binding name: identifier-shaped ASCII and not a reserved word. Minted only here: by `isIdentifier`, which a name
 * from the plan or the document is read through, and unchecked by `fixedIdentifier` and `path`, whose text is a
 * literal of the emitter's own source.
 */
export type Identifier = string & Brand.Brand<"Identifier">

/** Whether a text is a binding name (`Identifier`): identifier-shaped ASCII and not a reserved word. */
export const isIdentifier = (value: string): value is Identifier =>
	identifierPattern.test(value) && !reservedWords.has(value)

/**
 * A binding name the emitter writes as a literal of its own source (`flags`, `Serialize`). Unchecked: the literal is
 * the proof, the repository's own text and never a document's or a plan's.
 */
export const fixedIdentifier: (text: string) => Identifier = Brand.nominal<Identifier>()

/** A property name after `.`: identifier-shaped ASCII, reserved words allowed. Minted as `Identifier` is. */
export type MemberName = string & Brand.Brand<"MemberName">

/** Whether a text is a property name after `.` (`MemberName`): identifier-shaped ASCII. */
export const isMemberName = (value: string): value is MemberName => identifierPattern.test(value)

/** A property name the emitter writes as a literal of its own source. Unchecked, as `fixedIdentifier` is. */
export const fixedMemberName: (text: string) => MemberName = Brand.nominal<MemberName>()

/** A module specifier in an import statement. Minted as `Identifier` is. */
export type ModuleSpecifier = string & Brand.Brand<"ModuleSpecifier">

const moduleSpecifierPattern = regex("^[A-Za-z0-9@._/-]+$", "u")

/** Whether a text is a module specifier (`ModuleSpecifier`): one or more of `A-Za-z0-9@._/-`. */
export const isModuleSpecifier = (value: string): value is ModuleSpecifier =>
	moduleSpecifierPattern.test(value)

/** A module specifier the emitter writes as a literal of its own source. Unchecked, as `fixedIdentifier` is. */
export const fixedModuleSpecifier: (text: string) => ModuleSpecifier =
	Brand.nominal<ModuleSpecifier>()

/**
 * The interpreter line of an executable module, after `#!`: an absolute path and its arguments. Minted only by
 * `fixedShebang`, since the emitter writes one literal line.
 */
export type Shebang = string & Brand.Brand<"Shebang">

/** An interpreter line the emitter writes as a literal of its own source (`/usr/bin/env node`). Unchecked. */
export const fixedShebang: (text: string) => Shebang = Brand.nominal<Shebang>()

export type TypeExpr =
	| {
			readonly _tag: "TypeRef"
			readonly head: Identifier
			readonly members: readonly MemberName[]
			readonly args: readonly TypeExpr[]
	  }
	| {
			readonly _tag: "TypeKeyword"
			readonly keyword: "boolean" | "never" | "null" | "number" | "string" | "undefined" | "unknown"
	  }
	| { readonly _tag: "TypeLiteral"; readonly value: boolean | number | string }
	| { readonly _tag: "TypeQuery"; readonly name: Identifier }
	| { readonly _tag: "TypeReadonlyArray"; readonly element: TypeExpr }
	| { readonly _tag: "TypeUnion"; readonly members: readonly TypeExpr[] }

export interface Param {
	readonly name: Identifier
	readonly type?: TypeExpr
}

export type Expr =
	| { readonly _tag: "String"; readonly value: string }
	| { readonly _tag: "Number"; readonly value: number }
	| { readonly _tag: "Boolean"; readonly value: boolean }
	| { readonly _tag: "Undefined" }
	| { readonly _tag: "Identifier"; readonly name: Identifier }
	| { readonly _tag: "Member"; readonly object: Expr; readonly name: MemberName }
	| { readonly _tag: "Object"; readonly entries: readonly (readonly [string, Expr])[] }
	| { readonly _tag: "Array"; readonly elements: readonly Expr[] }
	| { readonly _tag: "Call"; readonly callee: Expr; readonly args: readonly Expr[] }
	| {
			readonly _tag: "Arrow"
			readonly params: readonly Param[]
			readonly returns: Option.Option<TypeExpr>
			readonly body: Expr
	  }
	| { readonly _tag: "New"; readonly callee: Expr; readonly args: readonly Expr[] }
	| {
			readonly _tag: "Conditional"
			readonly test: Expr
			readonly consequent: Expr
			readonly alternate: Expr
	  }
	| { readonly _tag: "Plus"; readonly left: Expr; readonly right: Expr }
	| { readonly _tag: "DynamicImport"; readonly from: ModuleSpecifier }

export interface Field {
	readonly key: string
	readonly optional: boolean
	readonly type: TypeExpr
}

export type Statement =
	| {
			readonly _tag: "Const"
			readonly exported: boolean
			readonly name: Identifier
			readonly type?: TypeExpr
			readonly value: Expr
			readonly asConst?: boolean
			readonly doc?: JsDocText
	  }
	| {
			readonly _tag: "Interface"
			readonly name: Identifier
			readonly fields: readonly Field[]
			readonly doc?: JsDocText
	  }
	| {
			readonly _tag: "TypeAlias"
			readonly name: Identifier
			readonly type: TypeExpr
			readonly doc?: JsDocText
	  }
	| { readonly _tag: "Expression"; readonly value: Expr }

export type Import =
	| {
			readonly _tag: "Named"
			readonly typeOnly: boolean
			readonly names: readonly Identifier[]
			readonly from: ModuleSpecifier
	  }
	| {
			readonly _tag: "Namespace"
			readonly typeOnly: boolean
			readonly name: Identifier
			readonly from: ModuleSpecifier
	  }

export interface Module {
	readonly shebang?: Shebang
	readonly imports: readonly Import[]
	readonly statements: readonly Statement[]
}

/**
 * The module holds a construct outside the printer's syntax subset.
 */
export class PrinterError extends Data.TaggedError("PrinterError")<{
	readonly reason:
		| "duplicate-key"
		| "non-finite-number"
		| "unbreakable-line"
		| "unsupported-arrow-body"
		| "unsupported-chain"
		| "unsupported-conditional"
		| "unsupported-expression"
		| "unsupported-member"
		| "unsupported-new"
		| "unsupported-package-json"
		| "unsupported-plus"
	readonly subject: string
}> {}

export const str = (value: string): Expr => ({ _tag: "String", value })

export const num = (value: number): Expr => ({ _tag: "Number", value })

export const bool = (value: boolean): Expr => ({ _tag: "Boolean", value })

export const undef: Expr = { _tag: "Undefined" }

export const ident = (name: Identifier): Expr => ({ _tag: "Identifier", name })

export const member = (object: Expr, name: MemberName): Expr => ({
	_tag: "Member",
	name,
	object
})

export const obj = (entries: readonly (readonly [string, Expr])[]): Expr => ({
	_tag: "Object",
	entries
})

export const arr = (elements: readonly Expr[]): Expr => ({ _tag: "Array", elements })

export const call = (callee: Expr, args: readonly Expr[]): Expr => ({ _tag: "Call", args, callee })

/**
 * `path("a.b.c")`: the member access `a.b.c`, its names literals of the emitter's own source, as fixedIdentifier and
 * fixedMemberName take them.
 */
export const path = (dotted: string): Expr => {
	const [head, ...rest] = Str.split(dotted, ".")

	return Arr.reduce(rest, ident(fixedIdentifier(head)), (expr, name) =>
		member(expr, fixedMemberName(name))
	)
}

/** `fn("a.b", x)`: a call of the fixed path `a.b` (path) on its arguments. */
export const fn = (dotted: string, ...args: readonly Expr[]): Expr => call(path(dotted), args)

/**
 * An arrow function without a return type: `(params) => body`.
 */
export const arrow = (params: readonly Param[], body: Expr): Expr => ({
	_tag: "Arrow",
	body,
	params,
	returns: Option.none()
})

/**
 * An arrow function with its return type: `(params): Returns => body`.
 */
export const typedArrow = (params: readonly Param[], body: Expr, returns: TypeExpr): Expr => ({
	_tag: "Arrow",
	body,
	params,
	returns: Option.some(returns)
})

export const newExpr = (callee: Expr, args: readonly Expr[]): Expr => ({
	_tag: "New",
	args,
	callee
})

const regExpName = fixedIdentifier("RegExp")

export const regExp = (source: string): Expr => newExpr(ident(regExpName), [str(source), str("u")])

export const conditional = (test: Expr, consequent: Expr, alternate: Expr): Expr => ({
	_tag: "Conditional",
	alternate,
	consequent,
	test
})

export const plus = (left: Expr, right: Expr): Expr => ({ _tag: "Plus", left, right })

/**
 * `import("<from>")`: a dynamic import of a module, printed with a literal specifier.
 */
export const dynamicImport = (from: ModuleSpecifier): Expr => ({ _tag: "DynamicImport", from })

/**
 * A generic type applied to its arguments: `head`, each member after `.`, then `<args>`.
 */
export const typeApply = (
	head: Identifier,
	members: readonly MemberName[],
	args: readonly TypeExpr[]
): TypeExpr => ({ _tag: "TypeRef", args, head, members })

/**
 * A type named by a path: `head`, then each member after `.`.
 */
export const typeRef = (head: Identifier, members: readonly MemberName[]): TypeExpr =>
	typeApply(head, members, [])

/**
 * A type named by one identifier.
 */
export const typeName = (head: Identifier): TypeExpr => typeApply(head, [], [])

export const typeKeyword = (
	keyword: Extract<TypeExpr, { readonly _tag: "TypeKeyword" }>["keyword"]
): TypeExpr => ({ _tag: "TypeKeyword", keyword })

export const typeLiteral = (value: boolean | number | string): TypeExpr => ({
	_tag: "TypeLiteral",
	value
})

/**
 * `typeof name`: the type of a value binding, so a type the code infers (a reader's) is named once, by its value.
 */
export const typeQuery = (name: Identifier): TypeExpr => ({ _tag: "TypeQuery", name })

export const typeReadonlyArray = (element: TypeExpr): TypeExpr => ({
	_tag: "TypeReadonlyArray",
	element
})

export const typeUnion = (members: readonly TypeExpr[]): TypeExpr => ({
	_tag: "TypeUnion",
	members
})

type ArrowExpr = Extract<Expr, { readonly _tag: "Arrow" }>

type Entry = readonly [string, Expr]

/**
 * East Asian Wide and Fullwidth blocks: vp fmt counts each such code point as two columns.
 */
const wideRanges: readonly (readonly [number, number])[] = [
	[0x11_00, 0x11_5f],
	[0x23_29, 0x23_2a],
	[0x2e_80, 0x30_3e],
	[0x30_41, 0x33_ff],
	[0x34_00, 0x4d_bf],
	[0x4e_00, 0x9f_ff],
	[0xa0_00, 0xa4_cf],
	[0xa9_60, 0xa9_7f],
	[0xac_00, 0xd7_a3],
	[0xf9_00, 0xfa_ff],
	[0xfe_10, 0xfe_19],
	[0xfe_30, 0xfe_6f],
	[0xff_00, 0xff_60],
	[0xff_e0, 0xff_e6],
	[0x1_6f_e0, 0x1_6f_ff],
	[0x1_70_00, 0x1_8d_8f],
	[0x1_af_f0, 0x1_b2_ff],
	[0x1_f2_00, 0x1_f2_ff],
	[0x2_00_00, 0x2_ff_fd],
	[0x3_00_00, 0x3_ff_fd]
]

const zeroWidthPattern = regex("^[\\p{Mn}\\p{Me}\\p{Cf}]", "u")

const emojiPattern = regex("^\\p{Emoji_Presentation}", "u")

/**
 * The display columns of the code point `point`, spelled `char`, as `vp fmt` counts them.
 */
const pointWidth = (point: number, char: string): number => {
	if (point < 0x7f) {
		return 1
	}

	if (zeroWidthPattern.test(char)) {
		return 0
	}

	const wide =
		emojiPattern.test(char) || Arr.some(wideRanges, ([low, high]) => point >= low && point <= high)

	return wide ? 2 : 1
}

/**
 * The display columns of one code point, as `vp fmt` counts them.
 */
const charWidth = (char: string): number =>
	Option.match(Str.codePointAt(char, 0), {
		onNone: () => 0,
		onSome: (point) => pointWidth(point, char)
	})

/**
 * Display columns, as `vp fmt` counts them (docs/printer.md Layout).
 */
export const textWidth = (text: string): number => {
	let total = 0
	for (const char of text) {
		total += charWidth(char)
	}

	return total
}

const pad = (indent: number): string => Str.repeat(indent)(" ")

const endColumn = (start: number, text: string): number =>
	Option.match(Str.lastIndexOf("\n")(text), {
		onNone: () => start + textWidth(text),
		onSome: (lastBreak) => textWidth(Str.slice(lastBreak + 1)(text))
	})

/**
 * Where a form starts, the indent of its line, and the width of the text after it up to the next
 * line break the layout emits.
 */
interface Place {
	readonly column: number
	readonly indent: number
	readonly tail: number
}

type Render = (expr: Expr, place: Place) => string

const fits = (text: string, place: Place): boolean =>
	place.column + textWidth(text) + place.tail <= lineWidth

/**
 * Whether a form has a flat text and that text fits at `place`.
 */
const fitsFlat = (text: string | undefined, place: Place): boolean =>
	text !== undefined && fits(text, place)

const isDefined = (text: string | undefined): text is string => text !== undefined

const flatList = (
	items: readonly (string | undefined)[],
	open: string,
	close: string
): string | undefined => {
	if (items.length === 0) {
		return `${Str.trim(open)}${Str.trim(close)}`
	}

	return Arr.every(items, isDefined) ? `${open}${Arr.join(items, ", ")}${close}` : undefined
}

const byKey = Order.mapInput(Order.String, (entry: Entry) => entry[0])

const sortEntries = (entries: readonly Entry[]): readonly Entry[] => Arr.sort(entries, byKey)

const literalTypeText = (value: boolean | number | string): string => {
	if (Predicate.isString(value)) {
		return stringLiteral(value)
	}

	return Predicate.isNumber(value) ? numberText(value) : String(value)
}

const typeText = (type: TypeExpr): string =>
	Match.valueTags(type, {
		TypeKeyword: (keyword) => keyword.keyword,
		TypeLiteral: (literal) => literalTypeText(literal.value),
		TypeQuery: (query) => `typeof ${query.name}`,
		TypeReadonlyArray: (array) =>
			array.element._tag === "TypeUnion" || array.element._tag === "TypeQuery"
				? `readonly (${typeText(array.element)})[]`
				: `readonly ${typeText(array.element)}[]`,
		TypeRef: (reference) => {
			const name = Arr.join([reference.head, ...reference.members], ".")
			const args = Arr.join(Arr.map(reference.args, typeText), ", ")

			return reference.args.length === 0 ? name : `${name}<${args}>`
		},
		TypeUnion: (union) => Arr.join(Arr.map(union.members, typeText), " | ")
	})

const paramText = (param: Param): string =>
	param.type === undefined ? param.name : `${param.name}: ${typeText(param.type)}`

const returnsText = (expr: ArrowExpr): string =>
	Option.match(expr.returns, { onNone: () => "", onSome: (type) => `: ${typeText(type)}` })

const arrowHead = (expr: ArrowExpr): string =>
	`(${Arr.join(Arr.map(expr.params, paramText), ", ")})${returnsText(expr)} =>`

const isPath = (expr: Expr): boolean =>
	expr._tag === "Identifier" || (expr._tag === "Member" && isPath(expr.object))

const entryCount = (expr: Expr): number => {
	if (expr._tag === "Object") {
		return expr.entries.length
	}

	return expr._tag === "Array" ? expr.elements.length : 0
}

/**
 * Two or more elements that are all object literals, or all array literals, with more than one
 * entry each.
 */
const alwaysBroken = (elements: readonly Expr[]): boolean => {
	const [first] = elements

	return (
		elements.length > 1 &&
		Arr.every(
			elements,
			(element) =>
				(element._tag === "Object" || element._tag === "Array") &&
				element._tag === first?._tag &&
				entryCount(element) > 1
		)
	)
}

const isNumberList = (elements: readonly Expr[]): boolean =>
	elements.length > 1 && Arr.every(elements, (element) => element._tag === "Number")

/**
 * The widest identifier or string literal the formatter calls a short call argument: a quarter of the line.
 */
const shortArgumentWidth = lineWidth / 4

/**
 * A call argument the formatter calls short (measured): a string literal or an identifier no wider than a quarter of
 * the line in display columns (textWidth, so a wide character counts two), `undefined`, a number or a boolean. An
 * object or array literal is never one, empty or not: a chain taking `{}` or `[]` that does not fit beside `=` or `:`
 * breaks that argument list there, `a.pipe()(` with `{},` on the next line, rather than moving below.
 */
const isShortArgument = (expr: Expr): boolean =>
	(expr._tag === "Identifier" && textWidth(expr.name) <= shortArgumentWidth) ||
	(expr._tag === "String" && textWidth(stringLiteral(expr.value)) <= shortArgumentWidth) ||
	expr._tag === "Undefined" ||
	expr._tag === "Number" ||
	expr._tag === "Boolean"

/**
 * A chain the formatter cannot break well (measured): member accesses and calls down to an identifier, each call
 * taking no argument or one short one, and `import()` of a short specifier, so it moves the chain below `=` or `:`
 * whole instead of breaking it.
 */
const isPoorChain = (expr: Expr): boolean => {
	if (expr._tag === "DynamicImport") {
		return stringLiteral(expr.from).length <= shortArgumentWidth
	}

	if (expr._tag === "Member") {
		return isPoorChain(expr.object) || expr.object._tag === "Identifier"
	}

	if (expr._tag !== "Call") {
		return false
	}

	const [only] = expr.args
	const shortArgs =
		expr.args.length === 0 ||
		(expr.args.length === 1 && only !== undefined && isShortArgument(only))

	return shortArgs && (expr.callee._tag === "Identifier" || isPoorChain(expr.callee))
}

/**
 * Values that move below `=` or `:` when they do not fit after it: strings, `undefined`, negative numbers, paths and
 * chains the formatter cannot break well.
 */
const movesWhenLong = (expr: Expr): boolean =>
	expr._tag === "String" ||
	expr._tag === "Undefined" ||
	(expr._tag === "Number" && expr.value < 0) ||
	isPath(expr) ||
	isPoorChain(expr)

const flatPair = (left: string | undefined, separator: string, right: string | undefined) =>
	left === undefined || right === undefined ? undefined : `${left}${separator}${right}`

/**
 * Arguments the formatter breaks one per line whatever their width, its function-composition rule (measured): two or
 * more of them, of which two are arrow functions or one is a call that takes an arrow function. A `new` expression
 * taking an arrow and an arrow inside an object or array literal do not count.
 */
const isComposition = (args: readonly Expr[]): boolean =>
	args.length > 1 &&
	(Arr.filter(args, (arg) => arg._tag === "Arrow").length > 1 ||
		Arr.some(
			args,
			(arg) => arg._tag === "Call" && Arr.some(arg.args, (inner) => inner._tag === "Arrow")
		))

/**
 * An argument list printed on one line, which composition arguments never are.
 */
const flatArgs = (args: readonly Expr[]): string | undefined =>
	isComposition(args) ? undefined : flatList(Arr.map(args, flat), "(", ")")

const flat = (expr: Expr): string | undefined =>
	Match.valueTags(expr, {
		Array: (list) =>
			alwaysBroken(list.elements) ? undefined : flatList(Arr.map(list.elements, flat), "[", "]"),
		Arrow: (lambda) => {
			const body = flat(lambda.body)

			return flatPair(arrowHead(lambda), " ", lambda.body._tag === "Object" ? `(${body})` : body)
		},
		Boolean: (literal) => String(literal.value),
		Call: (invocation) => flatPair(flat(invocation.callee), "", flatArgs(invocation.args)),
		Conditional: (choice) =>
			flatPair(
				flatPair(flat(choice.test), " ? ", flat(choice.consequent)),
				" : ",
				flat(choice.alternate)
			),
		DynamicImport: (entry) => `import(${stringLiteral(entry.from)})`,
		Identifier: (name) => name.name,
		Member: (access) => flatPair(flat(access.object), ".", access.name),
		New: (construct) =>
			flatPair(`new ${flat(construct.callee) ?? ""}`, "", flatArgs(construct.args)),
		Number: (literal) => numberText(literal.value),
		Object: (literal) => {
			const entries = Arr.map(sortEntries(literal.entries), ([key, value]) =>
				flatPair(keyText(key), ": ", flat(value))
			)

			return flatList(entries, "{ ", " }")
		},
		Plus: (sum) => flatPair(flat(sum.left), " + ", flat(sum.right)),
		String: (literal) => stringLiteral(literal.value),
		Undefined: () => "undefined"
	})

const block = (open: string, lines: readonly string[], indent: number, close: string): string =>
	Arr.join([open, ...lines, `${pad(indent)}${close}`], "\n")

/**
 * Packs pre-punctuated items greedily, as many per line as end at or before column 100.
 */
const fillLines = (items: readonly string[], indent: number): readonly string[] => {
	const lines: string[] = []
	let current = ""
	for (const item of items) {
		if (current === "") {
			current = item
		} else if (indent + textWidth(current) + 1 + textWidth(item) <= lineWidth) {
			current = `${current} ${item}`
		} else {
			lines.push(current)
			current = item
		}
	}

	lines.push(current)

	return Arr.map(lines, (line) => `${pad(indent)}${line}`)
}

/**
 * A value the formatter moves below `=` or `:` whole when it does not fit: one of `movesWhenLong` (a chain among them,
 * which still breaks in its first argument list where it is not the value itself, as a conditional's test), or one it
 * has no point to break, an empty object or array literal or a `new` expression without arguments.
 */
const isUnbreakable = (expr: Expr): boolean =>
	movesWhenLong(expr) ||
	(expr._tag === "Object" && expr.entries.length === 0) ||
	(expr._tag === "Array" && expr.elements.length === 0) ||
	(expr._tag === "New" && expr.args.length === 0)

/**
 * Whether a call, or a member access down a chain of them, holds an argument: an argument list the formatter can break,
 * which an empty one is not.
 */
const holdsArgument = (expr: Expr): boolean =>
	expr._tag === "Call"
		? expr.args.length > 0 || holdsArgument(expr.callee)
		: expr._tag === "Member" && holdsArgument(expr.object)

/**
 * The text of a value up to the first point the formatter can break it, none when it has no such point (measured): a
 * non-empty literal's opening bracket; a call's head up to the first argument list of its chain that holds an argument,
 * an empty one being no point to break; a `new` expression's head up to its `(` when it takes an argument; an arrow's
 * `(` or, without parameters, its head; a conditional's test up to its first point, or all of the test when it has
 * none; and `left +` of a sum.
 */
const firstLine = (expr: Expr): Option.Option<string> =>
	Match.valueTags(expr, {
		Array: (list) => (list.elements.length > 0 ? Option.some("[") : Option.none()),
		Arrow: (lambda) =>
			Option.some(
				lambda.params.length > 0 ? "(" : `${arrowHead(lambda)}${headTail(lambda) > 0 ? " (" : ""}`
			),
		Boolean: () => Option.none(),
		Call: (invocation) => {
			const { callee } = invocation
			const inner = callee._tag === "Member" ? callee.object : callee
			if (inner._tag === "Call" && holdsArgument(inner)) {
				return firstLine(inner)
			}

			return invocation.args.length > 0
				? Option.map(Option.fromUndefinedOr(flat(callee)), (text) => `${text}(`)
				: Option.none()
		},
		Conditional: (choice) =>
			Option.orElse(firstLine(choice.test), () => Option.fromUndefinedOr(flat(choice.test))),
		DynamicImport: () => Option.none(),
		Identifier: () => Option.none(),
		Member: () => Option.none(),
		New: (construct) =>
			construct.args.length > 0
				? Option.map(Option.fromUndefinedOr(flat(construct.callee)), (text) => `new ${text}(`)
				: Option.none(),
		Number: () => Option.none(),
		Object: (literal) => (literal.entries.length > 0 ? Option.some("{") : Option.none()),
		Plus: (sum) => Option.map(Option.fromUndefinedOr(flat(sum.left)), (text) => `${text} +`),
		String: () => Option.none(),
		Undefined: () => Option.none()
	})

/**
 * Whether the formatter moves a value below `=` or `:` and lays it out there (measured, its fluid assignment layout): a
 * non-negative number or a boolean never moves; a value it cannot break moves when it does not fit whole; any other
 * value moves when its first line does not fit.
 */
const movesBelow = (expr: Expr, place: Place): boolean => {
	if (expr._tag === "Boolean" || (expr._tag === "Number" && expr.value >= 0)) {
		return false
	}

	return isUnbreakable(expr)
		? !fitsFlat(flat(expr), place)
		: Option.exists(firstLine(expr), (head) => !fits(head, { ...place, tail: 0 }))
}

const renderProperty = (key: string, value: Expr, indent: number, render: Render): string => {
	const place = { column: indent + textWidth(key) + 2, indent, tail: 1 }
	if (textWidth(key) >= 5 && movesBelow(value, place)) {
		const inner = indent + 2

		return `${key}:\n${pad(inner)}${render(value, { column: inner, indent: inner, tail: 1 })}`
	}

	return `${key}: ${render(value, place)}`
}

const renderObject = (entries: readonly Entry[], indent: number, render: Render): string => {
	if (entries.length === 0) {
		return "{}"
	}

	const inner = indent + 2
	const lines = Arr.map(
		sortEntries(entries),
		([key, value]) => `${pad(inner)}${renderProperty(keyText(key), value, inner, render)},`
	)

	return block("{", lines, indent, "}")
}

const renderArray = (elements: readonly Expr[], indent: number, render: Render): string => {
	if (elements.length === 0) {
		return "[]"
	}

	const inner = indent + 2
	const place = { column: inner, indent: inner, tail: 1 }
	const lines = isNumberList(elements)
		? fillLines(
				Arr.map(elements, (element) => `${flat(element) ?? ""},`),
				inner
			)
		: Arr.map(elements, (element) => `${pad(inner)}${render(element, place)},`)

	return block("[", lines, indent, "]")
}

const huggable = (expr: Expr): boolean => {
	if (expr._tag === "Object" || expr._tag === "Array") {
		return entryCount(expr) > 0
	}

	return (
		expr._tag === "Arrow" &&
		(expr.body._tag === "Object" || expr.body._tag === "Array" || expr.body._tag === "Call")
	)
}

const canHug = (args: readonly Expr[]): boolean => {
	const last = args.at(-1)
	const before = args.at(-2)
	if (last === undefined || !huggable(last) || before?._tag === last._tag) {
		return false
	}

	if (args.length === 2 && before?._tag === "Arrow" && last._tag === "Array") {
		return false
	}

	return !(args.length > 1 && last._tag === "Array" && isNumberList(last.elements))
}

const opening = (expr: Expr): string => {
	if (expr._tag !== "Arrow") {
		return expr._tag === "Object" ? "{" : "["
	}

	if (expr.body._tag === "Object") {
		return `${arrowHead(expr)} ({`
	}

	return expr.body._tag === "Array" ? `${arrowHead(expr)} [` : arrowHead(expr)
}

const renderMovedBody = (expr: ArrowExpr, indent: number, tail: number, render: Render) => {
	const inner = indent + 2

	return `${arrowHead(expr)}\n${pad(inner)}${render(expr.body, { column: inner, indent: inner, tail })}`
}

/**
 * The last argument opens on the call's line and is printed broken. A hugged arrow whose body
 * moves ends with `,` and leaves `)` to its own line.
 */
const renderHugged = (expr: Expr, indent: number, render: Render): string => {
	if (expr._tag === "Object") {
		return renderObject(expr.entries, indent, render)
	}

	if (expr._tag === "Array") {
		return renderArray(expr.elements, indent, render)
	}

	if (expr._tag !== "Arrow") {
		return flat(expr) ?? ""
	}

	if (expr.body._tag === "Object") {
		return `${arrowHead(expr)} (${renderObject(expr.body.entries, indent, render)})`
	}

	if (expr.body._tag === "Array") {
		return `${arrowHead(expr)} ${renderArray(expr.body.elements, indent, render)}`
	}

	return `${renderMovedBody(expr, indent, 1, render)},\n${pad(indent)}`
}

const renderArgs = (args: readonly Expr[], place: Place, render: Render): string => {
	const flats = Arr.map(args, flat)
	const flatText = flatArgs(args)
	if (flatText !== undefined && (args.length === 0 || fits(flatText, place))) {
		return flatText
	}

	const last = args.at(-1)
	const leading = flats.slice(0, -1)
	if (last !== undefined && !isComposition(args) && canHug(args) && Arr.every(leading, isDefined)) {
		const prefix = `(${Arr.join(
			Arr.map(leading, (text) => `${text}, `),
			""
		)}`
		if (place.column + textWidth(prefix) + textWidth(opening(last)) <= lineWidth) {
			return `${prefix}${renderHugged(last, place.indent, render)})`
		}
	}

	const inner = place.indent + 2
	const at = { column: inner, indent: inner, tail: 1 }
	const lines = Arr.map(args, (arg) => `${pad(inner)}${render(arg, at)},`)

	return block("(", lines, place.indent, ")")
}

/**
 * The text after `=>` that stays on the head's line: ` ({` or ` [` before a literal body.
 */
const headTail = (expr: ArrowExpr): number => {
	if (expr.body._tag === "Object") {
		return 3
	}

	return expr.body._tag === "Array" ? 2 : 0
}

/**
 * When the head's line runs past column 100, the parameters break one per line and the head ends
 * with `): Returns =>` at the arrow's indent. The body is then laid out after that line.
 */
const renderBrokenHead = (expr: ArrowExpr, place: Place, render: Render): string => {
	const inner = place.indent + 2
	const params = Arr.map(expr.params, (param) => `${pad(inner)}${paramText(param)},`)
	const close = `)${returnsText(expr)} =>`
	const head = block("(", params, place.indent, close)
	const column = place.indent + textWidth(close) + 1
	const body = flat(expr.body)
	const flatBody = expr.body._tag === "Object" ? flatPair("(", "", flatPair(body, "", ")")) : body
	if (flatBody !== undefined && fits(flatBody, { ...place, column })) {
		return `${head} ${flatBody}`
	}

	if (expr.body._tag === "Object") {
		const at = { column: column + 1, indent: place.indent, tail: place.tail + 1 }

		return `${head} (${render(expr.body, at)})`
	}

	if (expr.body._tag === "Array") {
		return `${head} ${render(expr.body, { ...place, column })}`
	}

	const moved = { column: inner, indent: inner, tail: place.tail }

	return `${head}\n${pad(inner)}${render(expr.body, moved)}`
}

const renderArrow = (expr: ArrowExpr, place: Place, render: Render): string => {
	const head = arrowHead(expr)
	const column = place.column + textWidth(head) + 1
	if (expr.params.length > 0 && column - 1 + headTail(expr) > lineWidth) {
		return renderBrokenHead(expr, place, render)
	}

	if (expr.body._tag === "Object") {
		const at = { column: column + 1, indent: place.indent, tail: place.tail + 1 }

		return `${head} (${render(expr.body, at)})`
	}

	if (expr.body._tag === "Array") {
		return `${head} ${render(expr.body, { ...place, column })}`
	}

	return renderMovedBody(expr, place.indent, place.tail, render)
}

type ConditionalExpr = Extract<Expr, { readonly _tag: "Conditional" }>

/**
 * The test stays on the line; each branch starts a line one level deeper, after `? ` or `: `, and
 * lays out two columns further in.
 */
const renderConditional = (expr: ConditionalExpr, place: Place, render: Render): string => {
	const inner = place.indent + 2
	const branch = { column: inner + 2, indent: inner + 2, tail: 0 }
	const test = render(expr.test, { ...place, tail: 0 })
	const consequent = render(expr.consequent, branch)
	const alternate = render(expr.alternate, { ...branch, tail: place.tail })

	return `${test}\n${pad(inner)}? ${consequent}\n${pad(inner)}: ${alternate}`
}

const render: Render = (expr, place) => {
	const text = flat(expr)
	if (text !== undefined && fits(text, place)) {
		return text
	}

	const leaf = () => text ?? ""

	return Match.valueTags(expr, {
		Array: (list) => renderArray(list.elements, place.indent, render),
		Arrow: (lambda) => renderArrow(lambda, place, render),
		Boolean: leaf,
		Call: (invocation) => {
			const tail = invocation.args.length === 0 ? place.tail + 2 : 1
			const callee = render(invocation.callee, { ...place, tail })
			const column = endColumn(place.column, callee)

			return `${callee}${renderArgs(invocation.args, { ...place, column }, render)}`
		},
		Conditional: (choice) => renderConditional(choice, place, render),
		DynamicImport: leaf,
		Identifier: leaf,
		Member: (access) => {
			const tail = place.tail + 1 + access.name.length

			return `${render(access.object, { ...place, tail })}.${access.name}`
		},
		New: (construct) => {
			const head = `new ${flat(construct.callee) ?? ""}`
			const column = place.column + textWidth(head)

			return `${head}${renderArgs(construct.args, { ...place, column }, render)}`
		},
		Number: leaf,
		Object: (literal) => renderObject(literal.entries, place.indent, render),
		Plus: (sum) => `${flat(sum.left) ?? ""} +\n${pad(place.indent + 2)}${flat(sum.right) ?? ""}`,
		String: leaf,
		Undefined: leaf
	})
}

type Role = "argument" | "callee" | "value"

type Issue = Option.Option<PrinterError>

const none = (): Issue => Option.none()

const issue = (reason: PrinterError["reason"], subject: string): Issue =>
	Option.some(new PrinterError({ reason, subject }))

const firstIssue = <A>(items: readonly A[], check: (item: A) => Issue): Issue => {
	for (const item of items) {
		const found = check(item)
		if (Option.isSome(found)) {
			return found
		}
	}

	return Option.none()
}

const duplicateKey = (keys: readonly string[]): Issue =>
	Option.flatMap(
		Arr.findFirst(keys, (key, index) => keys.indexOf(key) !== index),
		(duplicate) => issue("duplicate-key", duplicate)
	)

const pathHead = (expr: Expr): string | undefined => {
	if (expr._tag === "Identifier") {
		return expr.name
	}

	return expr._tag === "Member" ? pathHead(expr.object) : undefined
}

/**
 * The root of a callee and its number of call groups.
 */
interface Chain {
	readonly groups: number
	readonly root: Expr
}

/**
 * `Head.member(args)` is one call group, each `.name(args)` after a call adds one, and curried
 * calls stay in their group.
 */
const chainOf = (callee: Expr, groups: number): Chain => {
	if (callee._tag === "Call") {
		return chainOf(callee.callee, groups)
	}

	if (callee._tag === "Member" && callee.object._tag === "Call") {
		return chainOf(callee.object.callee, groups + 1)
	}

	return { groups, root: callee }
}

const capitalized = regex("^[A-Z]", "u")

const checkChain = (callee: Expr): Issue => {
	const { groups, root } = chainOf(callee, 1)
	const head = isPath(root) ? pathHead(root) : undefined
	if (head === undefined || groups > 2 || (groups === 2 && !capitalized.test(head))) {
		return issue("unsupported-chain", flat(callee) ?? "")
	}

	return Option.none()
}

const isLeaf = (expr: Expr): boolean =>
	expr._tag === "String" ||
	expr._tag === "Number" ||
	expr._tag === "Boolean" ||
	expr._tag === "Undefined" ||
	isPath(expr)

const checkObject = (entries: readonly Entry[], check: (expr: Expr) => Issue): Issue =>
	Option.orElse(duplicateKey(Arr.map(entries, ([key]) => key)), () =>
		firstIssue(entries, ([, value]) => check(value))
	)

const check = (expr: Expr, role: Role): Issue => {
	const asValue = (inner: Expr) => check(inner, "value")

	return Match.valueTags(expr, {
		Array: (list) => firstIssue(list.elements, asValue),
		Arrow: (lambda) =>
			lambda.body._tag === "Arrow" ||
			lambda.body._tag === "Conditional" ||
			lambda.body._tag === "Plus"
				? issue("unsupported-arrow-body", lambda.body._tag)
				: asValue(lambda.body),
		Boolean: none,
		Call: (invocation) =>
			checkChain(invocation.callee).pipe(
				Option.orElse(() => check(invocation.callee, "callee")),
				Option.orElse(() => firstIssue(invocation.args, (arg) => check(arg, "argument")))
			),
		Conditional: (choice) => {
			const operands = [choice.test, choice.consequent, choice.alternate]
			const nested = Arr.findFirst(
				operands,
				(operand) => operand._tag === "Conditional" || operand._tag === "Arrow"
			)

			return Option.match(nested, {
				onNone: () => firstIssue(operands, asValue),
				onSome: (operand) => issue("unsupported-conditional", operand._tag)
			})
		},
		DynamicImport: none,
		Identifier: none,
		Member: (access) => {
			if (isPath(access)) {
				return Option.none()
			}

			return role === "callee" && access.object._tag === "Call"
				? asValue(access.object)
				: issue("unsupported-member", access.name)
		},
		New: (construct) =>
			isPath(construct.callee)
				? firstIssue(construct.args, (arg) => check(arg, "argument"))
				: issue("unsupported-new", construct.callee._tag),
		Number: (literal) =>
			Number.isFinite(literal.value)
				? Option.none()
				: issue("non-finite-number", String(literal.value)),
		Object: (literal) => checkObject(literal.entries, asValue),
		Plus: (sum) =>
			role === "argument" && isLeaf(sum.left) && isLeaf(sum.right)
				? Option.orElse(asValue(sum.left), () => asValue(sum.right))
				: issue("unsupported-plus", role),
		String: none,
		Undefined: none
	})
}

const withDoc = (doc: JsDocText | undefined, text: string): string =>
	doc === undefined ? text : `${jsDoc(doc)}\n${text}`

/**
 * A type query, alone or as a readonly array's element: as a type argument, the formatter breaks the argument list
 * around it past column 100, where a reference stays whole (measured with oxfmt).
 */
const holdsQuery = (type: TypeExpr): boolean =>
	type._tag === "TypeQuery" || (type._tag === "TypeReadonlyArray" && holdsQuery(type.element))

/**
 * A line past column 100 is allowed when `vp fmt` keeps it there: its only wide parts are
 * identifiers, which cannot break. A type with several union members or type arguments is one
 * `vp fmt` breaks across lines. The printer breaks a union that is a field's or alias's whole type
 * (see `brokenUnion`); any other such line is refused.
 */
const breaksWhenWide = (type: TypeExpr): boolean =>
	Match.valueTags(type, {
		TypeKeyword: () => false,
		TypeLiteral: () => false,
		TypeQuery: () => false,
		TypeReadonlyArray: (array) => breaksWhenWide(array.element),
		TypeRef: (reference) =>
			reference.args.length > 1 ||
			Arr.some(reference.args, (arg) => holdsQuery(arg) || breaksWhenWide(arg)),
		TypeUnion: (union) =>
			isHuggedUnion(union)
				? Arr.some(union.members, breaksWhenWide)
				: union.members.length > 1 || Arr.some(union.members, breaksWhenWide)
	})

const unbreakable = (line: string, type: TypeExpr | undefined, subject: string): Issue =>
	type !== undefined && breaksWhenWide(type) && textWidth(line) > lineWidth
		? issue("unbreakable-line", subject)
		: Option.none()

/**
 * A declaration's printed text, and the reason it cannot be printed, if any.
 */
interface Layout {
	readonly failure: Issue
	readonly text: string
}

/**
 * The members of a union, nested unions flattened: `typeText` prints a nested union without
 * parentheses, so it parses as part of the outer one.
 */
const unionMembers = (type: TypeExpr): readonly TypeExpr[] =>
	type._tag === "TypeUnion" ? Arr.flatMap(type.members, unionMembers) : [type]

/**
 * A union of one type reference beside `null` alone, once or more and in any order, which the formatter keeps on its
 * line however long it is (measured with oxfmt: `null | a<x>`, `a<x> | null`, `null | null | a<x>`); a keyword,
 * literal or array beside `null`, or a second reference, does not hug.
 */
const isHuggedUnion = (type: TypeExpr): boolean => {
	const members = unionMembers(type)
	const others = Arr.filter(
		members,
		(part) => !(part._tag === "TypeKeyword" && part.keyword === "null")
	)

	return (
		members.length > others.length &&
		others.length === 1 &&
		Arr.every(others, (part) => part._tag === "TypeRef")
	)
}

/**
 * A union that does not fit on its line, as `vp fmt` prints it: `head` ends the line, then each
 * member starts a line one level deeper than `indent` with `| `, and the last member ends with
 * `;`. A member that `vp fmt` would break further is refused.
 */
const brokenUnion = (head: string, type: TypeExpr, indent: number, subject: string): Layout => {
	const members = unionMembers(type)
	const lines = Arr.map(
		members,
		(part, index) =>
			`${pad(indent + 2)}| ${typeText(part)}${index === members.length - 1 ? ";" : ""}`
	)
	const failure = Option.firstSomeOf(
		Arr.zipWith(lines, members, (line, part) => unbreakable(line, part, subject))
	)

	return { failure, text: Arr.join([head, ...lines], "\n") }
}

const isLongUnion = (line: string, type: TypeExpr): boolean =>
	textWidth(line) > lineWidth && unionMembers(type).length > 1 && !isHuggedUnion(type)

const succeedUnless = (failure: Issue, text: () => string): Effect.Effect<string, PrinterError> =>
	Option.match(failure, {
		onNone: () => Effect.succeed(text()),
		onSome: (error) => Effect.fail(error)
	})

/**
 * A constant's value after its head. A head past column 100 moves every value except a
 * non-negative number or boolean onto its own line, which `vp fmt` does whether or not the value
 * is long.
 */
const constBody = (statement: Extract<Statement, { readonly _tag: "Const" }>, head: string) => {
	const { value } = statement
	const asConst = statement.asConst === true
	const tail = asConst ? " as const;" : ";"
	const place = { column: textWidth(head) + 1, indent: 0, tail: tail.length }
	const literal = value._tag === "Number" || value._tag === "Boolean"
	const moves = movesBelow(value, place) || (asConst && literal && !fitsFlat(flat(value), place))

	return moves
		? `${head}\n  ${render(value, { column: 2, indent: 2, tail: tail.length })}${tail}`
		: `${head} ${render(value, place)}${tail}`
}

const printConst = (statement: Extract<Statement, { readonly _tag: "Const" }>) => {
	const type = statement.type === undefined ? "" : `: ${typeText(statement.type)}`
	const head = `${statement.exported ? "export " : ""}const ${statement.name}${type} =`
	const failure = check(statement.value, "value").pipe(
		Option.orElse(() => unbreakable(head, statement.type, statement.name))
	)

	return succeedUnless(failure, () => withDoc(statement.doc, constBody(statement, head)))
}

const byFieldKey = Order.mapInput(Order.String, (field: Field) => field.key)

const fieldLayout = (field: Field, subject: string): Layout => {
	const head = `  readonly ${keyText(field.key)}${field.optional ? "?" : ""}:`
	const line = `${head} ${typeText(field.type)};`

	return isLongUnion(line, field.type)
		? brokenUnion(head, field.type, 2, subject)
		: { failure: unbreakable(line, field.type, subject), text: line }
}

const printInterface = (statement: Extract<Statement, { readonly _tag: "Interface" }>) => {
	const head = `export interface ${statement.name} {`
	const duplicated = duplicateKey(Arr.map(statement.fields, (field) => field.key))
	const layouts = Arr.map(Arr.sort(statement.fields, byFieldKey), (field) =>
		fieldLayout(field, statement.name)
	)
	const wide = Option.firstSomeOf(Arr.map(layouts, (layout) => layout.failure))
	const failure = Option.orElse(duplicated, () => wide)
	const lines = Arr.map(layouts, (layout) => layout.text)
	const text = lines.length === 0 ? `${head}}` : Arr.join([head, ...lines, "}"], "\n")

	return succeedUnless(failure, () => withDoc(statement.doc, text))
}

/**
 * A top-level call, such as `NodeRuntime.runMain(program);`. Other expressions are not statements
 * the generator writes.
 */
const printExpression = (statement: Extract<Statement, { readonly _tag: "Expression" }>) => {
	const { value } = statement
	const failure =
		value._tag === "Call" ? check(value, "value") : issue("unsupported-expression", value._tag)

	return succeedUnless(failure, () => `${render(value, { column: 0, indent: 0, tail: 1 })};`)
}

/**
 * A reference whose one type argument holds a type query (`Read.TypeOf<typeof Pet>`, `holdsQuery`): the reference up
 * to its `<`, and the argument.
 */
const queriedReference = (type: TypeExpr): Option.Option<readonly [string, string]> => {
	if (type._tag !== "TypeRef") {
		return Option.none()
	}

	const [query, ...rest] = type.args

	return query !== undefined && holdsQuery(query) && rest.length === 0
		? Option.some([`${Arr.join([type.head, ...type.members], ".")}<`, typeText(query)] as const)
		: Option.none()
}

/**
 * A type alias of a queried reference past column 100, as the formatter lays it out (measured with oxfmt): its query
 * breaks onto a line of its own inside the `<>` when the head and the reference's `<` fit, and the reference moves
 * below the head otherwise, its query broken the same way when the moved line is wide too.
 */
const queriedAlias = (head: string, open: string, query: string): string => {
	const inPlace = `${head} ${open}`
	const moved = `  ${open}${query}>;`
	if (textWidth(inPlace) <= lineWidth) {
		return `${inPlace}\n  ${query}\n>;`
	}

	return textWidth(moved) <= lineWidth
		? `${head}\n${moved}`
		: `${head}\n  ${open}\n    ${query}\n  >;`
}

/**
 * A type alias: past column 100 a union breaks, a queried reference breaks inside its `<>` (`queriedAlias`), and any
 * other type moves to its own line, as `vp fmt` does, a union the formatter hugs (`isHuggedUnion`) among them: it
 * moves whole, however long its line is then (measured with oxfmt).
 */
const printTypeAlias = (alias: Extract<Statement, { readonly _tag: "TypeAlias" }>) => {
	const head = `export type ${alias.name} =`
	const line = `${head} ${typeText(alias.type)};`
	const moved = `${head}\n  ${typeText(alias.type)};`
	const wide = textWidth(line) > lineWidth
	const layout: Layout = isLongUnion(line, alias.type)
		? brokenUnion(head, alias.type, 0, alias.name)
		: Option.match(
				Option.filter(queriedReference(alias.type), () => wide),
				{
					onNone: () => ({
						failure: unbreakable(line, alias.type, alias.name),
						text: wide ? moved : line
					}),
					onSome: ([open, query]) => ({
						failure: Option.none(),
						text: queriedAlias(head, open, query)
					})
				}
			)

	return succeedUnless(layout.failure, () => withDoc(alias.doc, layout.text))
}

const printStatement = (statement: Statement): Effect.Effect<string, PrinterError> =>
	Match.valueTags(statement, {
		Const: printConst,
		Expression: printExpression,
		Interface: printInterface,
		TypeAlias: printTypeAlias
	})

const importOrder = Order.combineAll([
	Order.mapInput(Order.Boolean, (entry: Import) => Str.startsWith(".")(entry.from)),
	Order.mapInput(Order.String, (entry: Import) => entry.from),
	Order.mapInput(Order.Boolean, (entry: Import) => !entry.typeOnly),
	Order.mapInput(Order.Boolean, (entry: Import) => entry._tag === "Named"),
	Order.mapInput(Order.String, (entry: Import) => (entry._tag === "Namespace" ? entry.name : ""))
])

const importKey = (entry: Import): string =>
	Arr.join(
		[entry._tag, String(entry.typeOnly), entry.from, entry._tag === "Namespace" ? entry.name : ""],
		":"
	)

/**
 * One statement per specifier and kind: named imports of one kind from one specifier merge.
 */
const mergeImports = (imports: readonly Import[]): readonly Import[] => {
	const merged = new Map<string, Import>()
	for (const entry of imports) {
		const previous = merged.get(importKey(entry))
		const earlier = previous?._tag === "Named" ? previous.names : []
		const next = entry._tag === "Named" ? { ...entry, names: [...earlier, ...entry.names] } : entry
		merged.set(importKey(entry), next)
	}

	return Arr.sort([...merged.values()], importOrder)
}

const importLine = (entry: Import): string => {
	const kind = entry.typeOnly ? "type " : ""
	const from = stringLiteral(entry.from)
	if (entry._tag === "Namespace") {
		return `import ${kind}* as ${entry.name} from ${from};`
	}

	const names = Arr.sort(Arr.dedupe(entry.names), Order.String)
	const line = `import ${kind}{ ${Arr.join(names, ", ")} } from ${from};`
	if (textWidth(line) <= lineWidth || names.length < 2) {
		return line
	}

	return Arr.join(
		[`import ${kind}{`, ...Arr.map(names, (name) => `  ${name},`), `} from ${from};`],
		"\n"
	)
}

/**
 * Prints a module in the `docs/printer.md` layout, after its shebang line when it has one. Fails
 * with a `PrinterError` when the module holds a construct outside the printer's syntax subset.
 */
export const printModule = (module: Module): Effect.Effect<string, PrinterError> =>
	Effect.map(Effect.forEach(module.statements, printStatement), (printed) => {
		const statements = Arr.map(printed, guardTemplateCurly)
		const imports = Arr.map(mergeImports(module.imports), importLine)
		const blocks = [
			...(module.shebang === undefined ? [] : [`#!${module.shebang}`]),
			...(imports.length === 0 ? [] : [Arr.join(imports, "\n")]),
			...statements
		]

		return blocks.length === 0 ? "" : `${Arr.join(blocks, "\n\n")}\n`
	})

const isJsonArray = (value: Json): value is readonly Json[] => Arr.isArray(value)

const isJsonScalar = (value: Json): value is boolean | number | string | null =>
	value === null ||
	Predicate.isBoolean(value) ||
	Predicate.isNumber(value) ||
	Predicate.isString(value)

const isNonEmptyJsonObject = (value: Json): boolean =>
	!isJsonScalar(value) && !isJsonArray(value) && !Record.isEmptyReadonlyRecord(value)

const isLongJsonArray = (value: Json): boolean => isJsonArray(value) && value.length > 1

/**
 * An array holding a non-empty object, or two or more arrays that each hold more than one element.
 */
const jsonAlwaysBroken = (values: readonly Json[]): boolean =>
	Arr.some(values, (value) => isNonEmptyJsonObject(value)) ||
	(values.length > 1 && Arr.every(values, (value) => isLongJsonArray(value)))

/**
 * A JSON scalar as the formatter prints it: its JSON text, a number with no `+` in its exponent (measured: oxfmt
 * writes `1e+21` as `1e21`).
 */
const jsonScalarText = (value: boolean | number | string | null): string =>
	Predicate.isNumber(value) ? numberText(value) : jsonText(value)

const jsonFlat = (value: Json): string | undefined => {
	if (isJsonScalar(value)) {
		return jsonScalarText(value)
	}

	if (isJsonArray(value)) {
		return jsonAlwaysBroken(value)
			? undefined
			: flatList(
					Arr.map(value, (item) => jsonFlat(item)),
					"[",
					"]"
				)
	}

	return Record.isEmptyReadonlyRecord(value) ? "{}" : undefined
}

type RenderJson = (value: Json, place: Place) => string

const jsonArrayLines = (
	values: readonly Json[],
	indent: number,
	renderItem: RenderJson
): readonly string[] => {
	const lastIndex = values.length - 1
	const comma = (index: number) => (index === lastIndex ? "" : ",")
	if (values.length > 1 && Arr.every(values, Predicate.isNumber)) {
		return fillLines(
			Arr.map(values, (item, index) => `${numberText(item)}${comma(index)}`),
			indent
		)
	}

	return Arr.map(values, (item, index) => {
		const at = { column: indent, indent, tail: comma(index).length }

		return `${pad(indent)}${renderItem(item, at)}${comma(index)}`
	})
}

const byJsonKey = Order.mapInput(Order.String, (entry: readonly [string, Json]) => entry[0])

const jsonObjectLines = (
	value: Record.ReadonlyRecord<string, Json>,
	indent: number,
	renderItem: RenderJson
): readonly string[] => {
	const entries = Arr.sort(Record.toEntries(value), byJsonKey)
	const lastIndex = entries.length - 1

	return Arr.map(entries, ([key, item], index) => {
		const label = `${jsonText(key)}: `
		const comma = index === lastIndex ? "" : ","
		const at = { column: indent + textWidth(label), indent, tail: comma.length }

		return `${pad(indent)}${label}${renderItem(item, at)}${comma}`
	})
}

/**
 * A JSON value laid out from `place`: a scalar, `[]` and `{}` as their text, which cannot break;
 * any other array or object flat when it fits, else broken.
 */
const renderJson: RenderJson = (value, place) => {
	if (isJsonScalar(value)) {
		return jsonScalarText(value)
	}

	const text = jsonFlat(value)
	if (text !== undefined && (text.length === 2 || fits(text, place))) {
		return text
	}

	const inner = place.indent + 2

	return isJsonArray(value)
		? block("[", jsonArrayLines(value, inner, renderJson), place.indent, "]")
		: block("{", jsonObjectLines(value, inner, renderJson), place.indent, "}")
}

/**
 * Prints a JSON file in the `docs/printer.md` JSON layout: objects broken with sorted keys, arrays
 * flat when they fit, a final newline.
 */
export const printJson = (value: Json): string =>
	`${renderJson(value, { column: 0, indent: 0, tail: 0 })}\n`

const packageKeys: readonly string[] = [
	"name",
	"version",
	"private",
	"description",
	"license",
	"bin",
	"files",
	"type",
	"imports",
	"exports",
	"scripts",
	"dependencies",
	"devDependencies",
	"engines",
	"packageManager"
]

const knownPackageKeys: ReadonlySet<string> = new Set(packageKeys)

/**
 * The maps the formatter sorts by key inside `package.json` (measured): the dependency maps, `bin` and `engines`.
 */
const sortedKeys: ReadonlySet<string> = new Set([
	"bin",
	"dependencies",
	"devDependencies",
	"engines"
])

const sortedMap = (value: Json): Json =>
	isJsonScalar(value) || isJsonArray(value)
		? value
		: Record.fromEntries(Arr.sort(Record.toEntries(value), byJsonKey))

const unsupportedPackageJson = (subject: string) =>
	Effect.fail(new PrinterError({ reason: "unsupported-package-json", subject }))

/**
 * The manifest's members in the `docs/printer.md` key order, its dependency maps, `bin` and `engines`
 * sorted by key.
 */
const orderedManifest = (
	manifest: Record.ReadonlyRecord<string, Json>
): Record.ReadonlyRecord<string, Json> =>
	Record.fromEntries(
		Arr.flatMap(packageKeys, (key) =>
			Option.match(Record.get<string, Json>(manifest, key), {
				onNone: () => [],
				onSome: (value) => [[key, sortedKeys.has(key) ? sortedMap(value) : value] as const]
			})
		)
	)

/**
 * Prints `package.json` in the layout the formatter keeps for it: `JSON.stringify(value, null, 2)`
 * plus a final newline, top-level keys in the `docs/printer.md` order, the dependency maps, `bin`
 * and `engines` sorted by key. Fails on a top-level key outside that order.
 */
export const printPackageJson = (manifest: Json): Effect.Effect<string, PrinterError> => {
	if (isJsonScalar(manifest) || isJsonArray(manifest)) {
		return unsupportedPackageJson("root")
	}

	return Option.match(
		Arr.findFirst(Record.keys<string, Json>(manifest), (key) => !knownPackageKeys.has(key)),
		{
			onNone: () =>
				Effect.succeed(`${Formatter.formatJson(orderedManifest(manifest), { space: 2 })}\n`),
			onSome: unsupportedPackageJson
		}
	)
}
