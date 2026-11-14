import { regex } from "arkregex"
import {
	Array as Arr,
	Effect,
	Function,
	JsonPointer,
	Match,
	Option,
	Order,
	Predicate,
	Record,
	Schema,
	SchemaRepresentation,
	String as Str
} from "effect"
import type { JsonSchema } from "effect"
import { guardTemplateCurly, stringLiteral, lineWidth, keyText, numberText } from "#emit/escape.ts"
import type { EmittedFile } from "#emit/package.ts"
import { textWidth } from "#emit/printer.ts"
import type { Json } from "#model/pointer.ts"
import type { SafeIdentifierValue } from "#names/fold.ts"
import { codeGenerationCopy, importSchemas } from "#normalize/schemas.ts"
import type { SchemaBudgetExceeded, SchemaLimits } from "#normalize/schemas.ts"

/**
 * The code-generation copy cannot become `domain/schemas.ts`. `identifier-mismatch`: a copy key
 * has no name in the identifier map, two keys share one, or Effect named a definition otherwise
 * than the map does (the module would not export what cli modules import). `import-failed`: the
 * copy, which normalize already imported through the same `importSchemas`, does not import again,
 * or names a definition outside itself (a defect, never a property of the document).
 * `reference-cycle`: a cycle of the import that no definition closes, met while writing out
 * Effect's own reference names, or definitions that read each other outside `Schema.suspend`.
 */
export class DomainEmitError extends Schema.TaggedError<
	DomainEmitError,
	{ readonly brand: unique symbol }
>()("DomainEmitError", {
	reason: Schema.Literals([
		"identifier-mismatch",
		"import-failed",
		"reference-cycle",
		"unprintable-code",
		"unsupported-artifact",
		"unsupported-definition"
	])
}) {}

/**
 * A type in the syntax of the code `SchemaRepresentation.toCodeDocument` writes. Effect writes each
 * definition as one unformatted line, and `vp fmt` accepts exactly one layout of it, so the code
 * is parsed and laid out here (docs/printer.md: the generator never runs a formatter).
 */
type Ty =
	| { readonly _tag: "Inter"; readonly members: readonly Ty[] }
	| { readonly _tag: "Lit"; readonly text: string }
	| { readonly _tag: "Obj"; readonly members: readonly Member[] }
	| { readonly _tag: "Ref"; readonly args: readonly Ty[]; readonly path: readonly string[] }
	| { readonly _tag: "Tuple"; readonly elements: readonly TupleElement[] }
	| { readonly _tag: "Union"; readonly members: readonly Ty[] }

interface Member {
	readonly index: Ty | undefined
	readonly key: string
	readonly optional: boolean
	readonly readonly: boolean
	readonly type: Ty
}

interface TupleElement {
	readonly optional: boolean
	readonly rest: boolean
	readonly type: Ty
}

type Ex =
	| { readonly _tag: "Arr"; readonly elements: readonly Ex[] }
	| { readonly _tag: "Arrow"; readonly body: Ex; readonly returns: Ty }
	| { readonly _tag: "Call"; readonly args: readonly Ex[]; readonly callee: Ex }
	| { readonly _tag: "Ident"; readonly name: string }
	| { readonly _tag: "Member"; readonly name: string; readonly object: Ex }
	| { readonly _tag: "Num"; readonly value: number }
	| { readonly _tag: "Obj"; readonly entries: readonly Entry[] }
	| { readonly _tag: "Str"; readonly value: string }

interface Entry {
	readonly name: string
	readonly value: Ex
}

type TokenKind = "ident" | "number" | "punct" | "string"

interface Token {
	readonly kind: TokenKind
	readonly text: string
}

/**
 * One token after optional white space. A `bad` match is a bigint, outside the grammar. Matched
 * through `matchAll`, which reads a copy, so the sticky cursor is never shared between runs.
 */
const tokenPattern = regex(
	'\\s*(?:(?<bad>-?\\d+n)|(?<string>"(?:[^"\\\\]|\\\\.)*")|(?<number>-?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?)|(?<ident>[A-Za-z_$][A-Za-z0-9_$]*)|(?<punct>=>|\\.\\.\\.|[{}()[\\]<>,:.?|&]))',
	"guy"
)

const tokenKinds: readonly TokenKind[] = ["string", "number", "ident", "punct"]

/**
 * The token a match read, by the first group it matched; none for a `bad` match.
 */
const kindOf = (groups: Readonly<Record<string, string | undefined>>): Option.Option<Token> =>
	Arr.findFirst(tokenKinds, (kind) =>
		Option.map(Option.fromUndefinedOr(groups[kind]), (text) => ({ kind, text }))
	)

/**
 * The source's tokens; none when the text holds something outside the grammar: a bigint, a
 * template literal.
 */
const tokenize = (source: string): Option.Option<readonly Token[]> => {
	const found = Arr.fromIterable(Str.matchAll(tokenPattern)(source))
	const end = Arr.reduce(found, 0, (consumed, match) => consumed + match[0].length)

	return Str.trim(Str.slice(end)(source)) === ""
		? Option.all(Arr.map(found, (match) => kindOf(match.groups ?? {})))
		: Option.none()
}

const decodeString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))

const placeholder: Ty = { _tag: "Lit", text: "" }

/**
 * A recursive-descent parser over the tokens. A failed parse keeps returning placeholders; the
 * caller reads `failed` once at the end.
 */
class Parser {
	failed = false
	private position = 0
	private readonly tokens: readonly Token[]

	constructor(tokens: readonly Token[]) {
		this.tokens = tokens
	}

	done(): boolean {
		return !this.failed && this.position >= this.tokens.length
	}

	private peek(offset: number): Token | undefined {
		return this.tokens[this.position + offset]
	}

	private next(): Token {
		const token = this.tokens[this.position]
		this.position += 1
		if (token === undefined) {
			this.failed = true
		}

		return token ?? { kind: "punct", text: "" }
	}

	private is(text: string, offset: number): boolean {
		const token = this.peek(offset)

		return token?.kind === "punct" && token.text === text
	}

	private accept(text: string): boolean {
		const matched = this.is(text, 0)
		if (matched) {
			this.position += 1
		}

		return matched
	}

	private expect(text: string): void {
		if (!this.accept(text)) {
			this.failed = true
			this.position += 1
		}
	}

	private string(): string {
		const token = this.next()
		const decoded = token.kind === "string" ? decodeString(token.text) : Option.none()
		if (Option.isNone(decoded)) {
			this.failed = true
		}

		return Option.getOrElse(decoded, () => "")
	}

	private list<A>(close: string, item: () => A): readonly A[] {
		const items: A[] = []
		while (!this.failed && this.position < this.tokens.length && !this.is(close, 0)) {
			items.push(item())
			if (!this.accept(",")) {
				break
			}
		}

		this.expect(close)

		return items
	}

	type(): Ty {
		const first = this.intersection()
		if (!this.is("|", 0)) {
			return first
		}

		const members = [first]
		while (this.accept("|")) {
			members.push(this.intersection())
		}

		return { _tag: "Union", members }
	}

	/**
	 * Only the object intersections `toCodeDocument` writes have a layout here.
	 */
	private intersection(): Ty {
		const first = this.typePrimary()
		if (!this.is("&", 0)) {
			return first
		}

		const members = [first]
		while (this.accept("&")) {
			members.push(this.typePrimary())
		}

		this.failed ||= !Arr.every(members, (member) => member._tag === "Obj")

		return { _tag: "Inter", members }
	}

	private member(): Member {
		const readonlyKeyword = this.peek(0)?.text === "readonly" && !this.is(":", 1)
		if (readonlyKeyword) {
			this.next()
		}

		if (this.accept("[")) {
			this.next()
			this.expect(":")

			const index = this.type()
			this.expect("]")
			this.expect(":")

			return { index, key: "", optional: false, readonly: readonlyKeyword, type: this.type() }
		}

		const key = this.peek(0)?.kind === "string" ? this.string() : this.next().text
		const optional = this.accept("?")
		this.expect(":")

		return { index: undefined, key, optional, readonly: readonlyKeyword, type: this.type() }
	}

	private tupleElement(): TupleElement {
		const rest = this.accept("...")
		if (this.accept("(")) {
			const type = this.type()
			this.expect(")")

			return { optional: this.accept("?"), rest, type }
		}

		return { optional: false, rest, type: this.type() }
	}

	private reference(): Ty {
		const path = [this.next().text]
		while (this.accept(".")) {
			path.push(this.next().text)
		}

		return { _tag: "Ref", args: this.accept("<") ? this.list(">", () => this.type()) : [], path }
	}

	private typePrimary(): Ty {
		const token = this.peek(0)
		if (token?.kind === "string") {
			return { _tag: "Lit", text: stringLiteral(this.string()) }
		}

		if (token?.kind === "number") {
			this.next()

			return { _tag: "Lit", text: numberText(Number(token.text)) }
		}

		if (this.accept("{")) {
			return { _tag: "Obj", members: this.list("}", () => this.member()) }
		}

		if (token?.kind === "ident" && token.text === "readonly" && this.is("[", 1)) {
			this.next()
			this.next()

			return { _tag: "Tuple", elements: this.list("]", () => this.tupleElement()) }
		}

		if (token?.kind === "ident") {
			return this.reference()
		}

		this.failed = true

		return placeholder
	}

	private entry(): Entry {
		const computed = this.accept("[")
		const name = this.peek(0)?.kind === "string" ? this.string() : this.next().text
		if (computed) {
			this.expect("]")
		}

		this.expect(":")

		return { name, value: this.expression() }
	}

	private primary(): Ex {
		const token = this.peek(0)
		if (token?.kind === "string") {
			return { _tag: "Str", value: this.string() }
		}

		if (token?.kind === "number") {
			this.next()

			return { _tag: "Num", value: Number(token.text) }
		}

		if (this.accept("{")) {
			return { _tag: "Obj", entries: this.list("}", () => this.entry()) }
		}

		if (this.accept("[")) {
			return { _tag: "Arr", elements: this.list("]", () => this.expression()) }
		}

		if (this.accept("(")) {
			this.expect(")")
			this.expect(":")

			const returns = this.type()
			this.expect("=>")

			return { _tag: "Arrow", body: this.expression(), returns }
		}

		if (token?.kind === "ident") {
			this.next()

			return { _tag: "Ident", name: token.text }
		}

		this.failed = true

		return { _tag: "Ident", name: "" }
	}

	expression(): Ex {
		let expression = this.primary()
		while (!this.failed) {
			if (this.accept(".")) {
				expression = { _tag: "Member", name: this.next().text, object: expression }
			} else if (this.accept("(")) {
				expression = {
					_tag: "Call",
					args: this.list(")", () => this.expression()),
					callee: expression
				}
			} else {
				break
			}
		}

		return expression
	}
}

/**
 * The whole source parsed by `parse`; none when it does not tokenize or holds more.
 */
const parseWith =
	<A>(parse: (parser: Parser) => A) =>
	(source: string): Option.Option<A> =>
		Option.flatMap(tokenize(source), (tokens) => {
			const parser = new Parser(tokens)
			const parsed = parse(parser)

			return parser.done() ? Option.some(parsed) : Option.none()
		})

const parseExpression = parseWith((parser) => parser.expression())

const parseType = parseWith((parser) => parser.type())

/**
 * A document: the group, indent and fill model of the formatter (`vp fmt` is `oxfmt`, a Prettier
 * port), reduced to the forms these definitions need.
 */
type Doc = string | readonly Doc[] | Node

/**
 * The document nodes. A conditional group prints the first of its states that fits flat, else the
 * last, broken (Prettier's `conditionalGroup`). An `ifBreak` prints `broken` when the group named by
 * `id`, or the enclosing one, is broken, and nothing otherwise.
 */
type Node =
	| { readonly _tag: "breakParent" }
	| { readonly _tag: "conditionalGroup"; readonly states: readonly [Doc, ...Doc[]] }
	| { readonly _tag: "fill"; readonly parts: readonly Doc[] }
	| {
			readonly _tag: "group"
			readonly brk: boolean
			readonly contents: Doc
			readonly id: Option.Option<symbol>
	  }
	| { readonly _tag: "ifBreak"; readonly broken: Doc; readonly id: Option.Option<symbol> }
	| { readonly _tag: "indent"; readonly contents: Doc }
	| { readonly _tag: "indentIfBreak"; readonly contents: Doc; readonly id: symbol }
	| { readonly _tag: "line"; readonly hard: boolean; readonly soft: boolean }

const isList = (doc: Doc): doc is readonly Doc[] => Arr.isArray(doc)

const line: Doc = { _tag: "line", hard: false, soft: false }

const softline: Doc = { _tag: "line", hard: false, soft: true }

const hardline: Doc = { _tag: "line", hard: true, soft: false }

const breakParent: Doc = { _tag: "breakParent" }

const indent = (contents: Doc): Doc => ({ _tag: "indent", contents })

/**
 * `broken` when the enclosing group is broken.
 */
const ifBreak = (broken: Doc): Doc => ({ _tag: "ifBreak", broken, id: Option.none() })

/**
 * `broken` when the group named `id` is broken.
 */
const ifGroupBreaks = (id: symbol, broken: Doc): Doc => ({
	_tag: "ifBreak",
	broken,
	id: Option.some(id)
})

const indentIfBreak = (contents: Doc, id: symbol): Doc => ({ _tag: "indentIfBreak", contents, id })

const join = (separator: Doc, docs: readonly Doc[]): readonly Doc[] =>
	Arr.flatMap(docs, (doc, index) => (index === 0 ? [doc] : [separator, doc]))

/**
 * Whether a doc holds a forced line break; a group that does is itself broken.
 */
const willBreak = (doc: Doc): boolean => {
	if (Predicate.isString(doc)) {
		return false
	}

	if (isList(doc)) {
		return Arr.some(doc, willBreak)
	}

	return Match.valueTags(doc, {
		breakParent: () => true,
		conditionalGroup: () => false,
		fill: (node) => Arr.some(node.parts, willBreak),
		group: (node) => node.brk,
		ifBreak: (node) => willBreak(node.broken),
		indent: (node) => willBreak(node.contents),
		indentIfBreak: (node) => willBreak(node.contents),
		line: (node) => node.hard
	})
}

/**
 * A group, broken when `brk` holds or its contents hold a forced line break, and named `id` when
 * an `ifBreak` or `indentIfBreak` reads its mode.
 */
const groupOf = (contents: Doc, brk: boolean, id: Option.Option<symbol>): Doc => ({
	_tag: "group",
	brk: brk || willBreak(contents),
	contents,
	id
})

const group = (contents: Doc): Doc => groupOf(contents, false, Option.none())

const conditionalGroup = (states: readonly [Doc, ...Doc[]]): Doc => ({
	_tag: "conditionalGroup",
	states
})

type Mode = "break" | "flat"

interface Command {
	readonly doc: Doc
	readonly indent: number
	readonly mode: Mode
}

interface Probe {
	readonly doc: Doc
	readonly mode: Mode
}

/**
 * The mode an `ifBreak` reads: the named group's, flat when that group has not printed yet, else
 * the enclosing mode.
 */
const modeOf = (
	id: Option.Option<symbol>,
	enclosing: Mode,
	modes: ReadonlyMap<symbol, Mode>
): Mode => Option.match(id, { onNone: () => enclosing, onSome: (key) => modes.get(key) ?? "flat" })

interface Spend {
	readonly mode: Mode
	readonly next: readonly Doc[]
	readonly width: number
}

/**
 * What measuring one doc does: answer, or spend `width` columns and continue into `next`.
 */
type Measure = "fits" | "overflow" | Spend

const spend = (mode: Mode, next: readonly Doc[], width: number): Spend => ({ mode, next, width })

const measure = (probe: Probe, modes: ReadonlyMap<symbol, Mode>, mustBeFlat: boolean): Measure => {
	const { doc, mode } = probe
	if (Predicate.isString(doc)) {
		return spend(mode, [], textWidth(doc))
	}

	if (isList(doc)) {
		return spend(mode, doc, 0)
	}

	return Match.valueTags(doc, {
		breakParent: () => spend(mode, [], 0),
		conditionalGroup: (node) =>
			spend(mode, [mode === "break" ? Arr.lastNonEmpty(node.states) : node.states[0]], 0),
		fill: (node) => spend(mode, node.parts, 0),
		group: (node): Measure => {
			if (mustBeFlat && node.brk) {
				return "overflow"
			}

			return spend(node.brk ? "break" : mode, [node.contents], 0)
		},
		ifBreak: (node) =>
			spend(mode, modeOf(node.id, mode, modes) === "break" ? [node.broken] : [], 0),
		indent: (node) => spend(mode, [node.contents], 0),
		indentIfBreak: (node) => spend(mode, [node.contents], 0),
		line: (node): Measure => {
			if (mode === "break" || node.hard) {
				return "fits"
			}

			return spend(mode, [], node.soft ? 0 : 1)
		}
	})
}

/**
 * Whether the doc, then the commands after it up to their first line break, fit in `width`.
 */
const fits = (
	start: Probe,
	rest: readonly Command[],
	width: number,
	modes: ReadonlyMap<symbol, Mode>,
	mustBeFlat: boolean
): boolean => {
	let remaining = width
	let restIndex = rest.length
	const stack: Probe[] = [start]
	while (remaining >= 0) {
		let probe = stack.pop()
		if (probe === undefined) {
			restIndex -= 1
			probe = rest[restIndex]
			if (probe === undefined) {
				return true
			}
		}

		const outcome = measure(probe, modes, mustBeFlat)
		if (outcome === "fits") {
			return true
		}

		if (outcome === "overflow") {
			return false
		}

		remaining -= outcome.width
		for (const doc of Arr.reverse(outcome.next)) {
			stack.push({ doc, mode: outcome.mode })
		}
	}

	return false
}

type GroupNode = Extract<Node, { readonly _tag: "group" }>

/**
 * Prints a doc at the formatter's width: a group is flat when it fits to the next line break the
 * layout emits, otherwise broken.
 */
class Printer {
	private column = 0
	private current = ""
	private readonly lines: string[] = []
	private readonly modes = new Map<symbol, Mode>()
	private remeasure = false
	private readonly stack: Command[] = []

	print(doc: Doc): string {
		this.stack.push({ doc, indent: 0, mode: "break" })
		let command = this.stack.pop()
		while (command !== undefined) {
			this.step(command)
			command = this.stack.pop()
		}

		this.lines.push(Str.trimEnd(this.current))

		return Arr.join(this.lines, "\n")
	}

	private emit(commands: readonly Command[]): void {
		for (const command of Arr.reverse(commands)) {
			this.stack.push(command)
		}
	}

	private text(text: string): void {
		this.current += text
		this.column += textWidth(text)
	}

	private newline(spaces: number): void {
		this.lines.push(Str.trimEnd(this.current))
		this.current = Str.repeat(spaces)(" ")
		this.column = spaces
	}

	private step(command: Command): void {
		const { doc } = command
		if (Predicate.isString(doc)) {
			this.text(doc)

			return
		}

		if (isList(doc)) {
			this.emit(Arr.map(doc, (child) => ({ ...command, doc: child })))

			return
		}

		Match.valueTags(doc, {
			breakParent: Function.constVoid,
			conditionalGroup: (node) => {
				this.conditionalGroup(node.states, command)
			},
			fill: (node) => {
				this.fill(node.parts, command)
			},
			group: (node) => {
				this.group(node, command)
			},
			ifBreak: (node) => {
				if (modeOf(node.id, command.mode, this.modes) === "break") {
					this.emit([{ ...command, doc: node.broken }])
				}
			},
			indent: (node) => {
				this.emit([{ ...command, doc: node.contents, indent: command.indent + 2 }])
			},
			indentIfBreak: (node) => {
				const extra = this.modes.get(node.id) === "break" ? 2 : 0
				this.emit([{ ...command, doc: node.contents, indent: command.indent + extra }])
			},
			line: (node) => {
				this.line(node, command)
			}
		})
	}

	private line(node: { readonly hard: boolean; readonly soft: boolean }, command: Command): void {
		if (command.mode === "flat" && !node.hard) {
			this.text(node.soft ? "" : " ")

			return
		}

		this.remeasure ||= command.mode === "flat"
		this.newline(command.indent)
	}

	/**
	 * A group inside a flat line stays as it is unless a line break printed since the last measure;
	 * otherwise it is measured again. A named group records the mode it printed in.
	 */
	private group(node: GroupNode, command: Command): void {
		const settled = command.mode === "flat" && !this.remeasure
		const chosen: Command = settled
			? { ...command, doc: node.contents, mode: node.brk ? "break" : "flat" }
			: this.choose(node, command)
		this.remeasure = false
		this.emit([chosen])
		if (Option.isSome(node.id)) {
			this.modes.set(node.id.value, chosen.mode)
		}
	}

	/**
	 * The command to print a group with: flat when it fits, else broken.
	 */
	private choose(node: GroupNode, command: Command): Command {
		const room = lineWidth - this.column
		const flat: Command = { ...command, doc: node.contents, mode: "flat" }

		return !node.brk && fits(flat, this.stack, room, this.modes, false)
			? flat
			: { ...command, doc: node.contents, mode: "break" }
	}

	/**
	 * A conditional group inside a flat line prints its first state flat unless a line break
	 * printed since the last measure; otherwise the first state that fits flat, else the last,
	 * broken.
	 */
	private conditionalGroup(states: readonly [Doc, ...Doc[]], command: Command): void {
		if (command.mode === "flat" && !this.remeasure) {
			this.emit([{ ...command, doc: states[0], mode: "flat" }])

			return
		}

		this.remeasure = false
		const room = lineWidth - this.column
		const chosen = Arr.findFirst(
			Arr.map(states, (state): Command => ({ ...command, doc: state, mode: "flat" })),
			(candidate) => fits(candidate, this.stack, room, this.modes, false)
		)
		this.emit([
			Option.getOrElse(chosen, (): Command => ({
				...command,
				doc: Arr.lastNonEmpty(states),
				mode: "break"
			}))
		])
	}

	/**
	 * Fills a line with as many parts as fit (Prettier's `fill`): [content, separator, content, ...].
	 */
	private fill(parts: readonly Doc[], command: Command): void {
		const [content, separator, second, ...more] = parts
		if (content === undefined) {
			return
		}

		const room = lineWidth - this.column
		const as = (doc: Doc, mode: Mode): Command => ({ ...command, doc, mode })
		const contentFits = fits(as(content, "flat"), [], room, this.modes, true)
		const contentMode = contentFits ? "flat" : "break"
		if (separator === undefined || second === undefined) {
			this.emit(
				separator === undefined
					? [as(content, contentMode)]
					: [as(content, contentMode), as(separator, contentMode)]
			)

			return
		}

		const rest = as({ _tag: "fill", parts: [second, ...more] }, command.mode)
		const pairFits = fits(as([content, separator, second], "flat"), [], room, this.modes, true)
		const separatorMode = pairFits ? "flat" : "break"
		this.emit([as(content, pairFits ? "flat" : contentMode), as(separator, separatorMode), rest])
	}
}

const printDoc = (doc: Doc): string => new Printer().print(doc)

const isObjectType = (type: Ty): boolean => type._tag === "Obj"

const isNullType = (type: Ty): boolean =>
	type._tag === "Ref" && type.args.length === 0 && type.path.length === 1 && type.path[0] === "null"

const keywords: ReadonlySet<string> = new Set([
	"any",
	"bigint",
	"boolean",
	"never",
	"null",
	"number",
	"object",
	"string",
	"symbol",
	"undefined",
	"unknown",
	"void"
])

/**
 * A named type other than a keyword, with or without type arguments.
 */
const isTypeReference = (type: Ty): boolean =>
	type._tag === "Ref" && !(type.path.length === 1 && keywords.has(type.path[0] ?? ""))

/**
 * An object type or a type reference with only `null` beside it hugs: `{ ... } | null`,
 * `ReadonlyArray<X> | null`. A keyword, literal or tuple beside `null` does not.
 */
const hugsUnion = (members: readonly Ty[]): boolean =>
	Arr.filter(members, isNullType).length === members.length - 1 &&
	Arr.some(members, (member) => isObjectType(member) || isTypeReference(member))

const isSimpleType = (type: Ty): boolean =>
	(type._tag === "Ref" && type.args.length === 0) || type._tag === "Lit"

const hugsType = (type: Ty): boolean =>
	isSimpleType(type) || isObjectType(type) || (type._tag === "Union" && hugsUnion(type.members))

/**
 * Where a type is printed decides whether a broken union indents under its parent.
 */
type TypeContext = "argument" | "element" | "optional" | "position"

type PrintType = (type: Ty, context: TypeContext) => Doc

/**
 * An intersection keeps its parentheses beside `|`.
 */
const unionMemberDoc = (member: Ty, print: PrintType): Doc =>
	member._tag === "Inter" ? ["(", print(member, "position"), ")"] : print(member, "position")

const unionDoc = (members: readonly Ty[], context: TypeContext, print: PrintType): Doc => {
	if (hugsUnion(members)) {
		return join(
			" | ",
			Arr.map(members, (member) => unionMemberDoc(member, print))
		)
	}

	const indents = context === "position" || context === "optional"
	const code: Doc = [
		ifBreak([indents ? line : "", "| "]),
		join(
			[line, "| "],
			Arr.map(members, (member) => indent(unionMemberDoc(member, print)))
		)
	]
	if (context === "optional") {
		return group([indent(code), softline])
	}

	return group(indents ? indent(code) : code)
}

const referenceDoc = (type: Extract<Ty, { readonly _tag: "Ref" }>, print: PrintType): Doc => {
	const name = Arr.join(type.path, ".")
	const [only] = type.args
	if (only === undefined) {
		return name
	}

	if (type.args.length === 1 && hugsType(only)) {
		return [name, "<", print(only, "argument"), ">"]
	}

	const args = Arr.map(type.args, (arg) => print(arg, "argument"))

	return [name, group(["<", indent([softline, join([",", line], args)]), softline, ">"])]
}

const memberDoc = (member: Member, print: PrintType): Doc => {
	const head = member.readonly ? "readonly " : ""
	if (member.index !== undefined) {
		const parameter = group([indent([softline, "x: ", print(member.index, "position")]), softline])

		return [head, "[", parameter, "]: ", print(member.type, "position")]
	}

	return [
		head,
		keyText(member.key),
		member.optional ? "?" : "",
		": ",
		print(member.type, "position")
	]
}

const objectTypeDoc = (members: readonly Member[], print: PrintType): Doc => {
	if (members.length === 0) {
		return "{}"
	}

	const docs = Arr.map(members, (member) => memberDoc(member, print))

	return group(["{", indent([line, join([";", line], docs)]), ifBreak(";"), line, "}"])
}

/**
 * A tuple element needs parentheses before `?` unless it is a name, a literal or an object type.
 */
const needsParentheses = (element: TupleElement): boolean =>
	element.optional && !["Lit", "Obj", "Ref"].includes(element.type._tag)

const elementDoc = (element: TupleElement, print: PrintType): Doc => {
	const wrapped = needsParentheses(element)
	const body = print(element.type, wrapped ? "optional" : "element")

	return [element.rest ? "..." : "", wrapped ? ["(", body, ")"] : body, element.optional ? "?" : ""]
}

const tupleDoc = (elements: readonly TupleElement[], print: PrintType): Doc => {
	if (elements.length === 0) {
		return "readonly []"
	}

	const docs = Arr.map(elements, (element) => elementDoc(element, print))

	return [
		"readonly ",
		group(["[", indent([softline, join([",", line], docs)]), ifBreak(","), softline, "]"])
	]
}

const typeDoc: PrintType = (type, context) =>
	Match.valueTags(type, {
		Inter: (inter) =>
			join(
				" & ",
				Arr.map(inter.members, (member) => typeDoc(member, "position"))
			),
		Lit: (literal) => literal.text,
		Obj: (object) => objectTypeDoc(object.members, typeDoc),
		Ref: (reference) => referenceDoc(reference, typeDoc),
		Tuple: (tuple) => tupleDoc(tuple.elements, typeDoc),
		Union: (union) => unionDoc(union.members, context, typeDoc)
	})

/**
 * A union opens on the `=` line, broken under it or hugging `null`. Any other type opens on that
 * line when it fits up to its first line break, otherwise under the `=` (the formatter's fluid
 * assignment layout).
 */
const typeAliasDoc = (name: string, type: Ty): Doc => {
	const head = `export type ${name} =`
	if (type._tag === "Union") {
		return [head, " ", typeDoc(type, "position")]
	}

	const id = Symbol("type-alias")

	return group([
		head,
		groupOf(indent(line), false, Option.some(id)),
		indentIfBreak(typeDoc(type, "position"), id)
	])
}

/**
 * Prints an expression in the formatter's layout.
 */
type PrintEx = (ex: Ex) => Doc

const isPath = (ex: Ex): boolean =>
	ex._tag === "Ident" || (ex._tag === "Member" && isPath(ex.object))

const isMemberPath = (ex: Ex): boolean => ex._tag === "Member" && isPath(ex)

const pathText = (ex: Ex): string => {
	if (ex._tag === "Ident") {
		return ex.name
	}

	return ex._tag === "Member" ? `${pathText(ex.object)}.${ex.name}` : ""
}

const isShortArgument = (ex: Ex): boolean =>
	Match.valueTags(ex, {
		Arr: () => false,
		Arrow: () => false,
		Call: () => false,
		Ident: (ident) => ident.name.length <= lineWidth / 4,
		Member: () => false,
		Num: () => true,
		Obj: () => false,
		Str: (string) => textWidth(stringLiteral(string.value)) <= lineWidth / 4
	})

/**
 * A call chain whose calls take nothing or one short argument: moving it under the `=` or `:` is
 * the only way to break it.
 */
const isPoorlyBreakableCall = (ex: Ex): boolean => {
	if (ex._tag === "Member") {
		return isPoorlyBreakableCall(ex.object)
	}

	if (ex._tag === "Call") {
		const [only] = ex.args
		const short =
			ex.args.length === 0 || (ex.args.length === 1 && only !== undefined && isShortArgument(only))

		return short && isPoorlyBreakableCall(ex.callee)
	}

	return ex._tag === "Ident"
}

type Layout = "break-after-operator" | "fluid" | "never-break-after-operator"

/**
 * A key shorter than five columns never moves its value under it (Prettier's short-key rule).
 */
const layoutOf = (value: Ex, shortKey: boolean): Layout => {
	if (shortKey) {
		return "never-break-after-operator"
	}

	if (value._tag === "Str" || isMemberPath(value)) {
		return "break-after-operator"
	}

	const literal =
		(value._tag === "Num" && value.value >= 0) ||
		(value._tag === "Ident" && (value.name === "true" || value.name === "false"))
	if (literal) {
		return "never-break-after-operator"
	}

	return value._tag === "Call" && isPoorlyBreakableCall(value) ? "break-after-operator" : "fluid"
}

/**
 * `left operator value` in the formatter's assignment layouts (property values and declarations).
 */
const assignment = (
	left: Doc,
	operator: string,
	value: Ex,
	shortKey: boolean,
	print: PrintEx
): Doc => {
	const layout = layoutOf(value, shortKey)
	const right = print(value)
	if (layout === "break-after-operator") {
		return group([group(left), operator, group(indent([line, right]))])
	}

	if (layout === "never-break-after-operator") {
		return group([group(left), operator, " ", right])
	}

	const id = Symbol("assignment")

	return group([
		group(left),
		operator,
		groupOf(indent(line), false, Option.some(id)),
		indentIfBreak(right, id)
	])
}

const entryDoc = (entry: Entry, print: PrintEx): Doc => {
	const key = keyText(entry.name)

	return assignment(key, ":", entry.value, textWidth(key) < 5, print)
}

const byName = Order.mapInput(Order.String, (entry: Entry) => entry.name)

const objectDoc = (entries: readonly Entry[], print: PrintEx): Doc => {
	if (entries.length === 0) {
		return "{}"
	}

	const docs = Arr.map(Arr.sort(entries, byName), (entry) => entryDoc(entry, print))

	return group(["{", indent([line, join([",", line], docs)]), ifBreak(","), line, "}"])
}

const isNumber = (ex: Ex): boolean => ex._tag === "Num"

const entryCount = (ex: Ex): number =>
	Match.valueTags(ex, {
		Arr: (array) => array.elements.length,
		Arrow: () => 0,
		Call: () => 0,
		Ident: () => 0,
		Member: () => 0,
		Num: () => 0,
		Obj: (object) => object.entries.length,
		Str: () => 0
	})

/**
 * Two or more object literals, or two or more array literals, with more than one entry each.
 */
const alwaysBroken = (elements: readonly Ex[]): boolean => {
	const [first] = elements

	return (
		elements.length > 1 &&
		first !== undefined &&
		(first._tag === "Obj" || first._tag === "Arr") &&
		Arr.every(elements, (element) => element._tag === first._tag && entryCount(element) > 1)
	)
}

const arrayDoc = (elements: readonly Ex[], print: PrintEx): Doc => {
	if (elements.length === 0) {
		return "[]"
	}

	const docs = Arr.map(elements, (element) => print(element))
	if (elements.length > 1 && Arr.every(elements, isNumber)) {
		const id = Symbol("array")
		const last = docs.length - 1
		const parts = join(
			line,
			Arr.map(docs, (doc, index) => [doc, index === last ? ifGroupBreaks(id, ",") : ","])
		)

		return groupOf(
			["[", indent([softline, { _tag: "fill", parts }]), softline, "]"],
			false,
			Option.some(id)
		)
	}

	return groupOf(
		["[", indent([softline, join([",", line], docs)]), ifBreak(","), softline, "]"],
		alwaysBroken(elements),
		Option.none()
	)
}

const arrowDoc = (ex: Extract<Ex, { readonly _tag: "Arrow" }>, print: PrintEx): Doc =>
	group(["(): ", typeDoc(ex.returns, "position"), " =>", group(indent([line, print(ex.body)]))])

/**
 * A last argument opens on the call's line when it is a non-empty object or array.
 */
const hugsLast = (args: readonly Ex[]): boolean => {
	const last = args.at(-1)
	const before = args.at(-2)
	if (last === undefined || entryCount(last) === 0) {
		return false
	}

	if (last._tag !== "Obj" && last._tag !== "Arr") {
		return false
	}

	if (before?._tag === last._tag) {
		return false
	}

	return !(args.length > 1 && last._tag === "Arr" && Arr.every(last.elements, isNumber))
}

/**
 * Two or more arguments where one is a call taking an arrow function, as in
 * `Schema.Record(Schema.String, Schema.suspend(() => X))`: the formatter always breaks them out
 * (Prettier's function-composition arguments).
 */
const isFunctionComposition = (args: readonly Ex[]): boolean =>
	args.length > 1 &&
	Arr.some(
		args,
		(arg) => arg._tag === "Call" && Arr.some(arg.args, (inner) => inner._tag === "Arrow")
	)

const argumentsDoc = (args: readonly Ex[], print: PrintEx): Doc => {
	if (args.length === 0) {
		return "()"
	}

	const docs = Arr.map(args, (arg) => print(arg))
	const allBroken = groupOf(
		["(", indent([line, join([",", line], docs)]), ifBreak(","), line, ")"],
		true,
		Option.none()
	)
	if (isFunctionComposition(args) || Arr.some(docs.slice(0, -1), willBreak)) {
		return allBroken
	}

	if (!hugsLast(args)) {
		return group(["(", indent([softline, join([",", line], docs)]), ifBreak(","), softline, ")"])
	}

	const last = docs.at(-1) ?? ""
	const leading = Arr.flatMap(docs.slice(0, -1), (doc) => [doc, ", "])

	return [
		willBreak(last) ? breakParent : "",
		conditionalGroup([
			["(", ...leading, last, ")"],
			["(", ...leading, groupOf(last, true, Option.none()), ")"],
			allBroken
		])
	]
}

/**
 * A call argument is simple when it is a literal, a path, or a call, object or array of simple
 * values with no call below the first level.
 */
const isSimpleArgument = (ex: Ex, depth: number): boolean =>
	Match.valueTags(ex, {
		Arr: (array) => Arr.every(array.elements, (element) => isSimpleArgument(element, depth + 1)),
		Arrow: () => false,
		Call: (call) =>
			depth === 0 &&
			isSimpleArgument(call.callee, depth) &&
			Arr.every(call.args, (arg) => isSimpleArgument(arg, depth + 1)),
		Ident: () => true,
		Member: (member) => isSimpleArgument(member.object, depth),
		Num: () => true,
		Obj: (object) => Arr.every(object.entries, (entry) => isSimpleArgument(entry.value, depth + 1)),
		Str: () => true
	})

type ChainNode =
	| { readonly _tag: "call"; readonly args: readonly Ex[] }
	| { readonly _tag: "head"; readonly ex: Ex }
	| { readonly _tag: "member"; readonly name: string }

const isMemberish = (ex: Ex): boolean => ex._tag === "Member" || ex._tag === "Call"

/**
 * The head, then each `.name` and call, as Prettier's member chain reads them.
 */
const chainNodes = (ex: Ex): readonly ChainNode[] => {
	if (ex._tag === "Call" && isMemberish(ex.callee)) {
		return [...chainNodes(ex.callee), { _tag: "call", args: ex.args }]
	}

	if (ex._tag === "Member") {
		return [...chainNodes(ex.object), { _tag: "member", name: ex.name }]
	}

	return [{ _tag: "head", ex }]
}

const chainNodeDoc = (node: ChainNode, print: PrintEx): Doc =>
	Match.valueTags(node, {
		call: (call) => argumentsDoc(call.args, print),
		head: (head) => print(head.ex),
		member: (member) => `.${member.name}`
	})

const factoryName = regex("^[A-Z]|^[$_]+$", "u")

const isFactory = (name: string): boolean => factoryName.test(name)

/**
 * How many nodes after the head stay in the first group: the calls that follow it, then members
 * that only lead to the first call.
 */
const leadingCount = (tail: readonly ChainNode[], headIsCall: boolean): number => {
	let count = Option.getOrElse(
		Arr.findFirstIndex(tail, (node) => node._tag !== "call"),
		() => tail.length
	)
	if (headIsCall) {
		return count
	}

	while (tail[count]?._tag === "member" && tail[count + 1]?._tag === "member") {
		count += 1
	}

	return count
}

/**
 * Prettier's member-chain groups: the head with its leading members, then one group per
 * `.name(args)`.
 */
const chainGroups = (nodes: readonly ChainNode[]): readonly (readonly ChainNode[])[] => {
	const [head, ...tail] = nodes
	if (head === undefined) {
		return []
	}

	const count = leadingCount(tail, head._tag === "head" && head.ex._tag === "Call")
	const groups: ChainNode[][] = [[head, ...tail.slice(0, count)]]
	let seenCall = false
	let current: ChainNode[] = []
	for (const node of tail.slice(count)) {
		if (seenCall && node._tag === "member") {
			groups.push(current)
			current = []
			seenCall = false
		}

		seenCall ||= node._tag === "call"
		current.push(node)
	}

	return current.length > 0 ? [...groups, current] : groups
}

/**
 * The first call stays on the head's line when the head is a capitalized name, as in `Schema.X`.
 */
const mergesFirstCall = (groups: readonly (readonly ChainNode[])[]): boolean => {
	const [first, second] = groups
	if (first === undefined || second === undefined) {
		return false
	}

	const last = first.at(-1)
	if (first.length === 1) {
		return last?._tag === "head" && last.ex._tag === "Ident" && isFactory(last.ex.name)
	}

	return last?._tag === "member" && isFactory(last.name)
}

const callDoc = (ex: Extract<Ex, { readonly _tag: "Call" }>, print: PrintEx): Doc => {
	if (!isMemberish(ex.callee)) {
		return [print(ex.callee), argumentsDoc(ex.args, print)]
	}

	const nodes = chainNodes(ex)
	const groups = chainGroups(nodes)
	const merge = mergesFirstCall(groups)
	const printedGroups = Arr.map(groups, (chain) =>
		Arr.map(chain, (node) => chainNodeDoc(node, print))
	)
	if (groups.length <= (merge ? 3 : 2)) {
		return group(printedGroups)
	}

	const [first = [], ...rest] = printedGroups
	const expanded: Doc = [
		first,
		merge ? rest.slice(0, 1) : [],
		indent([hardline, join(hardline, rest.slice(merge ? 1 : 0))])
	]
	const calls = Arr.filter(nodes, (node) => node._tag === "call")
	const complex =
		calls.length > 2 &&
		Arr.some(calls, (node) => !Arr.every(node.args, (arg) => isSimpleArgument(arg, 0)))
	if (complex || Arr.some(printedGroups.slice(0, -1), willBreak)) {
		return group(expanded)
	}

	return [willBreak(printedGroups) ? breakParent : "", conditionalGroup([printedGroups, expanded])]
}

const exDoc: PrintEx = (ex) =>
	Match.valueTags(ex, {
		Arr: (array) => arrayDoc(array.elements, exDoc),
		Arrow: (arrow) => arrowDoc(arrow, exDoc),
		Call: (call) => callDoc(call, exDoc),
		Ident: (ident) => ident.name,
		Member: (member) =>
			isPath(member) ? pathText(member) : [exDoc(member.object), ".", member.name],
		Num: (number) => numberText(number.value),
		Obj: (object) => objectDoc(object.entries, exDoc),
		Str: (string) => stringLiteral(string.value)
	})

/**
 * One definition of the module: its export name, its schema value and, when the module exports
 * its type, the type.
 */
interface Definition {
	readonly name: string
	readonly runtime: Ex
	readonly type: Option.Option<Ty>
}

const unprintable = () => DomainEmitError.make({ reason: "unprintable-code" })

const definitionOf = (
	name: string,
	code: SchemaRepresentation.Code
): Effect.Effect<Definition, DomainEmitError> =>
	Option.match(parseExpression(code.runtime), {
		onNone: () => Effect.fail(unprintable()),
		onSome: (runtime) => Effect.succeed({ name, runtime, type: parseType(code.Type) })
	})

const typeNames = (type: Ty): readonly string[] =>
	Match.valueTags(type, {
		Inter: (inter) => Arr.flatMap(inter.members, typeNames),
		Lit: () => [],
		Obj: (object) =>
			Arr.flatMap(object.members, (member) => [
				...typeNames(member.type),
				...(member.index === undefined ? [] : typeNames(member.index))
			]),
		Ref: (reference) => [
			...(reference.path.length === 1 ? reference.path : []),
			...Arr.flatMap(reference.args, typeNames)
		],
		Tuple: (tuple) => Arr.flatMap(tuple.elements, (element) => typeNames(element.type)),
		Union: (union) => Arr.flatMap(union.members, typeNames)
	})

/**
 * Names a `Schema.Codec<T>` annotation in a thunk of `Schema.suspend` reads as a type.
 */
const suspendedTypes = (ex: Ex): readonly string[] =>
	Match.valueTags(ex, {
		Arr: (array) => Arr.flatMap(array.elements, suspendedTypes),
		Arrow: (arrow) => [...typeNames(arrow.returns), ...suspendedTypes(arrow.body)],
		Call: (call) => Arr.flatMap([call.callee, ...call.args], suspendedTypes),
		Ident: () => [],
		Member: (member) => suspendedTypes(member.object),
		Num: () => [],
		Obj: (object) => Arr.flatMap(object.entries, (entry) => suspendedTypes(entry.value)),
		Str: () => []
	})

/**
 * A definition keeps its `export type` when a `Schema.Codec<T>` annotation names it, directly or
 * through the type of one that does; a recursive definition always does.
 */
const withTypes = (
	definitions: readonly Definition[],
	recursives: ReadonlySet<string>
): Effect.Effect<readonly Definition[], DomainEmitError> =>
	Effect.gen(function* keep() {
		const known = new Map(
			Arr.map(definitions, (definition) => [definition.name, definition] as const)
		)
		const needed = new Set<string>()
		const pending = [
			...recursives,
			...Arr.flatMap(definitions, (definition) => suspendedTypes(definition.runtime))
		]
		for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
			const definition = known.get(name)
			if (definition === undefined || needed.has(name)) {
				continue
			}

			needed.add(name)
			if (Option.isNone(definition.type)) {
				return yield* unprintable()
			}

			for (const named of typeNames(definition.type.value)) {
				pending.push(named)
			}
		}

		return Arr.map(definitions, (definition) => ({
			...definition,
			type: needed.has(definition.name) ? definition.type : Option.none()
		}))
	})

/**
 * Names a value reads when the module runs; the thunk of `Schema.suspend` runs later.
 */
const dependenciesOf = (ex: Ex, names: ReadonlySet<string>): readonly string[] =>
	Match.valueTags(ex, {
		Arr: (array) => Arr.flatMap(array.elements, (element) => dependenciesOf(element, names)),
		Arrow: () => [],
		Call: (call) => Arr.flatMap([call.callee, ...call.args], (part) => dependenciesOf(part, names)),
		Ident: (ident) => (names.has(ident.name) ? [ident.name] : []),
		Member: (member) => dependenciesOf(member.object, names),
		Num: () => [],
		Obj: (object) => Arr.flatMap(object.entries, (entry) => dependenciesOf(entry.value, names)),
		Str: () => []
	})

/**
 * Definitions in name order, each after the names it reads; `undefined` on a cycle.
 */
const orderOf = (
	definitions: ReadonlyMap<string, Definition>
): readonly Definition[] | undefined => {
	const names = new Set(definitions.keys())
	const done = new Set<string>()
	const active = new Set<string>()
	const ordered: Definition[] = []
	const visit = (name: string): boolean => {
		const definition = definitions.get(name)
		if (definition === undefined || done.has(name)) {
			return true
		}

		if (active.has(name)) {
			return false
		}

		active.add(name)

		const reads = Arr.sort(Arr.dedupe(dependenciesOf(definition.runtime, names)), Order.String)
		const acyclic = Arr.every(reads, (read) => visit(read))
		active.delete(name)
		done.add(name)
		ordered.push(definition)

		return acyclic
	}

	return Arr.every(Arr.sort(names, Order.String), (name) => visit(name)) ? ordered : undefined
}

/**
 * A type and its value share one name (the plan imports the value name, and `Schema.Codec<T>`
 * reads the type), which TypeScript merges but the plain `no-redeclare` rule reports.
 */
const typeRedeclaration =
	"// oxlint-disable-next-line no-redeclare -- a type and its schema value share one name"

const statementsOf = (definition: Definition): readonly string[] => {
	const constant = printDoc([
		assignment(["export const ", definition.name], " =", definition.runtime, false, exDoc),
		";"
	])

	return Option.match(definition.type, {
		onNone: () => [constant],
		onSome: (type) => [
			`${typeRedeclaration}\n${printDoc([typeAliasDoc(definition.name, type), ";"])}`,
			constant
		]
	})
}

const multiDocumentOf = (
	definitions: ReadonlyMap<string, Json>
): Effect.Effect<JsonSchema.MultiDocument<"draft-2020-12">, DomainEmitError> =>
	Effect.gen(function* collect() {
		const keys = Arr.sort([...definitions.keys()], Order.String)
		const entries: [string, JsonSchema.JsonSchema][] = []
		for (const key of keys) {
			const node = definitions.get(key)
			if (!Predicate.isObject(node)) {
				return yield* DomainEmitError.make({ reason: "unsupported-definition" })
			}

			entries.push([key, node])
		}

		const [first, ...rest] = Arr.map(keys, (key) => ({
			$ref: JsonPointer.formatUriFragment(["$defs", key])
		}))
		if (first === undefined) {
			return yield* DomainEmitError.make({ reason: "unsupported-definition" })
		}

		return {
			definitions: Record.fromEntries(entries),
			dialect: "draft-2020-12",
			schemas: [first, ...rest]
		}
	})

type CheckAnnotation =
	SchemaRepresentation.CheckRepresentationAnnotation<SchemaRepresentation.Representation>

type Write = (
	node: SchemaRepresentation.Representation
) => Option.Option<SchemaRepresentation.Representation>

const writtenAll = (
	nodes: ReadonlyArray<SchemaRepresentation.Representation>,
	write: Write
): Option.Option<ReadonlyArray<SchemaRepresentation.Representation>> =>
	Option.all(Arr.map(nodes, write))

const writtenAnnotation = (
	annotation: CheckAnnotation | undefined,
	write: Write
): Option.Option<CheckAnnotation | undefined> =>
	annotation?.schemas === undefined
		? Option.some(annotation)
		: Option.map(writtenAll(annotation.schemas, write), (schemas) => ({ ...annotation, schemas }))

const writtenCheck =
	(write: Write) =>
	(check: SchemaRepresentation.Check): Option.Option<SchemaRepresentation.Check> =>
		Option.flatMap(
			writtenAnnotation(check.representation, write),
			(representation): Option.Option<SchemaRepresentation.Check> =>
				check._tag === "Filter"
					? Option.some({ ...check, representation })
					: Option.map(Option.all(Arr.map(check.checks, writtenCheck(write))), (checks) => ({
							...check,
							checks,
							representation
						}))
		)

type Content = SchemaRepresentation.String["content"]

const writtenContent = (content: Content, write: Write): Option.Option<Content> =>
	content?.schema === undefined
		? Option.some(content)
		: Option.map(write(content.schema), (schema) => ({ ...content, schema }))

const writtenChecks = <A extends { readonly checks: ReadonlyArray<SchemaRepresentation.Check> }>(
	node: A,
	write: Write
): Option.Option<A> =>
	Option.map(Option.all(Arr.map(node.checks, writtenCheck(write))), (checks) => ({
		...node,
		checks
	}))

/**
 * Every node of a representation with each reference outside `names` replaced by what it names,
 * written out again; none when a reference is met again while it is being written out (a cycle
 * no name closes). `expanding` holds the references being written out on the current path.
 */
const writtenOut = (
	references: SchemaRepresentation.References,
	names: ReadonlySet<string>,
	expanding: ReadonlySet<string>
): Write => {
	const write: Write = (node) =>
		Match.valueTags(node, {
			Any: (keyword) => writtenChecks(keyword, write),
			Arrays: (arrays) =>
				Option.flatMap(
					Option.all({
						elements: Option.all(
							Arr.map(arrays.elements, (element) =>
								Option.map(write(element.type), (type) => ({ ...element, type }))
							)
						),
						rest: writtenAll(arrays.rest, write)
					}),
					({ elements, rest }) => writtenChecks({ ...arrays, elements, rest }, write)
				),
			BigInt: (keyword) => writtenChecks(keyword, write),
			Boolean: (keyword) => writtenChecks(keyword, write),
			Declaration: (declaration) =>
				Option.flatMap(writtenAll(declaration.typeParameters, write), (typeParameters) =>
					writtenChecks({ ...declaration, typeParameters }, write)
				),
			Enum: (keyword) => writtenChecks(keyword, write),
			Literal: (keyword) => writtenChecks(keyword, write),
			Never: (keyword) => writtenChecks(keyword, write),
			Null: (keyword) => writtenChecks(keyword, write),
			Number: (keyword) => writtenChecks(keyword, write),
			ObjectKeyword: (keyword) => writtenChecks(keyword, write),
			Objects: (objects) =>
				Option.flatMap(
					Option.all({
						indexSignatures: Option.all(
							Arr.map(objects.indexSignatures, (index) =>
								Option.all({ parameter: write(index.parameter), type: write(index.type) })
							)
						),
						propertySignatures: Option.all(
							Arr.map(objects.propertySignatures, (property) =>
								Option.map(write(property.type), (type) => ({ ...property, type }))
							)
						)
					}),
					({ indexSignatures, propertySignatures }) =>
						writtenChecks({ ...objects, indexSignatures, propertySignatures }, write)
				),
			Reference: (reference) =>
				names.has(reference.$ref)
					? Option.some(reference)
					: Option.flatMap(
							Option.filter(
								Record.get<string, SchemaRepresentation.Representation>(references, reference.$ref),
								() => !expanding.has(reference.$ref)
							),
							writtenOut(references, names, new Set([...expanding, reference.$ref]))
						),
			String: (keyword) =>
				Option.flatMap(writtenContent(keyword.content, write), (content) =>
					writtenChecks({ ...keyword, content }, write)
				),
			Suspend: (suspend) => Option.map(write(suspend.thunk), (thunk) => ({ ...suspend, thunk })),
			Symbol: (keyword) => writtenChecks(keyword, write),
			TemplateLiteral: (template) =>
				Option.flatMap(writtenAll(template.parts, write), (parts) =>
					writtenChecks({ ...template, parts }, write)
				),
			Undefined: (keyword) => writtenChecks(keyword, write),
			Union: (union) =>
				Option.flatMap(writtenAll(union.types, write), (types) =>
					writtenChecks({ ...union, types }, write)
				),
			UniqueSymbol: (keyword) => writtenChecks(keyword, write),
			Unknown: (keyword) => writtenChecks(keyword, write),
			Void: (keyword) => writtenChecks(keyword, write)
		})

	return write
}

/**
 * The document with only the copy's definitions as references. `toRepresentations` names every
 * definition by its `identifier`, and also names a recursive node that has none when its walk
 * closes the node's cycle there, before it meets a definition on that cycle (`Suspend_`). That is
 * a definition the importer reduces to a bare reference, an alias: the importer gives it its
 * target's schema under the alias's identifier, sharing the target's nodes, so a walk that reaches
 * the alias first enters the target's recursion at the anonymous `Schema.suspend` that closes it.
 * Which node closes a cycle is the walk's order, not the schema's: each such reference is written
 * out where it is read, which is the document a walk reaching the target first gives. Every cycle
 * of the import passes through a definition's own node, so writing out ends.
 */
const definitionsOnly = (
	document: SchemaRepresentation.MultiDocument,
	names: ReadonlySet<string>
): Effect.Effect<SchemaRepresentation.MultiDocument, DomainEmitError> => {
	const write = writtenOut(document.references, names, new Set())

	return Effect.mapError(
		Effect.fromOption(
			Option.all({
				references: Option.all(
					Record.map(
						Record.filter(document.references, (_, name) => names.has(name)),
						write
					)
				),
				representations: Option.all(Arr.map(document.representations, write))
			})
		),
		() => DomainEmitError.make({ reason: "reference-cycle" })
	)
}

const importCode = (
	multi: JsonSchema.MultiDocument<"draft-2020-12">,
	names: ReadonlySet<string>
): Effect.Effect<SchemaRepresentation.CodeDocument, DomainEmitError> =>
	Effect.gen(function* code() {
		const imported = yield* Effect.try({
			catch: () => DomainEmitError.make({ reason: "import-failed" }),
			try: () => {
				const [first, ...rest] = importSchemas(multi)

				return SchemaRepresentation.toRepresentations([
					first.ast,
					...Arr.map(rest, (schema) => schema.ast)
				])
			}
		})
		const document = yield* definitionsOnly(imported, names)

		return yield* Effect.try({
			catch: () => DomainEmitError.make({ reason: "import-failed" }),
			try: () => SchemaRepresentation.toCodeDocument(document)
		})
	})

/**
 * Subschema positions of the code-generation copy (normalize/schemas.ts `copyPositions`).
 */
const subschemaOne: ReadonlySet<string> = new Set([
	"additionalProperties",
	"contains",
	"contentSchema",
	"else",
	"if",
	"items",
	"not",
	"propertyNames",
	"then",
	"unevaluatedItems",
	"unevaluatedProperties"
])

const subschemaList: ReadonlySet<string> = new Set(["allOf", "anyOf", "oneOf", "prefixItems"])

const subschemaMap: ReadonlySet<string> = new Set([
	"dependentSchemas",
	"patternProperties",
	"properties"
])

interface JsonNode {
	readonly [key: string]: Json
}

const isNode = (json: Json): json is JsonNode => Predicate.isObject(json) && !Arr.isArray(json)

/**
 * Rebuilds a schema: each node's subschemas first, then `visit` rewrites the node.
 */
const mapSchema = (node: Json, visit: (node: JsonNode) => JsonNode): Json => {
	if (!isNode(node)) {
		return node
	}

	const child = (value: Json): Json => mapSchema(value, visit)
	const entries = Arr.map(Record.toEntries(node), ([key, value]): [string, Json] => {
		if (subschemaOne.has(key)) {
			return [key, child(value)]
		}

		if (subschemaList.has(key) && Arr.isArray<Json>(value)) {
			return [key, Arr.map(value, (item) => child(item))]
		}

		if (subschemaMap.has(key) && isNode(value)) {
			return [
				key,
				Record.fromEntries(
					Arr.map(Record.toEntries(value), ([name, item]) => [name, child(item)] as const)
				)
			]
		}

		return [key, value]
	})

	return visit(Record.fromEntries(entries))
}

/**
 * `additionalProperties: false` beside declared properties closes an object, but Effect's importer
 * reads it as a struct whose decoder strips an undeclared key under the default parse options the
 * runtime checks with. The same closure as a `propertyNames` naming the declared properties
 * imports as an open struct checked by `Schema.isPropertyNames`, which rejects the key (SCH-13).
 * An existing `propertyNames` stays beside the names in an `allOf`. A closed object with no
 * declared property already imports as a record of `Never`; beside `patternProperties` the
 * validation copy has opened the object (SCH-15).
 */
const closedNode = (node: JsonNode): JsonNode => {
	const { additionalProperties, patternProperties, properties, propertyNames: existing } = node
	const names =
		properties !== undefined && isNode(properties) ? Record.keys<string, Json>(properties) : []
	if (additionalProperties !== false || names.length === 0 || patternProperties !== undefined) {
		return node
	}

	const declared: Json = { enum: names }
	const propertyNames = existing === undefined ? declared : { allOf: [existing, declared] }

	return Record.fromEntries([
		...Arr.filter(
			Record.toEntries(node),
			([key]) => key !== "additionalProperties" && key !== "propertyNames"
		),
		["propertyNames", propertyNames] as const
	])
}

/**
 * The node with every `#/$defs/<key>` reference renamed to `#/$defs/<identifier>`; none when a
 * reference names a key outside the copy (the importer would have failed on it).
 */
const rekeyedNode = (node: Json, identifiers: ReadonlyMap<string, string>): Option.Option<Json> => {
	const dangling: string[] = []
	const ofRef = (ref: string): string => {
		const [defs, key, ...rest] = JsonPointer.parseUriFragment(ref) ?? []
		const identifier = key === undefined ? undefined : identifiers.get(key)
		if (defs !== "$defs" || rest.length > 0) {
			return ref
		}

		if (identifier === undefined) {
			dangling.push(ref)

			return ref
		}

		return JsonPointer.formatUriFragment(["$defs", identifier])
	}
	const rekeyed = mapSchema(node, (current) => {
		const { $ref: ref } = current

		return Predicate.isString(ref) ? { ...current, $ref: ofRef(ref) } : current
	})

	return dangling.length === 0 ? Option.some(rekeyed) : Option.none()
}

/**
 * The copy under its export names, every reference renamed with it.
 */
const rekeyedCopy = (
	copy: ReadonlyMap<string, Json>,
	identifiers: ReadonlyMap<string, SafeIdentifierValue>
): Effect.Effect<ReadonlyMap<string, Json>, DomainEmitError> =>
	Effect.gen(function* rekey() {
		const names = new Map<string, string>()
		for (const key of copy.keys()) {
			const identifier = identifiers.get(key)
			if (identifier === undefined) {
				return yield* DomainEmitError.make({ reason: "identifier-mismatch" })
			}

			names.set(key, identifier)
		}

		if (new Set(names.values()).size !== names.size) {
			return yield* DomainEmitError.make({ reason: "identifier-mismatch" })
		}

		const rekeyed = new Map<string, Json>()
		for (const [key, node] of copy) {
			const renamed = rekeyedNode(node, names)
			if (Option.isNone(renamed)) {
				return yield* DomainEmitError.make({ reason: "import-failed" })
			}

			rekeyed.set(names.get(key) ?? key, renamed.value)
		}

		return rekeyed
	})

/**
 * Effect's code names its definitions with `sanitizeJavaScriptIdentifier` and reserves `Schema`;
 * every name it exports must be the map's name, or cli modules import what is not exported.
 */
const sameNames = (
	code: SchemaRepresentation.CodeDocument,
	expected: ReadonlyMap<string, Json>
): boolean => {
	const exported = [
		...Arr.map(code.references.nonRecursives, (entry) => entry.$ref),
		...Record.keys(code.references.recursives)
	]

	return (
		exported.length === expected.size &&
		new Set(exported).size === exported.length &&
		Arr.every(exported, (name) => expected.has(name))
	)
}

const modulePath = "src/domain/schemas.ts"

const emptyModule = "export {};\n"

/**
 * Emits `domain/schemas.ts` (design 3.5, 3.6, units EM-2, S1): the code-generation copy of
 * `roots` (examples and defaults removed, properties sorted, every closed object's declared names
 * as its `propertyNames`) imported through
 * `SchemaRepresentation.fromJsonSchemaMultiDocument` and printed from `toCodeDocument`, one
 * `export const` per definition after the names it reads, and one `export type` before each
 * definition a `Schema.Codec<T>` annotation of `Schema.suspend` names (every recursive one).
 *
 * `identifiers` is the names plan's map (`domainIdentifiers`). The copy is rekeyed to it, with its
 * references, before import, so every export and its `identifier` annotation carry the folded
 * name, not the schema key; an export Effect names differently fails `identifier-mismatch`.
 * `limits` bounds the walk that builds the copy.
 */
export const emitDomainSchemas = (
	validation: ReadonlyMap<string, Json>,
	roots: readonly string[],
	identifiers: ReadonlyMap<string, SafeIdentifierValue>,
	limits: SchemaLimits
): Effect.Effect<EmittedFile, DomainEmitError | SchemaBudgetExceeded> =>
	Effect.gen(function* emit() {
		const copy = yield* codeGenerationCopy(validation, roots, limits)
		if (copy.size === 0) {
			return { content: emptyModule, path: modulePath }
		}

		const closed = new Map(
			Arr.map(Arr.fromIterable(copy), ([key, node]) => [key, mapSchema(node, closedNode)] as const)
		)
		const rekeyed = yield* rekeyedCopy(closed, identifiers)
		const multi = yield* multiDocumentOf(rekeyed)
		const code = yield* importCode(multi, new Set(rekeyed.keys()))
		if (code.artifacts.length > 0) {
			return yield* DomainEmitError.make({ reason: "unsupported-artifact" })
		}

		if (!sameNames(code, rekeyed)) {
			return yield* DomainEmitError.make({ reason: "identifier-mismatch" })
		}

		const sources: ReadonlyArray<readonly [string, SchemaRepresentation.Code]> = [
			...Arr.map(code.references.nonRecursives, (entry) => [entry.$ref, entry.code] as const),
			...Record.toEntries(code.references.recursives)
		]
		const parsed = yield* Effect.forEach(sources, ([name, entry]) => definitionOf(name, entry))
		const typed = yield* withTypes(parsed, new Set(Record.keys(code.references.recursives)))
		const ordered = orderOf(
			new Map(Arr.map(typed, (definition) => [definition.name, definition] as const))
		)
		if (ordered === undefined) {
			return yield* DomainEmitError.make({ reason: "reference-cycle" })
		}

		const statements = Arr.map(Arr.flatMap(ordered, statementsOf), guardTemplateCurly)

		return {
			content: `import { Schema } from "effect";\n\n${Arr.join(statements, "\n\n")}\n`,
			path: modulePath
		}
	})
