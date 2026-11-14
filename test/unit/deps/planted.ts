import { array, element, type Gen, weighted } from "@grizzle/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { upTo } from "#test/support/up-to.ts"
import type { RuntimeImport } from "#test/unit/deps/audit.ts"

/**
 * Planted modules for the dependency audit's own check (deps.test.ts): a module is a list of pieces, each one or more
 * lines of TypeScript that Node's type stripping accepts, which states what the audit must find in it, on which of its
 * lines. A piece is a RegExp construction or match, eval or the Function constructor, written in one of the places an
 * expression or a statement may begin; a decoy, text that names them but builds none (strings, templates, comments,
 * divisions, types, properties, an effect module's match); or an import, export or require in each form Node runs or
 * erases. The pieces' findings, line by line in the order the module states them, are the oracle: the audit must find
 * exactly them.
 */
type RegexRule =
	| "regex literal"
	| "RegExp reference"
	| ".test member"
	| ".exec member"
	| ".match member"
	| ".matchAll member"
	| ".search member"

type CodeRule = "eval" | "Function constructor"

/** What a piece states the audit must find, each finding on its line of the piece, counted from 0. */
interface Expected {
	readonly regex: ReadonlyArray<readonly [line: number, rule: RegexRule]>
	readonly code: ReadonlyArray<readonly [line: number, rule: CodeRule]>
	readonly imports: ReadonlyArray<
		readonly [line: number, kind: RuntimeImport["kind"], specifier: string]
	>
	readonly opaque: ReadonlyArray<readonly [line: number, opened: "import(" | "require("]>
}

/** An expression on one line, and the findings it holds in the order it states them. */
interface Spelled {
	readonly text: string
	readonly regex: ReadonlyArray<RegexRule>
	readonly code: ReadonlyArray<CodeRule>
}

/** An expression that builds or runs a RegExp, or generates code, and the feature it reaches. */
interface Atom extends Spelled {
	readonly feature: AtomFeature
}

type AtomFeature =
	| "a regex literal"
	| "a regex literal's test"
	| "a regex literal's property"
	| "new RegExp"
	| "RegExp called"
	| "globalThis.RegExp"
	| "a test"
	| "an exec"
	| "an exec referenced"
	| "a match"
	| "a matchAll"
	| "a search"
	| "eval"
	| "new Function"
	| "Function called"

type ContextFeature =
	| "after =>"
	| "after return"
	| "after ;"
	| "after an if's header"
	| "after a while's header"
	| "after a for's header"
	| "after a for's block"
	| "after a bare block"
	| "after finally's block"
	| "after a switch's block"
	| "after a function's block"
	| "after ["
	| "after ,"
	| "after ("
	| "after ="
	| "after ?"
	| "after !"
	| "after typeof"
	| "in a template's substitution"

type DecoyFeature =
	| "a string"
	| "a template"
	| "a nested template"
	| "a template over lines"
	| "a line comment"
	| "a block comment"
	| "a block comment over lines"
	| "a division after a parenthesis"
	| "a division after a bracket"
	| "a division after an increment"
	| "a division after a member"
	| "a division after a call"
	| "a division after a number"
	| "a division in an if's branches"
	| "instanceof RegExp"
	| "a type naming RegExp"
	| "an interface over lines"
	| "properties named test, exec and match"
	| "a match property compared"
	| "an effect module's match"
	| "another module's match"
	| "a match on the name an effect import renames"
	| "eval and Function as members"

type ImportFeature =
	| "import type"
	| "an import of a type binding"
	| "a named import"
	| "a renamed import"
	| "an import of a binding named from"
	| "a namespace import"
	| "a default import"
	| "a side-effect import"
	| "an import over lines"
	| "a re-export"
	| "an export of all"
	| "an export of all as a name"
	| "a type re-export"
	| "a local export"
	| "a dynamic import"
	| "a dynamic import with options"
	| "a computed dynamic import"
	| "import.meta"
	| "a require"
	| "a computed require"

export type PlantedFeature = AtomFeature | ContextFeature | DecoyFeature | ImportFeature

/** Every feature a planted module may reach, each a situation the audit's check requires. */
export const plantedFeatures: Arr.NonEmptyReadonlyArray<PlantedFeature> = [
	"a regex literal",
	"a regex literal's test",
	"a regex literal's property",
	"new RegExp",
	"RegExp called",
	"globalThis.RegExp",
	"a test",
	"an exec",
	"an exec referenced",
	"a match",
	"a matchAll",
	"a search",
	"eval",
	"new Function",
	"Function called",
	"after =>",
	"after return",
	"after ;",
	"after an if's header",
	"after a while's header",
	"after a for's header",
	"after a for's block",
	"after a bare block",
	"after finally's block",
	"after a switch's block",
	"after a function's block",
	"after [",
	"after ,",
	"after (",
	"after =",
	"after ?",
	"after !",
	"after typeof",
	"in a template's substitution",
	"a string",
	"a template",
	"a nested template",
	"a template over lines",
	"a line comment",
	"a block comment",
	"a block comment over lines",
	"a division after a parenthesis",
	"a division after a bracket",
	"a division after an increment",
	"a division after a member",
	"a division after a call",
	"a division after a number",
	"a division in an if's branches",
	"instanceof RegExp",
	"a type naming RegExp",
	"an interface over lines",
	"properties named test, exec and match",
	"a match property compared",
	"an effect module's match",
	"another module's match",
	"a match on the name an effect import renames",
	"eval and Function as members",
	"import type",
	"an import of a type binding",
	"a named import",
	"a renamed import",
	"an import of a binding named from",
	"a namespace import",
	"a default import",
	"a side-effect import",
	"an import over lines",
	"a re-export",
	"an export of all",
	"an export of all as a name",
	"a type re-export",
	"a local export",
	"a dynamic import",
	"a dynamic import with options",
	"a computed dynamic import",
	"import.meta",
	"a require",
	"a computed require"
]

/** A piece of a planted module: its lines, what the audit must find in them, and the features it reaches. */
interface Piece {
	readonly text: string
	readonly expected: Expected
	readonly features: ReadonlyArray<PlantedFeature>
}

const nothing: Expected = { regex: [], code: [], imports: [], opaque: [] }

/** Text a string, a template or a comment holds: the names and shapes the audit reads in code, inert here. */
const inertWords = [
	"RegExp",
	" /x/",
	".test(s)",
	".exec",
	"eval(1)",
	"new Function()",
	"import(m)",
	"a b",
	"/"
] as const

/** A string literal in either quote, its text the inert words and an escaped quote of its own. */
const stringLiteral: Gen<string> = (source) => {
	const quote = source.draw(element(["'", '"'] as const))
	const other = quote === "'" ? '"' : "'"
	const words = source.draw(
		array(element([...inertWords, `\\${quote}`, other, "`"]), { min: 0, max: 4 })
	)
	return `${quote}${Arr.join(words, "")}${quote}`
}

/** A template's text: the inert words, an escaped backtick, a quote of either kind. */
const templateText: Gen<string> = (source) =>
	Arr.join(source.draw(array(element([...inertWords, "\\`", "'", '"']), { min: 0, max: 3 })), "")

/** A comment's text: the inert words and every quote, which open nothing in a comment. */
const commentText: Gen<string> = (source) =>
	Arr.join(source.draw(array(element([...inertWords, "'", '"', "`"]), { min: 0, max: 3 })), "")

/** A regular expression literal: a slash, a backtick or a quote escaped or in a class among its terms, and its flags. */
const regexLiteral: Gen<string> = (source) => {
	const terms = source.draw(
		array(
			element(["a", "\\/", "[/]", "[^/]", "[']", '["]', "[`]", "\\d+", "(?:b|c)", "x*", "\\\\"]),
			{ min: 1, max: 3 }
		)
	)
	return `/${Arr.join(terms, "")}/${source.draw(element(["", "u", "g", "i", "gu"]))}`
}

/** The argument of a RegExp or a String match: a string, or, `depth` atoms deep at most, an atom of its own. */
const argumentOf = (depth: number): Gen<Spelled> =>
	depth === 0
		? (source) => ({ text: source.draw(stringLiteral), regex: [], code: [] })
		: weighted<Spelled>([
				[3, argumentOf(0)],
				[1, regexAtom(depth - 1)]
			])

/** The atom of `feature` whose argument is `arg`: its own finding, then the argument's. */
const withArgument = (
	feature: AtomFeature,
	rule: RegexRule,
	spell: (arg: string) => string,
	arg: Spelled
): Atom => ({
	text: spell(arg.text),
	regex: [rule, ...arg.regex],
	code: arg.code,
	feature
})

/** An expression that builds or runs a RegExp; its argument, where it takes one, nests `depth` atoms more at most. */
const regexAtom = (depth: number): Gen<Atom> =>
	weighted<Atom>([
		[
			2,
			(source) => ({
				text: source.draw(regexLiteral),
				regex: ["regex literal"],
				code: [],
				feature: "a regex literal"
			})
		],
		[
			1,
			(source) => ({
				text: `${source.draw(regexLiteral)}.test(s)`,
				regex: ["regex literal", ".test member"],
				code: [],
				feature: "a regex literal's test"
			})
		],
		[
			1,
			(source) => ({
				text: `${source.draw(regexLiteral)}.${source.draw(element(["lastIndex", "source", "flags"]))}`,
				regex: ["regex literal"],
				code: [],
				feature: "a regex literal's property"
			})
		],
		[
			1,
			(source) =>
				withArgument(
					"new RegExp",
					"RegExp reference",
					(arg) => `new RegExp(${arg})`,
					source.draw(argumentOf(depth))
				)
		],
		[
			1,
			(source) =>
				withArgument(
					"RegExp called",
					"RegExp reference",
					(arg) => `RegExp(${arg})`,
					source.draw(argumentOf(depth))
				)
		],
		[
			1,
			(source) =>
				withArgument(
					"globalThis.RegExp",
					"RegExp reference",
					(arg) => `globalThis.RegExp(${arg})`,
					source.draw(argumentOf(depth))
				)
		],
		[
			1,
			(source) => ({
				text: `r${source.draw(element([".", "?."]))}test(s)`,
				regex: [".test member"],
				code: [],
				feature: "a test"
			})
		],
		[
			1,
			(source) => ({
				text: `r${source.draw(element([".", "?."]))}exec(s)`,
				regex: [".exec member"],
				code: [],
				feature: "an exec"
			})
		],
		[
			1,
			() => ({ text: "r.exec", regex: [".exec member"], code: [], feature: "an exec referenced" })
		],
		[
			1,
			(source) =>
				withArgument(
					"a match",
					".match member",
					(arg) => `s.match(${arg})`,
					source.draw(argumentOf(depth))
				)
		],
		[
			1,
			(source) =>
				withArgument(
					"a matchAll",
					".matchAll member",
					(arg) => `[...s.matchAll(${arg})]`,
					source.draw(argumentOf(depth))
				)
		],
		[
			1,
			(source) =>
				withArgument(
					"a search",
					".search member",
					(arg) => `s?.search(${arg})`,
					source.draw(argumentOf(depth))
				)
		]
	])

/** An expression that generates code at runtime. */
const codeAtom: Gen<Atom> = weighted<Atom>([
	[
		1,
		(source) => ({
			text: `eval(${source.draw(stringLiteral)})`,
			regex: [],
			code: ["eval"],
			feature: "eval"
		})
	],
	[
		1,
		(source) => ({
			text: `new Function(${source.draw(stringLiteral)})`,
			regex: [],
			code: ["Function constructor"],
			feature: "new Function"
		})
	],
	[
		1,
		(source) => ({
			text: `Function(${source.draw(stringLiteral)}, ${source.draw(stringLiteral)})`,
			regex: [],
			code: ["Function constructor"],
			feature: "Function called"
		})
	]
])

/** The places an expression or a statement begins, each a line around the atom `e`, numbered `n`. */
const contexts: Arr.NonEmptyReadonlyArray<
	readonly [ContextFeature, (e: string, n: number) => string]
> = [
	["after =>", (e, n) => `export const v${n} = (s: string, r: R) => ${e}`],
	["after return", (e, n) => `export function f${n}(s: string, r: R) { return ${e} }`],
	["after ;", (e, n) => `export function f${n}(s: string, r: R) { if (s) return; ${e} }`],
	["after an if's header", (e, n) => `export function f${n}(s: string, r: R) { if (s) ${e} }`],
	["after a while's header", (e, n) => `export function f${n}(s: string, r: R) { while (s) ${e} }`],
	[
		"after a for's header",
		(e, n) => `export function f${n}(s: string, r: R) { for (const c of s) ${e} }`
	],
	["after a for's block", (e, n) => `export function f${n}(s: string, r: R) { for (;;) {} ${e} }`],
	["after a bare block", (e, n) => `export function f${n}(s: string, r: R) { { } ${e} }`],
	[
		"after finally's block",
		(e, n) => `export function f${n}(s: string, r: R) { try { } finally { } ${e} }`
	],
	[
		"after a switch's block",
		(e, n) => `export function f${n}(s: string, r: R) { switch (s) { } ${e} }`
	],
	[
		"after a function's block",
		(e, n) => `export function f${n}(s: string) { while (s) s = s.slice(1) } ${e}`
	],
	["after [", (e, n) => `export const v${n} = (s: string, r: R) => [${e}]`],
	["after ,", (e, n) => `export const v${n} = (s: string, r: R) => [0, ${e}]`],
	["after (", (e, n) => `export const v${n} = (s: string, r: R) => (${e})`],
	["after =", (e, n) => `export const v${n} = ${e}`],
	["after ?", (e, n) => `export const v${n} = (s: string, r: R) => s ? ${e} : 0`],
	["after !", (e, n) => `export const v${n} = (s: string, r: R) => !${e}`],
	["after typeof", (e, n) => `export const v${n} = (s: string, r: R) => typeof ${e}`],
	[
		"in a template's substitution",
		(e, n) => `export const v${n} = (s: string, r: R) => \`\${${e}}\``
	]
]

/** An atom in a context: one line holding the atom's findings. */
const placed =
	(atom: Gen<Atom>) =>
	(n: number): Gen<Piece> =>
	(source) => {
		const a = source.draw(atom)
		const [context, spell] = source.draw(element(contexts))
		return {
			text: spell(a.text, n),
			expected: {
				regex: Arr.map(a.regex, (rule) => [0, rule] as const),
				code: Arr.map(a.code, (rule) => [0, rule] as const),
				imports: [],
				opaque: []
			},
			features: [a.feature, context]
		}
	}

/** A piece with nothing to find. */
const decoy = (feature: DecoyFeature, text: string): Piece => ({
	text,
	expected: nothing,
	features: [feature]
})

/** Text that names RegExp, eval or the Function constructor and builds none, or a match an effect module owns. */
const decoyPiece =
	(n: number): Gen<Piece> =>
	(source) =>
		source.draw(
			element([
				() => decoy("a string", `export const v${n} = ${source.draw(stringLiteral)}`),
				() =>
					decoy(
						"a template",
						`export const v${n} = (a: number, b: number) => \`${source.draw(templateText)}\${a / b}${source.draw(templateText)}\` / 2`
					),
				() =>
					decoy("a nested template", `export const v${n} = (t: string) => \`\${\`\${t}\`}\` + 1`),
				() =>
					decoy(
						"a template over lines",
						`export const v${n} = \`${source.draw(templateText)}\n${source.draw(templateText)}\``
					),
				() => decoy("a line comment", `// ${source.draw(commentText)}`),
				() =>
					decoy("a block comment", `/* ${source.draw(commentText)} */ export const v${n} = 1 / 2`),
				() =>
					decoy(
						"a block comment over lines",
						`/* ${source.draw(commentText)}\n${source.draw(commentText)} */`
					),
				() =>
					decoy(
						"a division after a parenthesis",
						`export const v${n} = (a: number, b: number) => (a) / b / 2`
					),
				() =>
					decoy(
						"a division after a bracket",
						`export const v${n} = (o: Array<number>) => o[0] / 2`
					),
				() =>
					decoy(
						"a division after an increment",
						`export function f${n}(q: number, r: number) { return q++ / r }`
					),
				() =>
					decoy(
						"a division after a member",
						`export const v${n} = (a: number) => [{ z: a }][0].z / 2`
					),
				() =>
					decoy("a division after a call", `export const v${n} = (g: G, x: number) => g(x) / x`),
				() => decoy("a division after a number", `export const v${n} = 6 / 2 / 0x3`),
				() =>
					decoy(
						"a division in an if's branches",
						`export function f${n}(a: number, b: number) { let g = 0; if (a) g = (a) / b; else g = b / a; return g }`
					),
				() =>
					decoy(
						"instanceof RegExp",
						`export const v${n} = (x: unknown): x is RegExp => x instanceof RegExp`
					),
				() =>
					decoy(
						"a type naming RegExp",
						`export type T${n} = { readonly test: RegExp; readonly exec: (s: string) => RegExp }`
					),
				() => decoy("an interface over lines", `interface I${n} {\n\treadonly c: RegExp\n}`),
				() =>
					decoy(
						"properties named test, exec and match",
						`export const v${n} = { test: 1, exec: 2, match: 3 }`
					),
				() =>
					decoy(
						"a match property compared",
						`export const v${n} = (when: W) => when.match === "NOT MATCHED" ? when.match : ""`
					),
				(): Piece => ({
					text: `import { Option as O${n} } from "effect"\nexport const v${n} = (o: X) => O${n}.match(o, h)`,
					expected: { ...nothing, imports: [[0, "static", "effect"]] },
					features: ["an effect module's match"]
				}),
				(): Piece => ({
					text: `import { Option as P${n} } from "./option.ts"\nexport const v${n} = (o: X) => P${n}.match(o, h)`,
					expected: {
						...nothing,
						regex: [[1, ".match member"]],
						imports: [[0, "static", "./option.ts"]]
					},
					features: ["another module's match"]
				}),
				(): Piece => ({
					text: `import { M${n} as O${n} } from "effect"\nimport { M${n} } from "./option.ts"\nexport const v${n} = (o: X) => [O${n}.match(o, h), M${n}.match(o, h)]`,
					expected: {
						...nothing,
						regex: [[2, ".match member"]],
						imports: [
							[0, "static", "effect"],
							[1, "static", "./option.ts"]
						]
					},
					features: ["a match on the name an effect import renames"]
				}),
				() =>
					decoy(
						"eval and Function as members",
						`export const v${n} = (o: O) => o.eval + (o?.eval ?? 0) + o.Function(1)`
					)
			])
		)()

/** The specifiers an import names: arkregex and its @ark package among them. */
const specifiers = [
	"arkregex",
	"@ark/util",
	"effect",
	"effect/Schema",
	"./a.ts",
	"../text/index.ts",
	"node:fs"
] as const

/** An import, export or require in a form Node runs or erases. */
const importPiece =
	(n: number): Gen<Piece> =>
	(source) => {
		const spec = source.draw(element(specifiers))
		const erased = (feature: ImportFeature, text: string): Piece => ({
			text,
			expected: nothing,
			features: [feature]
		})
		const runs = (feature: ImportFeature, kind: RuntimeImport["kind"], text: string): Piece => ({
			text,
			expected: { ...nothing, imports: [[0, kind, spec]] },
			features: [feature]
		})
		const opaque = (
			feature: ImportFeature,
			opened: "import(" | "require(",
			text: string
		): Piece => ({
			text,
			expected: { ...nothing, opaque: [[0, opened]] },
			features: [feature]
		})
		return source.draw(
			element([
				() => erased("import type", `import type { T${n} } from "${spec}"`),
				() => runs("an import of a type binding", "static", `import { type T${n} } from "${spec}"`),
				() => runs("a named import", "static", `import { a${n} } from "${spec}"`),
				() => runs("a renamed import", "static", `import { a${n} as b${n} } from "${spec}"`),
				() =>
					runs(
						"an import of a binding named from",
						"static",
						`import { from as f${n} } from "${spec}"`
					),
				() => runs("a namespace import", "static", `import * as ns${n} from "${spec}"`),
				() => runs("a default import", "static", `import d${n} from "${spec}"`),
				() => runs("a side-effect import", "static", `import "${spec}"`),
				() =>
					runs("an import over lines", "static", `import {\n\ta${n},\n\tb${n}\n} from "${spec}"`),
				() => runs("a re-export", "reexport", `export { a${n} } from "${spec}"`),
				() => runs("an export of all", "reexport", `export * from "${spec}"`),
				() => runs("an export of all as a name", "reexport", `export * as c${n} from "${spec}"`),
				() => erased("a type re-export", `export type { T${n} } from "${spec}"`),
				() => erased("a local export", `export { x${n} as y${n} }`),
				() => runs("a dynamic import", "dynamic", `export const v${n} = () => import("${spec}")`),
				() =>
					runs(
						"a dynamic import with options",
						"dynamic",
						`export const v${n} = () => import("${spec}", { with: { type: "json" } })`
					),
				() =>
					opaque(
						"a computed dynamic import",
						"import(",
						`export const v${n} = (m: string) => import(m)`
					),
				() => erased("import.meta", `export const v${n} = import.meta.url`),
				() => runs("a require", "require", `export const v${n} = require("${spec}")`),
				() =>
					opaque("a computed require", "require(", `export const v${n} = (m: string) => require(m)`)
			])
		)()
	}

/** One piece of a planted module, numbered `n` so its names are its own. */
const pieceOf = (n: number): Gen<Piece> =>
	weighted<Piece>([
		[3, placed(regexAtom(1))(n)],
		[1, placed(codeAtom)(n)],
		[3, decoyPiece(n)],
		[2, importPiece(n)]
	])

/** A planted module: one to eight pieces. */
export const plantedModule: Gen<ReadonlyArray<Piece>> = (source) => {
	const count = source.draw(element([1, 2, 3, 4, 5, 6, 7, 8] as const))
	return Arr.map(
		upTo(count, (i) => i + 1),
		(n) => source.draw(pieceOf(n))
	)
}

/** The lines a piece takes. */
const linesOf = (piece: Piece): number => Str.split(piece.text, "\n").length

/** A module's text: its pieces, one after another, each on lines of its own. */
export const moduleText = (pieces: ReadonlyArray<Piece>): string =>
	Arr.join(
		Arr.map(pieces, (p) => p.text),
		"\n"
	)

/** What the audit must find in a module, each finding on its line of the module, counted from 1. */
export const expectedOf = (pieces: ReadonlyArray<Piece>): Expected => {
	const starts = Arr.scan(pieces, 1, (line, piece) => line + linesOf(piece))
	return {
		regex: Arr.flatMap(pieces, (p, i) =>
			Arr.map(p.expected.regex, ([line, rule]) => [Arr.getUnsafe(starts, i) + line, rule] as const)
		),
		code: Arr.flatMap(pieces, (p, i) =>
			Arr.map(p.expected.code, ([line, rule]) => [Arr.getUnsafe(starts, i) + line, rule] as const)
		),
		imports: Arr.flatMap(pieces, (p, i) =>
			Arr.map(
				p.expected.imports,
				([line, kind, spec]) => [Arr.getUnsafe(starts, i) + line, kind, spec] as const
			)
		),
		opaque: Arr.flatMap(pieces, (p, i) =>
			Arr.map(
				p.expected.opaque,
				([line, opened]) => [Arr.getUnsafe(starts, i) + line, opened] as const
			)
		)
	}
}
