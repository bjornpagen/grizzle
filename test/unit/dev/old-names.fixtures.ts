/**
 * What old-names.test.ts reads: every file that may spell grizzle's public API, and the old spellings a file holds.
 *
 * grizzle's API is named as PostgreSQL names its types and concepts, each entry read through its one namespace, and
 * nothing anywhere spells it as it was spelt before (Bjorn's "ZERO of the old syntax"): no member of the pg namespace
 * (`pg.integer`, `pg["double precision"]`, the namespace itself read off an entry), no name that is gone from every
 * entry (Decimal, BytesField, parseDouble, contractParser and the rest of OLD_NAMES), no old name read off an entry's
 * namespace or imported from a public module (`g.bytes`, `{ span } from "@bjornpagen/grizzle"`), no member of the set
 * namespace under its old name (`Bits.of`), and not the contract entry. The scan reads a file's text whole, code, comments and strings alike, so a program a test builds as a string,
 * which tsgo or the codemod compiles, is held as its own module is. A document is held further: no code span opens with
 * an old name, and no line says a public name was renamed, formerly or previously something else, since the reference
 * reads as if each name had always been its own.
 */
import * as g from "@bjornpagen/grizzle"
import * as gClient from "@bjornpagen/grizzle/client"
import * as gCompile from "@bjornpagen/grizzle/compile"
import * as gDomain from "@bjornpagen/grizzle/domain"
import * as gDynamic from "@bjornpagen/grizzle/dynamic"
import * as gHttp from "@bjornpagen/grizzle/http"
import * as gRuntime from "@bjornpagen/grizzle/runtime"
import { regex } from "arkregex"
import { Array as Arr, Effect, FileSystem, Path, Record, String as Str } from "effect"
import { directoryEntries, repoRoot } from "#test/support/files.ts"

/** Names no entry exports any more, each spelt nowhere: a word match anywhere in a file is an old spelling. */
const OLD_NAMES = [
	"Decimal",
	"BytesField",
	"SpanField",
	"BitsField",
	"SpanEndpointLike",
	"SpanWidthOf",
	"bytesMaxLength",
	"decimalText",
	"decimalTextMaxBytes",
	"doubleText",
	"parseDouble",
	"parseDecimal",
	"contractParser",
	"ContractParser",
	"ContractRefused",
	"AnyContract"
] as const

/** Old names that are words too (a text's bytes, a span of lines), old only where they name an export. */
const OLD_EXPORTS = ["pg", "bytes", "span", "bits", "Bits", "Span", "contract", "Contract"] as const

/** The pg namespace's members, which the root exports by their pg_type names now. */
const PG_MEMBERS = Arr.join(
	[
		"smallint",
		"integer",
		"bigint",
		"real",
		"boolean",
		"numeric",
		"money",
		"inet",
		"cidr",
		"vector",
		"tsvector",
		"serial",
		"smallserial",
		"bigserial",
		"uuidv7"
	],
	"|"
)

/** OLD_NAMES as one alternation, a string, which the regexes below read without spelling each name's type. */
const oldNameAlternation: string = Arr.join(OLD_NAMES, "|")

/** The old spellings any scanned file may not hold, each with what it is. */
const spellings: ReadonlyArray<readonly [RegExp, string]> = [
	[regex(`\\b(?:${oldNameAlternation})\\b`, "g"), "a name no entry exports"],
	[regex(`\\bpg\\.(?:${PG_MEMBERS})\\b`, "g"), "a member of the pg namespace"],
	[regex('\\bpg\\["double precision"\\]', "g"), "a member of the pg namespace"],
	[
		regex(
			`\\b(?:g|gRuntime|gCompile|gClient|gDynamic|gHttp|gDomain|Fi|Cp|Sc|Tx)\\.(?:${Arr.join(OLD_EXPORTS, "|")})\\b`,
			"g"
		),
		"an old name read off an entry's namespace"
	],
	[regex("@bjornpagen/grizzle/contract\\b", "g"), "the contract entry, which is the domain entry"],
	[
		regex(
			"\\bBits\\.(?:of|union|intersection|difference|cardinality|subset|disjoint|singleton)\\b",
			"g"
		),
		"a member of the set namespace, which is Bit"
	]
]

/** An import's specifier list and its module. */
const imports = regex("import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s+from\\s+[\"']([^\"']+)[\"']", "g")

/** The modules a name of grizzle's public API is imported from: its entries and the public barrels behind them. */
const publicModule = regex(
	"^(?:#compiler/public/[a-z]+\\.ts|#index\\.ts|@bjornpagen/grizzle(?:/[a-z]+)?)$"
)

/**
 * A document's code span that opens by calling or instantiating an old name, `span(int4)`, `contract<typeof key>()`; an
 * old name read off an entry's namespace, `g.bytes`, is a spelling anywhere, and an old name alone in a code span is the
 * word it is too (`pg`, node-postgres and the pg tier; `span`, the testing library's generator).
 */
const oldCodeSpan = regex(`\`(?:${Arr.join(OLD_EXPORTS, "|")})[(<][^\`\\n]*\``, "g")

/** A word that tells a name's history, which a document never tells. */
const history = regex("\\b(?:[Rr]enamed|[Ff]ormerly|[Pp]reviously)\\b", "g")

/** A document's code span, by its text. */
const codeSpan = regex("`([^`\\n]+)`", "g")

const isDocument = (file: string): boolean => Str.endsWith(".md")(file)

/** The files the scan reads: the documents, the tests and the benchmarks, the scan's own modules apart. */
const scanned = (file: string): boolean =>
	!Arr.some(Str.split(file, "/"), (segment) => Str.startsWith(".")(segment)) &&
	!Str.startsWith("test/unit/dev/old-names.")(file) &&
	(regex("^(?:test|bench|packages/cli-generator/test)/.+\\.tsx?$").test(file) ||
		regex("^docs/[^/]+\\.md$").test(file) ||
		Arr.contains(
			["README.md", "CONTRIBUTING.md", "packages/grizzle/skills/grizzle/SKILL.md"],
			file
		))

/** The cells of oldNameFiles, minted as a dictionary in its door (test/unit/dev/old-names.dictionary.ts). */
export const oldNameFilesItems = await Effect.runPromise(
	Effect.map(
		Effect.forEach(
			["test", "bench", "docs", "packages/cli-generator/test", "packages/grizzle/skills"],
			(dir) =>
				Effect.map(directoryEntries(`${repoRoot}${dir}`), (entries) =>
					Arr.map(entries, (entry) => `${dir}/${entry}`)
				)
		),
		(listed) =>
			Arr.sort(
				Arr.filter([...Arr.flatten(listed), "README.md", "CONTRIBUTING.md"], scanned),
				Str.Order
			)
	)
)

/** The names grizzle's entries export, which a document's history words may not stand beside. */
const publicNames: ReadonlySet<string> = new Set([
	...Record.keys(g),
	...Record.keys(gRuntime),
	...Record.keys(gCompile),
	...Record.keys(gClient),
	...Record.keys(gDynamic),
	...Record.keys(gHttp),
	...Record.keys(gDomain)
])

/** The 1-based line of `index` in `text`. */
const lineAt = (text: string, index: number): number =>
	Str.split(Str.slice(0, index)(text), "\n").length

/** The old spellings `file`, read from the checkout at `checkout`, holds, each by its line and what it is. */
export const oldSpellingsOf = (checkout: string, file: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const text = yield* fs.readFileString(path.join(checkout, file))
		const at = (index: number | undefined, what: string, found: string): string =>
			`${file}:${lineAt(text, index ?? 0)}: "${found}" is ${what}`
		const spelt = Arr.flatMap(spellings, ([pattern, what]) =>
			Arr.map(Arr.fromIterable(Str.matchAll(pattern)(text)), (match) =>
				at(match.index, what, match[0])
			)
		)
		const imported = Arr.flatMap(Arr.fromIterable(Str.matchAll(imports)(text)), (match) =>
			publicModule.test(match[2] ?? "")
				? Arr.flatMap(Str.split(match[1] ?? "", ","), (specifier) => {
						const name = Str.trim(Str.replace(regex("^type\\s+"), "")(Str.trim(specifier)))
						const imported = Str.trim(Arr.headNonEmpty(Str.split(name, " as ")))
						return Arr.contains<string>(OLD_EXPORTS, imported)
							? [at(match.index, "an old name imported from a public module", imported)]
							: []
					})
				: []
		)
		const documented = isDocument(file)
			? [
					...Arr.map(Arr.fromIterable(Str.matchAll(oldCodeSpan)(text)), (match) =>
						at(match.index, "a code span of an old name", match[0])
					),
					...Arr.flatMap(Str.split(text, "\n"), (line, i) =>
						Str.matchAll(history)(line).next().done === true ||
						!Arr.some(Arr.fromIterable(Str.matchAll(codeSpan)(line)), (span) =>
							publicNames.has(Arr.headNonEmpty(Str.split(span[1] ?? "", ".")))
						)
							? []
							: [`${file}:${i + 1}: tells a public name's history: ${Str.trim(line)}`]
					)
				]
			: []
		return [...spelt, ...imported, ...documented]
	})
