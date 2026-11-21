/** What the properties of printer.test.ts read: its spaces, models and helpers. */

import type { Json } from "@bjornpagen/grizzle-text/utf8"
import { assert } from "@bjornpagen/testing/assert"
import {
	type Aimed,
	aimed,
	array,
	boolean,
	characterOf,
	element,
	type Gen,
	int,
	map,
	oneOf,
	option,
	shuffled,
	string,
	subarray,
	uniqueArray,
	weighted,
	type Weighted
} from "@bjornpagen/testing/gen"
import { syntaxDiagnosticsOf } from "@bjornpagen/testing/syntax"
import { regex } from "arkregex"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	Match,
	Option,
	Order,
	Record,
	Result,
	String as Str
} from "effect"
import { format } from "oxfmt"
import type { FormatConfig } from "oxfmt"
import {
	type Expression,
	formatSyntaxKind,
	getTextOfJSDocComment,
	type ImportDeclaration,
	isArrayLiteralExpression,
	isArrayTypeNode,
	isArrowFunction,
	isAsExpression,
	isBinaryExpression,
	isBlock,
	isCallExpression,
	isComputedPropertyName,
	isConditionalExpression,
	isExpressionStatement,
	isIdentifier,
	isImportDeclaration,
	isInterfaceDeclaration,
	isJSDoc,
	isLiteralTypeNode,
	isNamedImports,
	isNamespaceImport,
	isNewExpression,
	isNumericLiteral,
	isObjectLiteralExpression,
	isParameterDeclaration,
	isParenthesizedExpression,
	isParenthesizedTypeNode,
	isPrefixUnaryExpression,
	isPropertyAccessExpression,
	isPropertyAssignment,
	isPropertySignatureDeclaration,
	isQualifiedName,
	isStringLiteral,
	isTypeAliasDeclaration,
	isTypeOperatorNode,
	isTypeReferenceNode,
	isTypeQueryNode,
	isUnionTypeNode,
	isVariableStatement,
	type Node,
	type PropertyName,
	type SourceFile,
	SyntaxKind,
	type Statement as TsStatement,
	type TypeNode
} from "typescript/ast"
import { identifierPattern, isJsDocText, lineWidth } from "#emit/escape.ts"
import type { JsDocText } from "#emit/escape.ts"
import {
	arr,
	arrow,
	bool,
	call,
	conditional,
	dynamicImport,
	fixedIdentifier,
	fixedMemberName,
	fixedModuleSpecifier,
	fixedShebang,
	ident,
	member,
	newExpr,
	num,
	obj,
	plus,
	PrinterError,
	regExp,
	str,
	textWidth,
	typeApply,
	typedArrow,
	typeKeyword,
	typeLiteral,
	typeName,
	typeQuery,
	typeReadonlyArray,
	typeRef,
	typeUnion,
	undef
} from "#emit/printer.ts"
import type {
	Expr,
	Field,
	Identifier,
	Import,
	MemberName,
	Module,
	Param,
	Statement,
	TypeExpr
} from "#emit/printer.ts"

type Keyword = Extract<TypeExpr, { readonly _tag: "TypeKeyword" }>["keyword"]

type ConstStatement = Extract<Statement, { readonly _tag: "Const" }>

type Entry = readonly [string, Expr]

/**
 * The formatter's options for generated TypeScript and JSON: oxfmt's defaults (two-space indent, semicolons, double
 * quotes, trailing commas, width 100) and the JSDoc pass docs/printer.md names.
 */
const FORMAT_OPTIONS: FormatConfig = {
	jsdoc: { commentLineStrategy: "multiline", lineWrappingStyle: "balance" }
}

/** Identifiers of the lengths the generator's own modules use. */
const SHORT_NAMES: Arr.NonEmptyReadonlyArray<string> = [
	"a",
	"b",
	"x1",
	"_tmp",
	"$ref",
	"flags",
	"input",
	"Effect",
	"Flag",
	"Serialize"
]

/** The namespace heads a member chain may start from. */
const CAPITALIZED: Arr.NonEmptyReadonlyArray<string> = [
	"Effect",
	"Flag",
	"Command",
	"Serialize",
	"HttpClientRequest"
]

/** Names after `.`, reserved words among them. */
const MEMBER_NAMES: Arr.NonEmptyReadonlyArray<string> = [
	"pipe",
	"make",
	"of",
	"default",
	"class",
	"withDescription",
	"optional",
	"new"
]

/** A name whose length straddles the line: a stem and from two to sixteen repeats of a segment, 19 to 121 columns. */
const longName: Gen<string> = (s) =>
	`${s.draw(element(["users", "list", "operation"]))}${Str.repeat(s.draw(int(2, 16)))("Segment")}`

/** A name of at least 100 columns, which no line holding more than it fits. */
const overlongName: Gen<string> = (s) => `operation${Str.repeat(s.draw(int(14, 16)))("Segment")}`

const shortName: Gen<Identifier> = map(element(SHORT_NAMES), fixedIdentifier)

const anyName: Gen<Identifier> = weighted([
	[4, shortName],
	[1, map(longName, fixedIdentifier)]
])

const capitalized: Gen<Identifier> = map(element(CAPITALIZED), fixedIdentifier)

const shortMemberName: Gen<MemberName> = map(element(MEMBER_NAMES), fixedMemberName)

const memberName: Gen<MemberName> = weighted([
	[5, shortMemberName],
	[1, map(longName, fixedMemberName)]
])

/** A path: an identifier and up to `most` member names after it, each drawn from `names`. */
const pathOf =
	(head: Gen<Identifier>, most: number, names: Gen<MemberName>): Gen<Expr> =>
	(s) =>
		Arr.reduce(s.draw(array(names, { min: 0, max: most })), ident(s.draw(head)), (object, name) =>
			member(object, name)
		)

/** A value path: an identifier and at most one member, each of any length, as the subset admits. */
const valuePath: Gen<Expr> = (s) => s.draw(pathOf(anyName, 1, memberName))

/** A callee path: a value path, or up to three short names, as `Stdio.Stdio.use` is. */
const calleePath: Gen<Expr> = oneOf([valuePath, pathOf(shortName, 2, shortMemberName)])

/** Object keys and field keys: identifier-shaped, reserved, numeric, quoted, `__proto__`, non-ASCII and empty. */
const KEYS: Arr.NonEmptyReadonlyArray<string> = [
	"a",
	"b",
	"A",
	"_b",
	"default",
	"class",
	"constructor",
	"200",
	"404",
	"10",
	"9",
	"a-b",
	"a1",
	"address.city",
	"__proto__",
	"café",
	"中文",
	"",
	"it's",
	'say "hi"',
	"line\nbreak",
	"\u200e",
	"$",
	"a b",
	"😀"
]

const keyGen: Gen<string> = weighted([
	[6, element(KEYS)],
	[1, longName]
])

/** Characters a string draws from: plain, quotes, backslash, controls, format characters, separators, lone
 * surrogates, wide, combining and the template placeholder's punctuation. */
const CHARS: Arr.NonEmptyReadonlyArray<string> = [
	"a",
	"Z",
	" ",
	"'",
	'"',
	"\\",
	"\n",
	"\t",
	"\u0000",
	"\u0007",
	"\u007f",
	" ",
	"\u200e",
	"\u202e",
	"\u2028",
	"\u2029",
	"\ud800",
	"\udc00",
	"é",
	"中",
	"😀",
	"\u0301",
	"$",
	"{",
	"}"
]

const stringValue: Gen<string> = weighted([
	[6, string(characterOf(CHARS), { min: 0, max: 10 })],
	[2, (s) => Str.repeat(s.draw(int(5, 50)))(s.draw(element(["ab", "中", "x y", "e\u0301"])))],
	[1, (s) => `\${${s.draw(element(["name", "a.b", ""]))}}`]
])

/** Finite numbers by construction: whole, fractional, and past the formatter's exponent switch either way. */
const numberValue: Gen<number> = oneOf([
	int(-1000, 1000),
	(s) => s.draw(int(-9999, 9999)) / 8,
	(s) => s.draw(int(1, 9)) * 10 ** s.draw(int(15, 25)),
	(s) => -s.draw(int(1, 9)) * 10 ** s.draw(int(15, 25)),
	(s) => s.draw(int(1, 9)) / 10 ** s.draw(int(5, 9))
])

const KEYWORDS: Arr.NonEmptyReadonlyArray<Keyword> = [
	"boolean",
	"never",
	"null",
	"number",
	"string",
	"undefined",
	"unknown"
]

const keywordType: Gen<TypeExpr> = map(element(KEYWORDS), typeKeyword)

const literalType: Gen<TypeExpr> = oneOf([
	map(boolean, typeLiteral),
	map(int(-99, 999), typeLiteral),
	map(element(["a", "x-y", "it's", "é"]), typeLiteral)
])

/** A type no wider than ten columns that never breaks. */
const simpleType: Gen<TypeExpr> = oneOf([keywordType, literalType, map(shortName, typeName)])

/** A type that never breaks however wide: no union and at most one type argument at any depth. */
const narrowType = (depth: number): Gen<TypeExpr> => {
	const leaf: Gen<TypeExpr> = oneOf([
		keywordType,
		literalType,
		(s) => typeRef(s.draw(anyName), s.draw(array(memberName, { min: 0, max: 2 })))
	])
	return depth === 0
		? leaf
		: weighted([
				[3, leaf],
				[
					1,
					(s) =>
						typeApply(s.draw(anyName), s.draw(array(memberName, { min: 0, max: 1 })), [
							s.draw(narrowType(depth - 1))
						])
				],
				[1, map(narrowType(depth - 1), typeReadonlyArray)]
			])
}

/**
 * `typeof name`, a type query, which the formatter keeps whole on its line however wide, alone or as the element of a
 * readonly array, where it is parenthesized.
 */
const queryType: Gen<TypeExpr> = weighted([
	[3, map(anyName, typeQuery)],
	[1, (s) => typeReadonlyArray(typeQuery(s.draw(anyName)))]
])

/**
 * A reference whose one argument is a type query (`Read.TypeOf<typeof Pet>`), which the formatter breaks inside its
 * `<>` past column 100: the domain module's alias of each reader's type.
 */
const queriedType: Gen<TypeExpr> = (s) =>
	typeApply(s.draw(anyName), s.draw(array(memberName, { min: 0, max: 1 })), [s.draw(queryType)])

/** A type the formatter would break if it were long, kept under forty columns so it never is. */
const smallWideType: Gen<TypeExpr> = oneOf([
	(s) => typeUnion(s.draw(array(simpleType, { min: 2, max: 3 }))),
	(s) => typeApply(s.draw(shortName), [], s.draw(array(simpleType, { min: 2, max: 2 }))),
	(s) => typeReadonlyArray(typeUnion(s.draw(array(simpleType, { min: 2, max: 2 })))),
	(s) => typeUnion([typeUnion(s.draw(array(simpleType, { min: 2, max: 2 }))), s.draw(simpleType)])
])

/**
 * A constant's annotation, as the emitters write them: a keyword, a literal, a type named by a path or a type query,
 * never generic.
 */
const annotationType: Gen<TypeExpr> = oneOf([
	keywordType,
	literalType,
	(s) => typeRef(s.draw(anyName), s.draw(array(memberName, { min: 0, max: 1 }))),
	queryType
])

/** A union of members that never break, as long as its members make it. */
const longUnion: Gen<TypeExpr> = (s) => typeUnion(s.draw(array(narrowType(1), { min: 2, max: 6 })))

/** A JSDoc word: printable ASCII outside the alphabet docs/printer.md excludes, never starting a list item. */
const DOC_WORDS: Arr.NonEmptyReadonlyArray<string> = [
	"builder",
	"of",
	"one",
	"request,",
	"its",
	"flags",
	"(and",
	"more).",
	"value:",
	"x/y",
	"is",
	"what=it",
	"says!",
	"path's",
	"Effect"
]

const docText: Gen<JsDocText> = (s) => {
	const text = Arr.join(
		[
			s.draw(element(["The", "A", "Builds", "Each"])),
			...s.draw(
				array(
					weighted([
						[12, element(DOC_WORDS)],
						[1, (t) => Str.repeat(t.draw(int(1, 4)))("Supercalifragilistic")]
					]),
					{ min: 0, max: 40 }
				)
			)
		],
		" "
	)
	assert.ok(isJsDocText(text), "every word the doc text draws is JSDoc text's")
	return text
}

const SPECIFIERS: Arr.NonEmptyReadonlyArray<string> = [
	"effect",
	"effect/unstable/cli",
	"@effect/platform-node",
	"arkregex",
	"./runtime/serialize.ts",
	"./a.ts",
	"../domain/schemas.ts",
	"../b.ts"
]

const specifier = map(element(SPECIFIERS), (from) => fixedModuleSpecifier(from))

const importGen: Gen<Import> = oneOf<Import>([
	(s) => ({
		_tag: "Named",
		typeOnly: s.draw(boolean),
		names: s.draw(array(anyName, { min: 1, max: 5 })),
		from: s.draw(specifier)
	}),
	(s) => ({
		_tag: "Namespace",
		typeOnly: s.draw(boolean),
		name: s.draw(anyName),
		from: s.draw(specifier)
	})
])

/** Where an expression sits, which decides the forms the subset allows there. */
type Slot = "value" | "argument" | "body" | "operand"

const leafGen: Gen<Expr> = weighted([
	[3, map(stringValue, str)],
	[2, map(numberValue, num)],
	[1, map(boolean, bool)],
	[1, () => undef],
	[3, valuePath],
	[1, map(specifier, dynamicImport)]
])

/** A leaf `+` takes: a literal or a path. */
const plusOperand: Gen<Expr> = weighted([
	[3, map(stringValue, str)],
	[1, map(numberValue, num)],
	[2, valuePath]
])

const plusGen: Gen<Expr> = (s) => plus(s.draw(plusOperand), s.draw(plusOperand))

const argsGen = (depth: number): Gen<ReadonlyArray<Expr>> =>
	array(exprGen(depth, "argument"), { min: 0, max: 4 })

/** The head of a two-group chain, `Head.member`: a namespace and a member name of the lengths the chain rule covers. */
const chainHead: Gen<Expr> = (s) => member(ident(s.draw(capitalized)), s.draw(shortMemberName))

/** The argument of a curried call's first group, as `HttpClientRequest.make("PATCH")` takes: a short string or name. */
const curriedArgument: Gen<Expr> = oneOf([
	map(element(["PATCH", "GET", "x-y"]), str),
	map(shortName, ident)
])

/**
 * The first call group's arguments of a two-group chain, as the emitters write them: one string literal
 * (`Flag.String("name")`), one object literal (`Input.mergeBody({ ... })`), or two or more arguments.
 */
const chainArgs = (depth: number): Gen<ReadonlyArray<Expr>> =>
	oneOf<ReadonlyArray<Expr>>([
		(s) => [str(s.draw(element(["name", "address.city", "if-match"])))],
		(s) => [
			obj(
				s.draw(
					uniqueArray(
						keyGen,
						(key) => map(exprGen(Math.max(0, depth - 1), "value"), (value): Entry => [key, value]),
						{ min: 1, max: 4 }
					)
				)
			)
		],
		array(exprGen(depth, "argument"), { min: 2, max: 3 })
	])

/** A callee inside the chain rule: a path, a curried call of one, or `Head.member(args)` before one more group. */
const calleeGen = (depth: number): Gen<Expr> =>
	weighted([
		[4, calleePath],
		[1, (s) => call(s.draw(calleePath), s.draw(array(curriedArgument, { min: 0, max: 1 })))],
		[2, (s) => member(call(s.draw(chainHead), s.draw(chainArgs(depth))), s.draw(shortMemberName))]
	])

const callGen =
	(depth: number): Gen<Expr> =>
	(s) =>
		call(s.draw(calleeGen(depth - 1)), s.draw(argsGen(depth - 1)))

const objectGen = (depth: number): Gen<Expr> =>
	map(
		uniqueArray(keyGen, (key) => map(exprGen(depth - 1, "value"), (value): Entry => [key, value]), {
			min: 0,
			max: 5
		}),
		obj
	)

const arrayGen = (depth: number): Gen<Expr> =>
	weighted([
		[4, map(array(exprGen(depth - 1, "value"), { min: 0, max: 5 }), arr)],
		[1, map(array(map(numberValue, num), { min: 2, max: 40 }), arr)]
	])

/** An arrow's parameter, typed by a type that never breaks, as the subset requires of arrow heads. */
const paramGen =
	(name: Identifier): Gen<Param> =>
	(s) =>
		Option.match(s.draw(option(narrowType(1))), {
			onNone: (): Param => ({ name }),
			onSome: (type): Param => ({ name, type })
		})

const arrowGen =
	(depth: number): Gen<Expr> =>
	(s) => {
		const params = s.draw(uniqueArray(shortName, paramGen, { min: 0, max: 3 }))
		const body = s.draw(exprGen(depth - 1, "body"))
		return Option.match(s.draw(option(narrowType(1))), {
			onNone: () => arrow(params, body),
			onSome: (returns) => typedArrow(params, body, returns)
		})
	}

const newGen = (depth: number): Gen<Expr> =>
	weighted([
		[3, (s) => newExpr(s.draw(calleePath), s.draw(argsGen(depth - 1)))],
		[1, map(stringValue, regExp)]
	])

const conditionalGen =
	(depth: number): Gen<Expr> =>
	(s) =>
		conditional(
			s.draw(exprGen(depth - 1, "operand")),
			s.draw(exprGen(depth - 1, "operand")),
			s.draw(exprGen(depth - 1, "operand"))
		)

/** An expression inside the subset for its slot, at most `depth` levels deep. */
const exprGen = (depth: number, slot: Slot): Gen<Expr> => {
	const plusArm: ReadonlyArray<Weighted<Expr>> = slot === "argument" ? [[1, plusGen]] : []
	if (depth === 0) {
		return weighted([[5, leafGen], ...plusArm])
	}
	const free: ReadonlyArray<Weighted<Expr>> =
		slot === "value" || slot === "argument"
			? [
					[1, arrowGen(depth)],
					[1, conditionalGen(depth)]
				]
			: []
	return weighted([
		[4, leafGen],
		[2, objectGen(depth)],
		[1, arrayGen(depth)],
		[2, callGen(depth)],
		[1, newGen(depth)],
		...free,
		...plusArm
	])
}

/** A literal value `as const` may follow. */
const constantValue = (depth: number): Gen<Expr> =>
	oneOf([
		map(stringValue, str),
		map(numberValue, num),
		map(boolean, bool),
		objectGen(depth),
		arrayGen(depth)
	])

/** Present fields of a statement, absent ones left out rather than undefined. */
const present = <K extends string, A>(key: K, value: Option.Option<A>) =>
	Option.match(value, {
		onNone: () => ({}),
		onSome: (inner) => Record.singleton(key, inner)
	})

const constGen: Gen<Statement> = (s) => {
	const short = s.draw(boolean)
	const name = short ? s.draw(shortName) : fixedIdentifier(s.draw(longName))
	const type = s.draw(option(annotationType))
	const literal = s.draw(boolean)
	const value = s.draw(literal ? constantValue(2) : exprGen(3, "value"))
	const statement: ConstStatement = {
		_tag: "Const",
		exported: s.draw(boolean),
		name,
		value,
		...present("type", type),
		...present("doc", s.draw(option(docText))),
		...(literal && s.draw(boolean) ? { asConst: true } : {})
	}
	return statement
}

const fieldGen =
	(key: string): Gen<Field> =>
	(s) => ({
		key,
		optional: s.draw(boolean),
		type: s.draw(
			textWidth(key) <= 14
				? oneOf([narrowType(1), smallWideType, longUnion, queryType])
				: oneOf([narrowType(1), longUnion, queryType])
		)
	})

const interfaceGen: Gen<Statement> = (s) => ({
	_tag: "Interface",
	name: s.draw(anyName),
	fields: s.draw(uniqueArray(keyGen, fieldGen, { min: 0, max: 5 })),
	...present("doc", s.draw(option(docText)))
})

const typeAliasGen: Gen<Statement> = (s) => {
	const short = s.draw(boolean)
	return {
		_tag: "TypeAlias",
		name: short ? s.draw(shortName) : fixedIdentifier(s.draw(longName)),
		type: s.draw(
			short
				? oneOf([narrowType(1), smallWideType, longUnion, queryType, queriedType])
				: oneOf([narrowType(1), longUnion, queryType, queriedType])
		),
		...present("doc", s.draw(option(docText)))
	}
}

const expressionGen: Gen<Statement> = (s) => ({ _tag: "Expression", value: s.draw(callGen(3)) })

const statementGen: Gen<Statement> = weighted([
	[4, constGen],
	[2, interfaceGen],
	[2, typeAliasGen],
	[1, expressionGen]
])

const SHEBANGS: Arr.NonEmptyReadonlyArray<string> = [
	"/usr/bin/env node",
	"/usr/bin/env -S node --enable-source-maps",
	"/bin/sh"
]

const moduleGen: Gen<Module> = (s) => ({
	imports: s.draw(array(importGen, { min: 0, max: 6 })),
	statements: s.draw(array(statementGen, { min: 0, max: 5 })),
	...present("shebang", s.draw(option(map(element(SHEBANGS), (line) => fixedShebang(line)))))
})

/**
 * A drawn module with one more const, whose value is an array of two to four objects of two or more entries each:
 * an array the printer always breaks, which the module generator draws about once in hundreds of modules.
 */
const brokenArrayModule: Gen<Module> = (s) => {
	const base = s.draw(moduleGen)
	const entry = (key: string): Gen<Entry> => map(leafGen, (value): Entry => [key, value])
	const objects = s.draw(
		array(map(uniqueArray(keyGen, entry, { min: 2, max: 4 }), obj), { min: 2, max: 4 })
	)
	const statement: ConstStatement = {
		_tag: "Const",
		exported: s.draw(boolean),
		name: s.draw(shortName),
		value: arr(objects)
	}
	return { ...base, statements: [...base.statements, statement] }
}

/** Modules, aimed at an array always broken while it is pending. */
export const moduleSpace: Aimed<Module, Feature> = aimed(moduleGen, [
	["an array always broken", brokenArrayModule]
])

/** What reading a parsed module gives, or where it met a node the printer never prints. */
type Read<A> = Result.Result<A, string>

const unread = (what: string, node: Node): Read<never> =>
	Result.fail(`${what}: ${formatSyntaxKind(node.kind)} at ${node.pos}`)

const readAll = <N, A>(
	nodes: ReadonlyArray<N>,
	read: (node: N) => Read<A>
): Read<ReadonlyArray<A>> => Result.all(Arr.map(nodes, read))

/** The members of a union, nested unions flattened, as the printer prints them. */
const unionMembers = (type: TypeExpr): ReadonlyArray<TypeExpr> =>
	type._tag === "TypeUnion" ? Arr.flatMap(type.members, unionMembers) : [type]

const KEYWORD_KINDS: ReadonlyArray<readonly [SyntaxKind, Keyword]> = [
	[SyntaxKind.BooleanKeyword, "boolean"],
	[SyntaxKind.NeverKeyword, "never"],
	[SyntaxKind.NumberKeyword, "number"],
	[SyntaxKind.StringKeyword, "string"],
	[SyntaxKind.UndefinedKeyword, "undefined"],
	[SyntaxKind.UnknownKeyword, "unknown"]
]

const negated = (node: Node): Option.Option<number> =>
	isPrefixUnaryExpression(node) &&
	node.operator === SyntaxKind.MinusToken &&
	isNumericLiteral(node.operand)
		? Option.some(-Number(node.operand.text))
		: Option.none()

const readEntity = (node: Node): Read<Arr.NonEmptyReadonlyArray<string>> => {
	if (isIdentifier(node)) {
		return Result.succeed([node.text])
	}
	return isQualifiedName(node)
		? Result.map(readEntity(node.left), (left) => Arr.append(left, node.right.text))
		: unread("entity name", node)
}

const readLiteralType = (node: Node): Read<TypeExpr> => {
	if (isStringLiteral(node)) {
		return Result.succeed(typeLiteral(node.text))
	}
	if (isNumericLiteral(node)) {
		return Result.succeed(typeLiteral(Number(node.text)))
	}
	if (node.kind === SyntaxKind.TrueKeyword || node.kind === SyntaxKind.FalseKeyword) {
		return Result.succeed(typeLiteral(node.kind === SyntaxKind.TrueKeyword))
	}
	if (node.kind === SyntaxKind.NullKeyword) {
		return Result.succeed(typeKeyword("null"))
	}
	return Option.match(negated(node), {
		onNone: () => unread("literal type", node),
		onSome: (value) => Result.succeed(typeLiteral(value))
	})
}

const readType = (node: TypeNode): Read<TypeExpr> => {
	const keyword = Arr.findFirst(KEYWORD_KINDS, ([kind]) => kind === node.kind)
	if (Option.isSome(keyword)) {
		return Result.succeed(typeKeyword(keyword.value[1]))
	}
	if (isTypeReferenceNode(node)) {
		return Result.gen(function* () {
			const [head, ...members] = yield* readEntity(node.typeName)
			const args = yield* readAll(node.typeArguments ?? [], readType)
			return typeApply(fixedIdentifier(head), Arr.map(members, fixedMemberName), args)
		})
	}
	if (isLiteralTypeNode(node)) {
		return readLiteralType(node.literal)
	}
	if (isTypeQueryNode(node) && isIdentifier(node.exprName) && node.typeArguments === undefined) {
		return Result.succeed(typeQuery(fixedIdentifier(node.exprName.text)))
	}
	if (
		isTypeOperatorNode(node) &&
		node.operator === SyntaxKind.ReadonlyKeyword &&
		isArrayTypeNode(node.type)
	) {
		const itemType = node.type.elementType
		return Result.map(
			isParenthesizedTypeNode(itemType) &&
				(isUnionTypeNode(itemType.type) || isTypeQueryNode(itemType.type))
				? readType(itemType.type)
				: readType(itemType),
			typeReadonlyArray
		)
	}
	return isUnionTypeNode(node)
		? Result.map(readAll(node.types, readType), (members) =>
				typeUnion(Arr.flatMap(members, unionMembers))
			)
		: unread("type", node)
}

/** A key as the printer writes it: bare when identifier-shaped, quoted otherwise, `__proto__` computed. */
const readKey = (name: PropertyName): Read<string> => {
	if (isIdentifier(name)) {
		return name.text === "__proto__"
			? unread("a bare __proto__ key", name)
			: Result.succeed(name.text)
	}
	if (isStringLiteral(name)) {
		return name.text === "__proto__" || identifierPattern.test(name.text)
			? unread("a quoted key that prints bare or computed", name)
			: Result.succeed(name.text)
	}
	return isComputedPropertyName(name) &&
		isStringLiteral(name.expression) &&
		name.expression.text === "__proto__"
		? Result.succeed("__proto__")
		: unread("key", name)
}

const readParam = (node: Node): Read<Param> => {
	if (!(isParameterDeclaration(node) && isIdentifier(node.name))) {
		return unread("parameter", node)
	}
	const name = fixedIdentifier(node.name.text)
	return node.type === undefined
		? Result.succeed({ name })
		: Result.map(readType(node.type), (type): Param => ({ name, type }))
}

const readCall = (node: Expression): Read<Expr> => {
	if (!isCallExpression(node)) {
		return unread("call", node)
	}
	const [only] = node.arguments
	if (node.expression.kind === SyntaxKind.ImportKeyword) {
		return only !== undefined && node.arguments.length === 1 && isStringLiteral(only)
			? Result.succeed(dynamicImport(fixedModuleSpecifier(only.text)))
			: unread("dynamic import", node)
	}
	return Result.gen(function* () {
		const callee = yield* readExpr(node.expression)
		const args = yield* readAll(node.arguments, readExpr)
		return call(callee, args)
	})
}

const readArrow = (node: Expression): Read<Expr> => {
	if (!isArrowFunction(node)) {
		return unread("arrow", node)
	}
	const { body } = node
	return Result.gen(function* () {
		const params = yield* readAll(node.parameters, readParam)
		const returns =
			node.type === undefined ? Option.none() : Option.some(yield* readType(node.type))
		const read = isBlock(body)
			? yield* unread("a block body", body)
			: isParenthesizedExpression(body) && isObjectLiteralExpression(body.expression)
				? yield* readExpr(body.expression)
				: yield* readExpr(body)
		return Option.match(returns, {
			onNone: () => arrow(params, read),
			onSome: (type) => typedArrow(params, read, type)
		})
	})
}

const readObject = (node: Expression): Read<Expr> =>
	isObjectLiteralExpression(node)
		? Result.map(
				readAll(node.properties, (property) =>
					isPropertyAssignment(property)
						? Result.gen(function* () {
								const key = yield* readKey(property.name)
								const value = yield* readExpr(property.initializer)
								return [key, value] as const
							})
						: unread("object member", property)
				),
				obj
			)
		: unread("object", node)

const readScalar = (node: Expression): Option.Option<Expr> => {
	if (isStringLiteral(node)) {
		return Option.some(str(node.text))
	}
	if (isNumericLiteral(node)) {
		return Option.some(num(Number(node.text)))
	}
	if (node.kind === SyntaxKind.TrueKeyword || node.kind === SyntaxKind.FalseKeyword) {
		return Option.some(bool(node.kind === SyntaxKind.TrueKeyword))
	}
	if (isIdentifier(node)) {
		return Option.some(node.text === "undefined" ? undef : ident(fixedIdentifier(node.text)))
	}
	return Option.map(negated(node), num)
}

/** The printer's expression a parsed one is, read node by node. */
const readExpr = (node: Expression): Read<Expr> =>
	Option.match(readScalar(node), {
		onSome: Result.succeed,
		onNone: (): Read<Expr> => {
			if (isPropertyAccessExpression(node) && isIdentifier(node.name)) {
				const name = fixedMemberName(node.name.text)
				return Result.map(readExpr(node.expression), (object) => member(object, name))
			}
			if (isArrayLiteralExpression(node)) {
				return Result.map(readAll(node.elements, readExpr), arr)
			}
			if (isNewExpression(node)) {
				return Result.gen(function* () {
					const callee = yield* readExpr(node.expression)
					const args = yield* readAll(node.arguments ?? [], readExpr)
					return newExpr(callee, args)
				})
			}
			if (isConditionalExpression(node)) {
				return Result.gen(function* () {
					const test = yield* readExpr(node.condition)
					const consequent = yield* readExpr(node.whenTrue)
					const alternate = yield* readExpr(node.whenFalse)
					return conditional(test, consequent, alternate)
				})
			}
			if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.PlusToken) {
				return Result.gen(function* () {
					const left = yield* readExpr(node.left)
					const right = yield* readExpr(node.right)
					return plus(left, right)
				})
			}
			if (isObjectLiteralExpression(node)) {
				return readObject(node)
			}
			if (isArrowFunction(node)) {
				return readArrow(node)
			}
			return isCallExpression(node) ? readCall(node) : unread("expression", node)
		}
	})

const isExported = (modifiers: ReadonlyArray<Node> | undefined): boolean =>
	Arr.some(modifiers ?? [], (modifier) => modifier.kind === SyntaxKind.ExportKeyword)

const whitespace = regex("\\s+", "u")

/** A statement's JSDoc text, its lines joined by single spaces. */
const docOf = (node: Node): Option.Option<JsDocText> =>
	Option.flatMap(Arr.findLast(node.jsDoc ?? [], isJSDoc), (doc) =>
		Option.liftPredicate(isJsDocText)(
			Arr.join(Str.split(Str.trim(getTextOfJSDocComment(doc.comment) ?? ""), whitespace), " ")
		)
	)

/** One import statement as printed: its specifier, kind and names in their printed order. */
type ImportLine = Readonly<{
	from: string
	typeOnly: boolean
	kind: Import["_tag"]
	names: ReadonlyArray<string>
}>

const readImport = (node: ImportDeclaration): Read<ImportLine> => {
	const clause = node.importClause
	const bindings = clause?.namedBindings
	if (
		!isStringLiteral(node.moduleSpecifier) ||
		clause === undefined ||
		clause.name !== undefined ||
		bindings === undefined
	) {
		return unread("import", node)
	}
	const from = node.moduleSpecifier.text
	const typeOnly = clause.phaseModifier === SyntaxKind.TypeKeyword
	if (isNamespaceImport(bindings)) {
		return Result.succeed({ from, typeOnly, kind: "Namespace", names: [bindings.name.text] })
	}
	return isNamedImports(bindings) &&
		Arr.every(
			bindings.elements,
			(binding) => binding.propertyName === undefined && !binding.isTypeOnly
		)
		? Result.succeed({
				from,
				typeOnly,
				kind: "Named",
				names: Arr.map(bindings.elements, (binding) => binding.name.text)
			})
		: unread("import bindings", bindings)
}

const readField = (node: Node): Read<Field> => {
	if (
		!isPropertySignatureDeclaration(node) ||
		!Arr.some(node.modifiers ?? [], (modifier) => modifier.kind === SyntaxKind.ReadonlyKeyword)
	) {
		return unread("field", node)
	}
	const optional = node.postfixToken?.kind === SyntaxKind.QuestionToken
	return Result.gen(function* () {
		const key = yield* readKey(node.name)
		const type = yield* readType(node.type)
		return { key, optional, type }
	})
}

const readConst = (node: TsStatement): Read<Statement> => {
	if (!isVariableStatement(node)) {
		return unread("const", node)
	}
	const list = node.declarationList
	const [declaration] = list.declarations
	if (
		declaration === undefined ||
		list.declarations.length !== 1 ||
		!isIdentifier(declaration.name) ||
		declaration.initializer === undefined ||
		!Str.startsWith("const ")(list.getText())
	) {
		return unread("const declaration", node)
	}
	const name = fixedIdentifier(declaration.name.text)
	const initializer = declaration.initializer
	const asserted =
		isAsExpression(initializer) &&
		isTypeReferenceNode(initializer.type) &&
		isIdentifier(initializer.type.typeName) &&
		initializer.type.typeName.text === "const"
			? Option.some(initializer.expression)
			: Option.none()
	const annotation = declaration.type
	return Result.gen(function* () {
		const value = yield* readExpr(Option.getOrElse(asserted, () => initializer))
		const type = annotation === undefined ? Option.none() : Option.some(yield* readType(annotation))
		const statement: ConstStatement = {
			_tag: "Const",
			exported: isExported(node.modifiers),
			name,
			value,
			...present("type", type),
			...present("doc", docOf(node)),
			...(Option.isSome(asserted) ? { asConst: true } : {})
		}
		return statement
	})
}

const readStatement = (node: TsStatement): Read<Statement> => {
	if (isInterfaceDeclaration(node)) {
		const name = fixedIdentifier(node.name.text)
		return isExported(node.modifiers) &&
			node.typeParameters === undefined &&
			node.heritageClauses === undefined
			? Result.map(readAll(node.members, readField), (fields): Statement => ({
					_tag: "Interface",
					name,
					fields,
					...present("doc", docOf(node))
				}))
			: unread("interface", node)
	}
	if (isTypeAliasDeclaration(node)) {
		const name = fixedIdentifier(node.name.text)
		return isExported(node.modifiers) && node.typeParameters === undefined
			? Result.map(readType(node.type), (type): Statement => ({
					_tag: "TypeAlias",
					name,
					type,
					...present("doc", docOf(node))
				}))
			: unread("type alias", node)
	}
	if (isExpressionStatement(node)) {
		return Result.map(readExpr(node.expression), (value): Statement => ({
			_tag: "Expression",
			value
		}))
	}
	return readConst(node)
}

/** A binding an import statement makes. */
type Binding = Readonly<{ from: string; typeOnly: boolean; kind: Import["_tag"]; name: string }>

const byBinding: Order.Order<Binding> = Order.combineAll([
	Order.mapInput(Order.String, (binding: Binding) => binding.from),
	Order.mapInput(Order.Boolean, (binding: Binding) => binding.typeOnly),
	Order.mapInput(Order.String, (binding: Binding) => binding.kind),
	Order.mapInput(Order.String, (binding: Binding) => binding.name)
])

/** Bindings as a set: sorted, each once. */
const bindingSet = (bindings: ReadonlyArray<Binding>): ReadonlyArray<Binding> =>
	Arr.dedupeWith(Arr.sort(bindings, byBinding), (left, right) => byBinding(left, right) === 0)

/** A module as the comparison sees it: its shebang, its bindings as a set and its statements in order. */
type Reading = Readonly<{
	shebang: Option.Option<string>
	bindings: ReadonlyArray<Binding>
	statements: ReadonlyArray<Statement>
}>

const firstLine = regex("^#!([^\n]*)\n", "u")

/** The parsed module, its import statements in printed order beside it. */
export const readModule = (
	file: SourceFile
): Read<Readonly<{ reading: Reading; imports: ReadonlyArray<ImportLine> }>> => {
	const [importNodes, rest] = Arr.span(file.statements, isImportDeclaration)
	return Result.gen(function* () {
		const imports = yield* readAll(importNodes, (node) =>
			isImportDeclaration(node) ? readImport(node) : unread("import", node)
		)
		const statements = yield* readAll(rest, readStatement)
		const shebang = Option.flatMap(Option.fromNullishOr(firstLine.exec(file.text)), (match) =>
			Arr.get(match, 1)
		)
		const bindings = bindingSet(
			Arr.flatMap(imports, (line) =>
				Arr.map(line.names, (name) => ({
					from: line.from,
					typeOnly: line.typeOnly,
					kind: line.kind,
					name
				}))
			)
		)
		return { reading: { shebang, bindings, statements }, imports }
	})
}

const canonicalType = (type: TypeExpr): TypeExpr =>
	Match.valueTags(type, {
		TypeKeyword: (keyword): TypeExpr => keyword,
		TypeLiteral: (literal): TypeExpr => literal,
		TypeQuery: (query): TypeExpr => query,
		TypeReadonlyArray: (list) => typeReadonlyArray(canonicalType(list.element)),
		TypeRef: (reference) =>
			typeApply(reference.head, reference.members, Arr.map(reference.args, canonicalType)),
		TypeUnion: (union) =>
			typeUnion(Arr.flatMap(union.members, (inner) => unionMembers(canonicalType(inner))))
	})

const byEntryKey = Order.mapInput(Order.String, (entry: Entry) => entry[0])

const byFieldKey = Order.mapInput(Order.String, (field: Field) => field.key)

const canonicalParam = (param: Param): Param =>
	param.type === undefined ? param : { name: param.name, type: canonicalType(param.type) }

/** An expression as the printer means it: object entries in key order, unions flattened. */
const canonicalExpr = (expr: Expr): Expr =>
	Match.valueTags(expr, {
		Array: (list) => arr(Arr.map(list.elements, canonicalExpr)),
		Arrow: (fn): Expr => ({
			_tag: "Arrow",
			params: Arr.map(fn.params, canonicalParam),
			returns: Option.map(fn.returns, canonicalType),
			body: canonicalExpr(fn.body)
		}),
		Boolean: (literal): Expr => literal,
		Call: (invocation) =>
			call(canonicalExpr(invocation.callee), Arr.map(invocation.args, canonicalExpr)),
		Conditional: (choice) =>
			conditional(
				canonicalExpr(choice.test),
				canonicalExpr(choice.consequent),
				canonicalExpr(choice.alternate)
			),
		DynamicImport: (entry): Expr => entry,
		Identifier: (name): Expr => name,
		Member: (access) => member(canonicalExpr(access.object), access.name),
		New: (construct) =>
			newExpr(canonicalExpr(construct.callee), Arr.map(construct.args, canonicalExpr)),
		Number: (literal): Expr => literal,
		Object: (literal) =>
			obj(
				Arr.sort(
					Arr.map(literal.entries, ([key, value]): Entry => [key, canonicalExpr(value)]),
					byEntryKey
				)
			),
		Plus: (sum) => plus(canonicalExpr(sum.left), canonicalExpr(sum.right)),
		String: (literal): Expr => literal,
		Undefined: (literal): Expr => literal
	})

const canonicalStatement = (statement: Statement): Statement =>
	Match.valueTags(statement, {
		Const: (constant): Statement => ({
			...constant,
			value: canonicalExpr(constant.value),
			...(constant.type === undefined ? {} : { type: canonicalType(constant.type) })
		}),
		Expression: (expression): Statement => ({
			...expression,
			value: canonicalExpr(expression.value)
		}),
		Interface: (declaration): Statement => ({
			...declaration,
			fields: Arr.sort(
				Arr.map(declaration.fields, (field) => ({ ...field, type: canonicalType(field.type) })),
				byFieldKey
			)
		}),
		TypeAlias: (alias): Statement => ({ ...alias, type: canonicalType(alias.type) })
	})

/** The module the printed text must read back as. */
export const canonicalModule = (module: Module): Reading => ({
	shebang: Option.fromUndefinedOr(module.shebang),
	bindings: bindingSet(
		Arr.flatMap(module.imports, (entry) =>
			entry._tag === "Named"
				? Arr.map(entry.names, (name): Binding => ({
						from: entry.from,
						typeOnly: entry.typeOnly,
						kind: entry._tag,
						name
					}))
				: [{ from: entry.from, typeOnly: entry.typeOnly, kind: entry._tag, name: entry.name }]
		)
	),
	statements: Arr.map(module.statements, canonicalStatement)
})

const forbidden = regex("[\\r\\t\\uFEFF]", "u")

const trailingSpace = regex(" $", "u")

const leadingSpaces = regex("^ *", "u")

const docContent = regex("^ \\* ", "u")

const docLine = regex("^ \\*", "u")

const placeholder = regex("\\$\\{[^]*\\}", "u")

const fenceOpen = "/* oxlint-disable no-template-curly-in-string -- "

const fenceClose = "/* oxlint-enable no-template-curly-in-string */"

/** The top-level blocks of a printed module: shebang, import block and each statement, split at the blank lines. */
const blocksOf = (text: string): ReadonlyArray<string> =>
	text === "" ? [] : Str.split("\n\n")(Str.slice(0, -1)(text))

const linesOf = (text: string): ReadonlyArray<string> =>
	text === "" ? [] : Str.split("\n")(Str.slice(0, -1)(text))

const evenIndent = (line: string): boolean =>
	docLine.test(line) ||
	Option.match(Option.fromNullishOr(leadingSpaces.exec(line)), {
		onNone: () => true,
		onSome: (match) => match[0].length % 2 === 0
	})

/**
 * Each JSDoc line of a block whose successor took a word that would still have fit on it, so the fill was not greedy.
 */
const ungreedyLines = (block: string): ReadonlyArray<string> => {
	const content = Arr.filter(Str.split("\n")(block), (line) => docContent.test(line))
	return Arr.getSomes(
		Arr.map(Arr.zip(content, Arr.drop(content, 1)), ([line, next]) =>
			Option.flatMap(Arr.head(Str.split(" ")(Str.slice(3)(next))), (word) =>
				textWidth(`${line} ${word}`) <= lineWidth
					? Option.some(`${next}: a JSDoc word that fit the line above`)
					: Option.none()
			)
		)
	)
}

/** Whether a statement block is fenced exactly when it holds a template placeholder. */
const fencedRight = (block: string): boolean => {
	const lines = Str.split("\n")(block)
	const fenced =
		Option.exists(Arr.head(lines), Str.startsWith(fenceOpen)) &&
		Option.exists(Arr.last(lines), (line) => line === fenceClose)
	const inner = fenced ? Arr.join(Arr.drop(Arr.dropRight(lines, 1), 1), "\n") : block
	return fenced === placeholder.test(inner)
}

/** Every way printed text breaks the docs/printer.md line, block and fence rules, by line or block. */
export const layoutFindings = (text: string, module: Module): ReadonlyArray<string> => {
	const lines = linesOf(text)
	const blocks = blocksOf(text)
	const statementBlocks = Arr.drop(
		blocks,
		(module.shebang === undefined ? 0 : 1) + (Arr.isReadonlyArrayNonEmpty(module.imports) ? 1 : 0)
	)
	const expectedBlocks =
		(module.shebang === undefined ? 0 : 1) +
		(Arr.isReadonlyArrayNonEmpty(module.imports) ? 1 : 0) +
		module.statements.length
	return [
		...(forbidden.test(text) ? ["a carriage return, tab or byte order mark"] : []),
		...(text !== "" && (!Str.endsWith("\n")(text) || Str.endsWith("\n\n")(text))
			? ["not one final newline"]
			: []),
		...(expectedBlocks === 0 && text !== "" ? ["an empty module printed text"] : []),
		...(blocks.length === expectedBlocks ? [] : [`${blocks.length} blocks for ${expectedBlocks}`]),
		...(Arr.some(blocks, (block) => block === "" || Str.startsWith("\n")(block))
			? ["more than one blank line between blocks"]
			: []),
		...(module.shebang === undefined || Option.contains(Arr.head(blocks), `#!${module.shebang}`)
			? []
			: ["the shebang is not the first block alone"]),
		...Arr.getSomes(
			Arr.map(lines, (line, index) =>
				trailingSpace.test(line)
					? Option.some(`line ${index + 1}: trailing whitespace`)
					: evenIndent(line)
						? Option.none()
						: Option.some(`line ${index + 1}: an odd indent`)
			)
		),
		...Arr.flatMap(statementBlocks, ungreedyLines),
		...Arr.getSomes(
			Arr.map(statementBlocks, (block, index) =>
				fencedRight(block) ? Option.none() : Option.some(`statement ${index + 1}: fenced wrongly`)
			)
		)
	]
}

const isPackageSpecifier = (from: string): boolean => !Str.startsWith(".")(from)

/** Imports in their documented order: package specifiers before relative ones, then by specifier in code-unit order,
 * `import type` before the value import of one specifier; named specifiers sorted; one named statement per
 * specifier and kind. */
export const importFindings = (imports: ReadonlyArray<ImportLine>): ReadonlyArray<string> => [
	...Arr.getSomes(
		Arr.map(Arr.zip(imports, Arr.drop(imports, 1)), ([before, after], index) => {
			const groups = Order.Boolean(
				!isPackageSpecifier(before.from),
				!isPackageSpecifier(after.from)
			)
			const specifiers = Order.String(before.from, after.from)
			const kinds = Order.Boolean(!before.typeOnly, !after.typeOnly)
			const outOfOrder =
				groups > 0 || (groups === 0 && (specifiers > 0 || (specifiers === 0 && kinds > 0)))
			return outOfOrder ? Option.some(`import ${index + 2}: out of order`) : Option.none()
		})
	),
	...Arr.getSomes(
		Arr.map(imports, (line, index) =>
			Arr.isReadonlyArrayNonEmpty(line.names) &&
			Arr.some(
				Arr.zip(line.names, Arr.drop(line.names, 1)),
				([before, after]) => Order.String(before, after) >= 0
			)
				? Option.some(`import ${index + 1}: names not sorted or repeated`)
				: Option.none()
		)
	),
	...(Arr.dedupeWith(
		Arr.filter(imports, (line) => line.kind === "Named"),
		(left: ImportLine, right: ImportLine) =>
			left.from === right.from && left.typeOnly === right.typeOnly
	).length === Arr.filter(imports, (line) => line.kind === "Named").length
		? []
		: ["two named imports of one specifier and kind"])
]

/** Every node under `node`, depth first. */
const descendants = (node: Node): ReadonlyArray<Node> =>
	Arr.flatMap(Arr.fromIterable(node.childrenIter()), (child) => [child, ...descendants(child)])

const escapeSet = regex("[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Cs}]", "u")

const escapeSequence = regex("\\\\(u[0-9A-Fa-f]{4}|[^])", "gu")

const lowerHex = regex("[a-f]", "u")

const notAscii = regex("[^\\x20-\\x7E]", "u")

const count = (text: string, char: string): number => Str.split(char)(text).length - 1

const isKeyOf = (node: Node): boolean => {
	const { parent } = node
	return (
		(isPropertyAssignment(parent) || isPropertySignatureDeclaration(parent)) &&
		parent.name.pos === node.pos &&
		parent.name.end === node.end
	)
}

/**
 * Every way printed text breaks the Strings rules. Non-ASCII and backslashes appear only inside string literals, so the
 * text as a whole holds no raw code point of the escape set and no lower-case `\\u` escape; each literal takes the
 * formatter's quotes, and each quoted key is ASCII.
 */
export const stringFindings = (file: SourceFile, text: string): ReadonlyArray<string> => {
	const escapes = Arr.map(
		Arr.fromIterable(Str.matchAll(escapeSequence)(text)),
		(match) => match[1] ?? ""
	)
	return [
		...(escapeSet.test(Str.replaceAll("\n", "")(text))
			? ["a raw code point of the escape set"]
			: []),
		...(Arr.some(escapes, (escape) => Str.startsWith("u")(escape) && lowerHex.test(escape))
			? ["a lower-case escape"]
			: []),
		...Arr.flatMap(descendants(file), (node) => {
			if (!isStringLiteral(node)) {
				return []
			}
			const raw = node.getText()
			const quote = count(node.text, '"') > count(node.text, "'") ? "'" : '"'
			return [
				...(Str.startsWith(quote)(raw) ? [] : [`${raw}: not in ${quote} quotes`]),
				...(isKeyOf(node) && notAscii.test(raw) ? [`${raw}: a quoted key that is not ASCII`] : [])
			]
		})
	]
}

/** The expressions inside an expression, one level down. */
const subExprs = (expr: Expr): ReadonlyArray<Expr> =>
	Match.valueTags(expr, {
		Array: (list) => list.elements,
		Arrow: (fn) => [fn.body],
		Boolean: () => [],
		Call: (invocation) => [invocation.callee, ...invocation.args],
		Conditional: (choice) => [choice.test, choice.consequent, choice.alternate],
		DynamicImport: () => [],
		Identifier: () => [],
		Member: (access) => [access.object],
		New: (construct) => [construct.callee, ...construct.args],
		Number: () => [],
		Object: (literal) => Arr.map(literal.entries, ([, value]) => value),
		Plus: (sum) => [sum.left, sum.right],
		String: () => [],
		Undefined: () => []
	})

const allExprs = (expr: Expr): ReadonlyArray<Expr> => [
	expr,
	...Arr.flatMap(subExprs(expr), allExprs)
]

const moduleExprs = (module: Module): ReadonlyArray<Expr> =>
	Arr.flatMap(module.statements, (statement) =>
		statement._tag === "Const" || statement._tag === "Expression" ? allExprs(statement.value) : []
	)

export type Feature =
	| "a shebang"
	| "a type-only import"
	| "a namespace import"
	| "relative imports after package imports"
	| "an import broken one name per line"
	| "a JSDoc over several lines"
	| "a quoted key"
	| "a computed __proto__ key"
	| "a reserved word as a bare key"
	| "an object broken"
	| "an array of numbers filled"
	| "an array always broken"
	| "a hugged last argument"
	| "an arrow head broken"
	| "an arrow body below its head"
	| "a conditional broken"
	| "a long union broken"
	| "a type alias below its name"
	| "a const value below its head"
	| "a property value below its key"
	| "a second call group"
	| "a curried call"
	| "a new expression"
	| "a dynamic import"
	| "a broken plus"
	| "an escaped code point"
	| "a single-quoted string"
	| "a fenced template placeholder"
	| "a line past column 100"
	| "a wide or zero-width character on a full line"
	| "an as-const value"
	| "an optional field"
	| "a top-level call"
	| "arguments broken as a function composition"
	| "a long import of one name"
	| "a type query"
	| "a type argument broken"

const RESERVED_KEYS: ReadonlyArray<string> = ["default", "class", "constructor"]

const unionLine = regex("^ +\\| ", "u")

const aliasHead = regex("^export type \\S+ =$", "u")

const constHead = regex("^(?:export )?const .* =$", "u")

const keyHead = regex(":$", "u")

const keysOf = (module: Module): ReadonlyArray<string> => [
	...Arr.flatMap(moduleExprs(module), (expr) =>
		expr._tag === "Object" ? Arr.map(expr.entries, ([key]) => key) : []
	),
	...Arr.flatMap(module.statements, (statement) =>
		statement._tag === "Interface" ? Arr.map(statement.fields, (field) => field.key) : []
	)
]

const isComposite = (expr: Expr): boolean =>
	(expr._tag === "Object" && expr.entries.length > 1) ||
	(expr._tag === "Array" && expr.elements.length > 1)

const when = (holds: boolean, feature: Feature): ReadonlyArray<Feature> => (holds ? [feature] : [])

/** What a module's own shape reaches. */
export const moduleFeatures = (module: Module): ReadonlyArray<Feature> => {
	const exprs = moduleExprs(module)
	const keys = keysOf(module)
	const froms = Arr.map(module.imports, (entry) => entry.from)
	return [
		...when(module.shebang !== undefined, "a shebang"),
		...when(
			Arr.some(module.imports, (entry) => entry.typeOnly),
			"a type-only import"
		),
		...when(
			Arr.some(module.imports, (entry) => entry._tag === "Namespace"),
			"a namespace import"
		),
		...when(
			Arr.some(froms, isPackageSpecifier) && Arr.some(froms, (from) => !isPackageSpecifier(from)),
			"relative imports after package imports"
		),
		...when(
			Arr.some(keys, (key) => key === "__proto__"),
			"a computed __proto__ key"
		),
		...when(
			Arr.some(keys, (key) => Arr.contains(RESERVED_KEYS, key)),
			"a reserved word as a bare key"
		),
		...when(
			Arr.some(
				exprs,
				(expr) =>
					expr._tag === "Array" && expr.elements.length > 1 && Arr.every(expr.elements, isComposite)
			),
			"an array always broken"
		),
		...when(
			Arr.some(
				exprs,
				(expr) =>
					expr._tag === "Call" &&
					expr.callee._tag === "Member" &&
					expr.callee.object._tag === "Call"
			),
			"a second call group"
		),
		...when(
			Arr.some(exprs, (expr) => expr._tag === "Call" && expr.callee._tag === "Call"),
			"a curried call"
		),
		...when(
			Arr.some(exprs, (expr) => expr._tag === "New"),
			"a new expression"
		),
		...when(
			Arr.some(exprs, (expr) => expr._tag === "DynamicImport"),
			"a dynamic import"
		),
		...when(
			Arr.some(
				module.statements,
				(statement) =>
					statement._tag === "Interface" && Arr.some(statement.fields, (field) => field.optional)
			),
			"an optional field"
		),
		...when(
			Arr.some(module.statements, (statement) => statement._tag === "Expression"),
			"a top-level call"
		),
		...when(
			Arr.some(
				exprs,
				(expr) =>
					(expr._tag === "Call" || expr._tag === "New") &&
					expr.args.length > 1 &&
					(Arr.filter(expr.args, (arg) => arg._tag === "Arrow").length > 1 ||
						Arr.some(
							expr.args,
							(arg) => arg._tag === "Call" && Arr.some(arg.args, (inner) => inner._tag === "Arrow")
						))
			),
			"arguments broken as a function composition"
		)
	]
}

const codePoints = (text: string): number => Arr.fromIterable(text).length

/** What the printed text shows of its layout. */
export const textFeatures = (text: string): ReadonlyArray<Feature> => {
	const lines = linesOf(text)
	return [
		...when(
			Arr.some(lines, (line) => line === "import {" || line === "import type {"),
			"an import broken one name per line"
		),
		...when(
			Arr.some(
				lines,
				(line) =>
					Str.startsWith("import ")(line) &&
					Str.includes("{ ")(line) &&
					!Str.includes(", ")(line) &&
					textWidth(line) > lineWidth
			),
			"a long import of one name"
		),
		...when(
			Arr.some(
				Arr.zip(lines, Arr.drop(lines, 1)),
				([line, next]) => docContent.test(line) && docContent.test(next)
			),
			"a JSDoc over several lines"
		),
		...when(
			Arr.some(lines, (line) => unionLine.test(line)),
			"a long union broken"
		),
		...when(
			Arr.some(lines, (line) => Str.startsWith("export type ")(line) && Str.endsWith("<")(line)) ||
				Arr.some(lines, (line) => line === "  >;"),
			"a type argument broken"
		),
		...when(
			Arr.some(lines, (line) => aliasHead.test(line)),
			"a type alias below its name"
		),
		...when(
			Arr.some(lines, (line) => constHead.test(line)),
			"a const value below its head"
		),
		...when(
			Arr.some(
				lines,
				(line) => keyHead.test(line) && !docLine.test(line) && !Str.includes("readonly ")(line)
			),
			"a property value below its key"
		),
		...when(Arr.some(lines, Str.endsWith(" +")), "a broken plus"),
		...when(Str.includes("\\u")(text), "an escaped code point"),
		...when(Str.includes(fenceOpen)(text), "a fenced template placeholder"),
		...when(Str.includes(" as const;")(text), "an as-const value"),
		...when(
			Arr.some(lines, (line) => textWidth(line) > lineWidth),
			"a line past column 100"
		),
		...when(
			Arr.some(
				lines,
				(line) =>
					textWidth(line) >= lineWidth - 5 &&
					textWidth(line) <= lineWidth &&
					textWidth(line) !== codePoints(line)
			),
			"a wide or zero-width character on a full line"
		)
	]
}

/** What the parsed tree shows of the broken forms. */
export const treeFeatures = (file: SourceFile): ReadonlyArray<Feature> => {
	const nodes = descendants(file)
	const lineOf = (position: number): number => file.getLineAndCharacterOfPosition(position).line
	const spans = (node: Node): boolean => lineOf(node.getStart()) !== lineOf(node.end)
	return [
		...when(
			Arr.some(nodes, (node) => isObjectLiteralExpression(node) && spans(node)),
			"an object broken"
		),
		...when(Arr.some(nodes, isTypeQueryNode), "a type query"),
		...when(
			Arr.some(nodes, (node) => isStringLiteral(node) && isKeyOf(node)),
			"a quoted key"
		),
		...when(
			Arr.some(nodes, (node) => isStringLiteral(node) && Str.startsWith("'")(node.getText())),
			"a single-quoted string"
		),
		...when(
			Arr.some(
				nodes,
				(node) =>
					isArrayLiteralExpression(node) &&
					node.elements.length > 1 &&
					Arr.every(
						node.elements,
						(item) => isNumericLiteral(item) || Option.isSome(negated(item))
					) &&
					spans(node) &&
					Arr.some(
						Arr.zip(node.elements, Arr.drop(node.elements, 1)),
						([left, right]) => lineOf(left.getStart()) === lineOf(right.getStart())
					)
			),
			"an array of numbers filled"
		),
		...when(
			Arr.some(
				nodes,
				(node) =>
					isCallExpression(node) &&
					Option.exists(
						Arr.last(node.arguments),
						(last) => lineOf(node.arguments.pos) === lineOf(last.getStart()) && spans(last)
					)
			),
			"a hugged last argument"
		),
		...when(
			Arr.some(
				nodes,
				(node) =>
					isArrowFunction(node) &&
					Option.exists(
						Arr.head(node.parameters),
						(first) => lineOf(first.getStart()) > lineOf(node.getStart())
					)
			),
			"an arrow head broken"
		),
		...when(
			Arr.some(
				nodes,
				(node) =>
					isArrowFunction(node) &&
					lineOf(node.body.getStart()) > lineOf(node.equalsGreaterThanToken.end)
			),
			"an arrow body below its head"
		),
		...when(
			Arr.some(
				nodes,
				(node) =>
					isConditionalExpression(node) &&
					lineOf(node.whenTrue.getStart()) > lineOf(node.condition.end)
			),
			"a conditional broken"
		)
	]
}

export type FaultFeature =
	| "a repeated object key"
	| "a repeated field key"
	| "a non-finite number"
	| "an arrow whose body is an arrow, a conditional or a plus"
	| "a conditional with a conditional or an arrow operand"
	| "a third call group"
	| "a second call group on a lower-case head"
	| "a call of no path"
	| "a member of no path outside a callee"
	| "a new of no path"
	| "a plus outside a call argument"
	| "a plus of a call"
	| "a statement that is no call"
	| "a const head past column 100"
	| "a field past column 100"
	| "a type alias past column 100"
	| "a union member past column 100"

type Reason = PrinterError["reason"]

/** One construct outside the subset, the statement that holds it, and the refusal it must meet: the reason, and the
 * subject where the subject is a datum of the construct rather than its printed text. */
type Planted = Readonly<{
	statement: Statement
	reason: Reason
	subject: Option.Option<string>
	feature: FaultFeature
}>

const valid = exprGen(1, "value")

/** A constant holding `fault` as its value, an object member or an array element: a value slot each. */
const inValue =
	(fault: Expr): Gen<Statement> =>
	(s) => ({
		_tag: "Const",
		exported: true,
		name: s.draw(shortName),
		value: s.draw(
			oneOf([
				() => fault,
				(t) =>
					obj([
						["planted", fault],
						["z", t.draw(valid)]
					]),
				(t) => arr([t.draw(valid), fault])
			])
		)
	})

/** A constant holding `fault` as a value or as a call argument. */
const anywhere = (fault: Expr): Gen<Statement> =>
	oneOf([
		inValue(fault),
		(s) => ({
			_tag: "Const",
			exported: false,
			name: s.draw(shortName),
			value: call(s.draw(calleePath), [s.draw(valid), fault])
		})
	])

const planted = (
	feature: FaultFeature,
	reason: Reason,
	subject: Option.Option<string>,
	statement: Statement
): Planted => ({ statement, reason, subject, feature })

const twoArgs: Gen<TypeExpr> = (s) =>
	typeApply(s.draw(shortName), [], s.draw(array(simpleType, { min: 2, max: 2 })))

const FAULTS: Arr.NonEmptyReadonlyArray<Gen<Planted>> = [
	(s) => {
		const key = s.draw(keyGen)
		const fault = obj([
			[key, s.draw(valid)],
			[key, s.draw(valid)]
		])
		return planted(
			"a repeated object key",
			"duplicate-key",
			Option.some(key),
			s.draw(anywhere(fault))
		)
	},
	(s) => {
		const key = s.draw(keyGen)
		const field: Gen<Field> = (t) => ({ key, optional: t.draw(boolean), type: t.draw(simpleType) })
		return planted("a repeated field key", "duplicate-key", Option.some(key), {
			_tag: "Interface",
			name: s.draw(shortName),
			fields: [s.draw(field), s.draw(field)]
		})
	},
	(s) => {
		const value = s.draw(element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]))
		return planted(
			"a non-finite number",
			"non-finite-number",
			Option.some(String(value)),
			s.draw(anywhere(num(value)))
		)
	},
	(s) => {
		const body = s.draw(oneOf([arrowGen(1), conditionalGen(1), plusGen]))
		return planted(
			"an arrow whose body is an arrow, a conditional or a plus",
			"unsupported-arrow-body",
			Option.some(body._tag),
			s.draw(inValue(arrow([], body)))
		)
	},
	(s) => {
		const nested = s.draw(oneOf([conditionalGen(1), arrowGen(1)]))
		const operand = exprGen(1, "operand")
		const operands = s.draw(
			shuffled([nested, s.draw(operand), s.draw(operand)], { min: 3, max: 3 })
		)
		const [test = nested, consequent = nested, alternate = nested] = operands
		return planted(
			"a conditional with a conditional or an arrow operand",
			"unsupported-conditional",
			Option.some(nested._tag),
			s.draw(inValue(conditional(test, consequent, alternate)))
		)
	},
	(s) => {
		const first = call(s.draw(pathOf(capitalized, 1, shortMemberName)), [])
		const second = call(member(first, s.draw(memberName)), [])
		return planted(
			"a third call group",
			"unsupported-chain",
			Option.none(),
			s.draw(anywhere(call(member(second, s.draw(memberName)), [])))
		)
	},
	(s) => {
		const head = ident(fixedIdentifier(s.draw(element(["flags", "input", "a"]))))
		return planted(
			"a second call group on a lower-case head",
			"unsupported-chain",
			Option.none(),
			s.draw(
				anywhere(call(member(call(member(head, s.draw(memberName)), []), s.draw(memberName)), []))
			)
		)
	},
	(s) =>
		planted(
			"a call of no path",
			"unsupported-chain",
			Option.none(),
			s.draw(
				anywhere(
					call(s.draw(oneOf([map(stringValue, str), objectGen(1), map(numberValue, num)])), [])
				)
			)
		),
	(s) => {
		const name = s.draw(memberName)
		const object = s.draw(oneOf([callGen(1), map(stringValue, str), objectGen(1)]))
		return planted(
			"a member of no path outside a callee",
			"unsupported-member",
			Option.some(name),
			s.draw(anywhere(member(object, name)))
		)
	},
	(s) => {
		const callee = s.draw(oneOf([callGen(1), map(stringValue, str)]))
		return planted(
			"a new of no path",
			"unsupported-new",
			Option.some(callee._tag),
			s.draw(anywhere(newExpr(callee, [])))
		)
	},
	(s) =>
		planted(
			"a plus outside a call argument",
			"unsupported-plus",
			Option.some("value"),
			s.draw(inValue(s.draw(plusGen)))
		),
	(s) => {
		const fault = plus(s.draw(callGen(1)), s.draw(plusOperand))
		return planted("a plus of a call", "unsupported-plus", Option.some("argument"), {
			_tag: "Const",
			exported: true,
			name: s.draw(shortName),
			value: call(s.draw(calleePath), [fault])
		})
	},
	(s) => {
		const value = s.draw(oneOf([leafGen, objectGen(1), arrayGen(1)]))
		return planted(
			"a statement that is no call",
			"unsupported-expression",
			Option.some(value._tag),
			{ _tag: "Expression", value }
		)
	},
	(s) => {
		const name = fixedIdentifier(s.draw(overlongName))
		return planted("a const head past column 100", "unbreakable-line", Option.some(name), {
			_tag: "Const",
			exported: s.draw(boolean),
			name,
			type: s.draw(twoArgs),
			value: s.draw(valid)
		})
	},
	(s) => {
		const name = s.draw(shortName)
		return planted("a field past column 100", "unbreakable-line", Option.some(name), {
			_tag: "Interface",
			name,
			fields: [{ key: s.draw(overlongName), optional: s.draw(boolean), type: s.draw(twoArgs) }]
		})
	},
	(s) => {
		const name = fixedIdentifier(s.draw(overlongName))
		return planted("a type alias past column 100", "unbreakable-line", Option.some(name), {
			_tag: "TypeAlias",
			name,
			type: s.draw(twoArgs)
		})
	},
	(s) => {
		const name = s.draw(shortName)
		const wide = typeApply(
			fixedIdentifier(s.draw(overlongName)),
			[],
			s.draw(array(simpleType, { min: 2, max: 2 }))
		)
		return planted("a union member past column 100", "unbreakable-line", Option.some(name), {
			_tag: "Interface",
			name,
			fields: [{ key: "a", optional: false, type: typeUnion([wide, s.draw(simpleType)]) }]
		})
	}
]

/** A valid module with one planted statement at a drawn place. */
type Faulty = Readonly<{ module: Module; plant: Planted }>

export const faultyGen: Gen<Faulty> = (s) => {
	const base = s.draw(moduleGen)
	const plant = s.draw(oneOf(FAULTS))
	const at = s.draw(int(0, base.statements.length))
	return {
		module: {
			...base,
			statements: [
				...Arr.take(base.statements, at),
				plant.statement,
				...Arr.drop(base.statements, at)
			]
		},
		plant
	}
}

/** A refusal as the contract states it: the reason, and the subject only where it is a datum. */
type Refusal = Readonly<{ reason: Reason; subject: Option.Option<string> }>

/** JSON text read back in text order: a scalar, an array, or an object's members as the text lists them. */
type Tree =
	| Readonly<{ kind: "scalar"; value: null | boolean | number | string }>
	| Readonly<{ kind: "array"; items: ReadonlyArray<Tree> }>
	| Readonly<{ kind: "object"; members: ReadonlyArray<readonly [string, Tree]> }>

const readJson = (node: Expression): Read<Tree> => {
	if (node.kind === SyntaxKind.NullKeyword) {
		return Result.succeed({ kind: "scalar", value: null })
	}
	if (node.kind === SyntaxKind.TrueKeyword || node.kind === SyntaxKind.FalseKeyword) {
		return Result.succeed({ kind: "scalar", value: node.kind === SyntaxKind.TrueKeyword })
	}
	if (isStringLiteral(node)) {
		return Result.succeed({ kind: "scalar", value: node.text })
	}
	if (isNumericLiteral(node)) {
		return Result.succeed({ kind: "scalar", value: Number(node.text) })
	}
	if (isArrayLiteralExpression(node)) {
		return Result.map(readAll(node.elements, readJson), (items): Tree => ({ kind: "array", items }))
	}
	if (isObjectLiteralExpression(node)) {
		return Result.map(
			readAll(node.properties, (property) => {
				if (!isPropertyAssignment(property)) {
					return unread("JSON member", property)
				}
				const { name, initializer } = property
				return isStringLiteral(name)
					? Result.map(readJson(initializer), (value) => [name.text, value] as const)
					: unread("JSON key", name)
			}),
			(members): Tree => ({ kind: "object", members })
		)
	}
	return Option.match(negated(node), {
		onNone: () => unread("JSON value", node),
		onSome: (value) => Result.succeed({ kind: "scalar", value })
	})
}

const isJsonArray = (value: Json): value is readonly Json[] => Arr.isArray(value)

const isJsonScalar = (value: Json): value is null | boolean | number | string =>
	value === null || typeof value !== "object"

/** A JSON value as a tree, each object's members in the order `order` gives them. */
export const treeOf = (
	value: Json,
	order: (members: ReadonlyArray<readonly [string, Json]>) => ReadonlyArray<readonly [string, Json]>
): Tree => {
	if (isJsonScalar(value)) {
		return { kind: "scalar", value }
	}
	if (isJsonArray(value)) {
		return { kind: "array", items: Arr.map(value, (item) => treeOf(item, order)) }
	}
	return {
		kind: "object",
		members: Arr.map(
			order(Record.toEntries(value)),
			([key, item]) => [key, treeOf(item, order)] as const
		)
	}
}

const byJsonKey = Order.mapInput(Order.String, (entry: readonly [string, Json]) => entry[0])

export const sortedMembers = (members: ReadonlyArray<readonly [string, Json]>) =>
	Arr.sort(members, byJsonKey)

/** Every array and object of a parsed JSON text: whether it is empty, and whether it spans lines. */
type Shape = Readonly<{ kind: "array" | "object"; empty: boolean; broken: boolean }>

export const shapesOf = (file: SourceFile): ReadonlyArray<Shape> => {
	const lineOf = (position: number): number => file.getLineAndCharacterOfPosition(position).line
	return Arr.getSomes(
		Arr.map(descendants(file), (node): Option.Option<Shape> => {
			const broken = lineOf(node.getStart()) !== lineOf(node.end)
			if (isArrayLiteralExpression(node)) {
				return Option.some({ kind: "array", empty: node.elements.length === 0, broken })
			}
			return isObjectLiteralExpression(node)
				? Option.some({ kind: "object", empty: node.properties.length === 0, broken })
				: Option.none()
		})
	)
}

const JSON_KEYS: Arr.NonEmptyReadonlyArray<string> = [
	"name",
	"a",
	"B",
	"_b",
	"$schema",
	"10",
	"9",
	"é",
	"中文",
	"a b",
	"",
	"x\ny",
	'"q"'
]

const jsonScalar: Gen<Json> = weighted<Json>([
	[1, () => null],
	[1, boolean],
	[3, numberValue],
	[3, stringValue]
])

export const jsonGen = (depth: number): Gen<Json> =>
	depth === 0
		? jsonScalar
		: weighted([
				[3, jsonScalar],
				[1, (s) => s.draw(array(jsonGen(depth - 1), { min: 0, max: 5 }))],
				[1, (s) => s.draw(array(numberValue, { min: 2, max: 40 }))],
				[
					1,
					(s) =>
						s.draw(array((t) => t.draw(array(jsonScalar, { min: 1, max: 3 })), { min: 2, max: 4 }))
				],
				[
					2,
					(s) =>
						Record.fromEntries(
							s.draw(
								uniqueArray(
									element(JSON_KEYS),
									(key) => map(jsonGen(depth - 1), (value) => [key, value] as const),
									{
										min: 0,
										max: 5
									}
								)
							)
						)
				]
			])

/** The top-level keys of a manifest, in the order docs/printer.md gives them. */
const PACKAGE_KEYS: Arr.NonEmptyReadonlyArray<string> = [
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

/** The maps the formatter sorts by key inside a manifest. */
const SORTED_KEYS: ReadonlyArray<string> = ["bin", "dependencies", "devDependencies", "engines"]

const stringMap = (keys: Arr.NonEmptyReadonlyArray<string>, value: Gen<string>): Gen<Json> =>
	map(
		uniqueArray(element(keys), (key) => map(value, (text) => [key, text] as const), {
			min: 0,
			max: keys.length
		}),
		Record.fromEntries
	)

const packageValue = (key: string): Gen<Json> =>
	Match.value(key).pipe(
		Match.when("private", (): Gen<Json> => boolean),
		Match.when("description", (): Gen<Json> => stringValue),
		Match.when("bin", () =>
			stringMap(["users", "users-cli", "u"], element(["dist/src/bin.js", "bin.js"]))
		),
		Match.when("files", (): Gen<Json> =>
			shuffled(["dist", "README.md", "src"], { min: 0, max: 3 })
		),
		Match.when("imports", () =>
			map(
				subarray<readonly [string, Json]>([
					["#*.ts", { types: "./src/*.ts", default: "./dist/src/*.js" }],
					["#runtime/*", "./src/runtime/*"]
				]),
				Record.fromEntries
			)
		),
		Match.when("exports", () =>
			stringMap([".", "./package.json"], element(["./dist/index.js", "./package.json"]))
		),
		Match.when("scripts", () =>
			stringMap(
				["typecheck", "build", "test", "lint"],
				element(["tsc --noEmit", "tsc -p tsconfig.build.json"])
			)
		),
		Match.when("dependencies", () =>
			stringMap(["effect", "arkregex", "@effect/platform-node", "zod"], element(["4.1.2", "1.0.0"]))
		),
		Match.when("devDependencies", () =>
			stringMap(["typescript", "@types/node", "vitest"], element(["7.1.0-beta", "26.0.0"]))
		),
		Match.when("engines", () => stringMap(["node", "pnpm"], element([">=26", ">=12"]))),
		Match.orElse((): Gen<Json> => element(["users-cli", "1.0.0", "MIT", "module", "pnpm@12.16.1"]))
	)

/** A manifest of documented keys in a drawn order, each with a value of its kind. */
const manifestGen: Gen<Record.ReadonlyRecord<string, Json>> = (s) =>
	Record.fromEntries(
		Arr.map(
			s.draw(shuffled(PACKAGE_KEYS, { min: 0, max: PACKAGE_KEYS.length })),
			(key) => [key, s.draw(packageValue(key))] as const
		)
	)

/** A manifest's members in the documented order, its dependency maps sorted, every other map as drawn. */
export const manifestTree = (manifest: Record.ReadonlyRecord<string, Json>): Tree => ({
	kind: "object",
	members: Arr.getSomes(
		Arr.map(PACKAGE_KEYS, (key) =>
			Option.map(
				Record.get<string, Json>(manifest, key),
				(value) =>
					[
						key,
						treeOf(value, Arr.contains(SORTED_KEYS, key) ? sortedMembers : (members) => members)
					] as const
			)
		)
	)
})

export type ManifestFeature =
	| "keys reordered"
	| "a map sorted by key"
	| "a map kept in its order"
	| "an empty map"
	| "a key outside the order"
	| "a root that is no object"

/** A manifest as drawn, or one with a planted fault: a key outside the order, or a root that is no object. */
type ManifestCase =
	| Readonly<{ kind: "printed"; manifest: Record.ReadonlyRecord<string, Json> }>
	| Readonly<{ kind: "refused"; manifest: Json; subject: string; feature: ManifestFeature }>

const UNKNOWN_KEYS: Arr.NonEmptyReadonlyArray<string> = [
	"author",
	"keywords",
	"main",
	"zzz",
	"Name"
]

export const manifestCaseGen: Gen<ManifestCase> = weighted<ManifestCase>([
	[6, (s) => ({ kind: "printed", manifest: s.draw(manifestGen) })],
	[
		2,
		(s) => {
			const entries = Record.toEntries<string, Json>(s.draw(manifestGen))
			const key = s.draw(element(UNKNOWN_KEYS))
			const at = s.draw(int(0, entries.length))
			return {
				kind: "refused",
				manifest: Record.fromEntries([
					...Arr.take(entries, at),
					[key, s.draw(stringValue)] as const,
					...Arr.drop(entries, at)
				]),
				subject: key,
				feature: "a key outside the order"
			}
		}
	],
	[
		1,
		(s) => ({
			kind: "refused",
			manifest: s.draw(
				oneOf<Json>([jsonScalar, (t) => t.draw(array(jsonScalar, { min: 0, max: 3 }))])
			),
			subject: "root",
			feature: "a root that is no object"
		})
	]
])

/** The value of JSON text parsed as a parenthesized TypeScript expression, which JSON text always is. */
export const readJsonFile = (file: SourceFile): Read<Tree> =>
	Option.match(Arr.head(file.statements), {
		onNone: (): Read<Tree> => Result.fail("an empty JSON file"),
		onSome: (statement) =>
			isExpressionStatement(statement) && isParenthesizedExpression(statement.expression)
				? readJson(statement.expression.expression)
				: unread("JSON statement", statement)
	})

export type JsonFeature =
	| "an empty object"
	| "an empty array"
	| "a flat array"
	| "a broken array"
	| "a filled number array"
	| "an array of arrays"
	| "a nested object"
	| "an escaped character"
	| "a non-ASCII key"
	| "a numeric key"

const filledLine = regex("^ *-?[0-9][0-9.e+-]*(?:, -?[0-9][0-9.e+-]*)+,?$", "u")

/** Every value inside a JSON value, itself first. */
const jsonValues = (value: Json): ReadonlyArray<Json> =>
	isJsonScalar(value)
		? [value]
		: [
				value,
				...Arr.flatMap(isJsonArray(value) ? value : Record.values<string, Json>(value), jsonValues)
			]

const jsonKeys = (value: Json): ReadonlyArray<string> =>
	Arr.flatMap(jsonValues(value), (inner) =>
		isJsonScalar(inner) || isJsonArray(inner) ? [] : Record.keys<string, Json>(inner)
	)

const isJsonObject = (value: Json): value is Record.ReadonlyRecord<string, Json> =>
	!isJsonScalar(value) && !isJsonArray(value)

export const jsonFeatures = (
	value: Json,
	text: string,
	shapes: ReadonlyArray<Shape>
): ReadonlyArray<JsonFeature> => {
	const values = jsonValues(value)
	return [
		...whenJson(
			Arr.some(shapes, (shape) => shape.kind === "object" && shape.empty),
			"an empty object"
		),
		...whenJson(
			Arr.some(shapes, (shape) => shape.kind === "array" && shape.empty),
			"an empty array"
		),
		...whenJson(
			Arr.some(shapes, (shape) => shape.kind === "array" && !shape.empty && !shape.broken),
			"a flat array"
		),
		...whenJson(
			Arr.some(shapes, (shape) => shape.kind === "array" && !shape.empty && shape.broken),
			"a broken array"
		),
		...whenJson(
			Arr.some(linesOf(text), (line) => filledLine.test(line)),
			"a filled number array"
		),
		...whenJson(
			Arr.some(
				values,
				(inner) =>
					isJsonArray(inner) &&
					inner.length > 1 &&
					Arr.every(inner, (item) => isJsonArray(item) && item.length > 1)
			),
			"an array of arrays"
		),
		...whenJson(
			Arr.some(
				values,
				(inner) => isJsonObject(inner) && Arr.some(Record.values<string, Json>(inner), isJsonObject)
			),
			"a nested object"
		),
		...whenJson(Str.includes("\\")(text), "an escaped character"),
		...whenJson(
			Arr.some(jsonKeys(value), (key) => notAscii.test(key)),
			"a non-ASCII key"
		),
		...whenJson(
			Arr.some(jsonKeys(value), (key) => key === "10" || key === "9"),
			"a numeric key"
		)
	]
}

const whenJson = (holds: boolean, feature: JsonFeature): ReadonlyArray<JsonFeature> =>
	holds ? [feature] : []

const whenManifest = (holds: boolean, feature: ManifestFeature): ReadonlyArray<ManifestFeature> =>
	holds ? [feature] : []

const unsorted = (keys: ReadonlyArray<string>): boolean =>
	Arr.some(Arr.zip(keys, Arr.drop(keys, 1)), ([before, after]) => Order.String(before, after) > 0)

export const manifestFeatures = (
	manifest: Record.ReadonlyRecord<string, Json>
): ReadonlyArray<ManifestFeature> => {
	const keys = Record.keys<string, Json>(manifest)
	const maps = Arr.getSomes(
		Arr.map(Record.toEntries<string, Json>(manifest), ([key, value]) =>
			isJsonObject(value)
				? Option.some([key, Record.keys<string, Json>(value)] as const)
				: Option.none()
		)
	)
	return [
		...whenManifest(
			!Arr.every(
				Arr.zip(keys, Arr.drop(keys, 1)),
				([before, after]) => PACKAGE_KEYS.indexOf(before) < PACKAGE_KEYS.indexOf(after)
			),
			"keys reordered"
		),
		...whenManifest(
			Arr.some(maps, ([key, inner]) => Arr.contains(SORTED_KEYS, key) && unsorted(inner)),
			"a map sorted by key"
		),
		...whenManifest(
			Arr.some(maps, ([key, inner]) => !Arr.contains(SORTED_KEYS, key) && unsorted(inner)),
			"a map kept in its order"
		),
		...whenManifest(
			Arr.some(maps, ([, inner]) => inner.length === 0),
			"an empty map"
		)
	]
}

/** The refusal an exit carries, with its subject when the contract states one. */
export const refusalOf = <A>(
	exit: Exit.Exit<A, PrinterError>,
	subject: boolean
): Option.Option<Refusal> =>
	Exit.match(exit, {
		onSuccess: () => Option.none(),
		onFailure: (cause) =>
			Option.map(Cause.findErrorOption(cause), (error) => ({
				reason: error.reason,
				subject: subject ? Option.some(error.subject) : Option.none()
			}))
	})

/** The syntax diagnostics TypeScript reports for `text`, by code, through the library's one parser process. */
export const syntaxCodes = (text: string) =>
	Effect.map(syntaxDiagnosticsOf("printed.ts", text), (diagnostics) =>
		Arr.map(diagnostics, (diagnostic) => diagnostic.code)
	)

/** What the formatter makes of `text`: its output and its errors' messages. */
export const formatted = (fileName: string, text: string) =>
	Effect.map(
		Effect.promise(() => format(fileName, text, FORMAT_OPTIONS)),
		(result) => ({ code: result.code, errors: Arr.map(result.errors, (error) => error.message) })
	)
