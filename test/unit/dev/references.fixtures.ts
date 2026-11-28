/**
 * What references.test.ts reads: every file that may cite a document by heading, and what a file's citations get wrong.
 *
 * A citation names a document and one of its headings, `DOC "Heading"`: the document is README, CONTRIBUTING or SKILL
 * by its name (README.md, CONTRIBUTING.md, packages/grizzle/skills/grizzle/SKILL.md), or a page of docs/ by its path,
 * `docs/<page>.md`, and the heading is the text of exactly one of the document's markdown headings, a comment's line
 * breaks and continuation marks read as one space. That is the one spelling: a citation written with `.md` after a
 * document's name, or as a possessive of it before a capitalized title, is refused as another spelling.
 */
import { regex } from "arkregex"
import { Array as Arr, Effect, FileSystem, Path, String as Str } from "effect"
import { directoryEntries, repoRoot } from "#test/support/files.ts"

/** The documents cited by name, and their paths in the repository. */
const named: Readonly<Record<string, string>> = {
	README: "README.md",
	CONTRIBUTING: "CONTRIBUTING.md",
	SKILL: "packages/grizzle/skills/grizzle/SKILL.md"
}

/** A citation: its document, then its quoted heading, which may wrap across a comment's lines. */
const citation = regex(
	'\\b(README|CONTRIBUTING|SKILL|docs/[a-z0-9-]+\\.md)(?:[ \t]|\n[ \t]*(?:\\*|//)?)+"([^"\n]+(?:\n[ \t]*(?:\\*[ \t]*|//[ \t]*)?[^"\n]+)*)"',
	"g"
)

/** The spellings of a citation that are not its one spelling: a document's `.md` name, and a possessive title. */
const otherSpellings = [
	regex('\\b(?:README|CONTRIBUTING|SKILL)\\.md\\s+"', "g"),
	regex("\\b(?:README|CONTRIBUTING|SKILL)(?:\\.md)?'s\\s+[A-Z]", "g")
] as const

/** A heading's line in markdown. */
const headingLine = regex("^#{1,6}[ \t]+(.+?)[ \t]*$", "gm")

/** A heading as a citation spells it: its comment's line breaks and continuation marks one space. */
const unwrapped = (text: string): string =>
	Str.trim(Str.replace(regex("\\s*\n\\s*(?:\\*\\s*|//\\s*)?", "g"), " ")(text))

/** Whether a repository path is one whose text may cite a document: grizzle's sources, its tests and its documents. */
const cites = (file: string): boolean =>
	!Arr.some(Str.split(file, "/"), (segment) => Str.startsWith(".")(segment)) &&
	(regex("^packages/[^/]+/src/.+\\.ts$").test(file) ||
		regex("^test/.+\\.ts$").test(file) ||
		regex("^docs/[^/]+\\.md$").test(file) ||
		Arr.contains(["AGENTS.md", "README.md", "CONTRIBUTING.md", named["SKILL"] ?? ""], file))

/** The cells of citingFiles, minted as a dictionary in its door (test/unit/dev/references.dictionary.ts). */
export const citingFilesItems = await Effect.runPromise(
	Effect.map(
		Effect.forEach(["packages", "test", "docs"], (dir) =>
			Effect.map(directoryEntries(`${repoRoot}${dir}`), (entries) =>
				Arr.map(entries, (entry) => `${dir}/${entry}`)
			)
		),
		(listed) =>
			Arr.sort(
				Arr.filter([...Arr.flatten(listed), "AGENTS.md", "README.md", "CONTRIBUTING.md"], cites),
				Str.Order
			)
	)
)

/** The 1-based line of `index` in `text`. */
const lineAt = (text: string, index: number): number =>
	Str.split(Str.slice(0, index)(text), "\n").length

/**
 * What `file`, read from the checkout at `checkout`, gets wrong in its citations: each citation whose document holds
 * no heading of its text or more than one, and each citation of another spelling, by its line.
 */
export const citationProblems = (checkout: string, file: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const text = yield* fs.readFileString(path.join(checkout, file))
		const cited = Arr.map(Arr.fromIterable(Str.matchAll(citation)(text)), (match) => {
			const doc = match[1] ?? ""
			return {
				line: lineAt(text, match.index ?? 0),
				document: named[doc] ?? doc,
				heading: unwrapped(match[2] ?? "")
			}
		})
		const documents = Arr.dedupe(Arr.map(cited, (c) => c.document))
		const read = yield* Effect.forEach(documents, (document) =>
			Effect.map(
				Effect.orElseSucceed(fs.readFileString(path.join(checkout, document)), () => ""),
				(body) =>
					[
						document,
						Arr.map(Arr.fromIterable(Str.matchAll(headingLine)(body)), (match) =>
							Str.trim(match[1] ?? "")
						)
					] as const
			)
		)
		const headings = new Map(read)
		const unresolved = Arr.flatMap(cited, ({ line, document, heading }) => {
			const count = Arr.filter(headings.get(document) ?? [], (h) => h === heading).length
			return count === 1
				? []
				: [
						`${file}:${line}: "${heading}" names ${count} headings of ${document}, where a citation names one`
					]
		})
		const misspelled = Arr.flatMap(otherSpellings, (spelling) =>
			Arr.map(
				Arr.fromIterable(Str.matchAll(spelling)(text)),
				(match) =>
					`${file}:${lineAt(text, match.index ?? 0)}: "${match[0]}" cites a document in another spelling than DOC "Heading"`
			)
		)
		return [...unresolved, ...misspelled]
	})
