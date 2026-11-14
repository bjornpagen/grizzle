/**
 * Source locations (core/loc.ts): a SourceLoc names a logical path, a label and the JavaScript call site that built it,
 * parsed by hand from a stack's frame lines, V8's ("    at fn (file:line:col)") and SpiderMonkey's or
 * JavaScriptCore's ("fn@file:line:col"), the library's and the runtime's frames skipped.
 *
 * The frames are drawn from their parts (a function name or none, a file spelled as a URL, a POSIX or Windows path or a
 * runtime module, a line and a column), written in each engine's form, so the oracle is the parts themselves.
 *
 * - Frames: every engine's frame line reads as its file, line and column, every other line reads as no site, a stack
 *   reads as its frames' sites in order, a frame is the library's exactly when its file is the library's or the
 *   runtime's, and a stack's site is its first user frame's. Oracle: the frame's own parts.
 * - Capture: a declaration made through a chain of compiled frames is located at its innermost caller outside the
 *   library. Oracle: the drawn chain, whose call lines are placed by construction.
 * - Structure: a SourceLoc is recognized by its exact structure, and nothing else is. Oracle: the constructors
 *   (SourceLoc, sitedLoc) against the parser, and each named malformation.
 * - Relocation: a refusal moved inside a value has its path prefixed, and keeps its label, site and reason. Oracle: the
 *   location built with the prefixed path.
 *
 * Features: each engine's form and each kind of file, a line of no site; the caller's own call, through the library, a
 * user frame the library calls; each spelling of a SourceLoc and each malformation; a site and no site.
 *
 * Plants (~/.cache/grizzle-release/BR06/plants): loc-frame-column-dropped (a V8 frame read without its column),
 * loc-runtime-frames-kept (a runtime frame taken as the user's), loc-extra-key-admitted (a record with a key beyond a
 * location's read as one) and loc-within-appended (a relocation's prefix appended after the path).
 *
 * A file as a stack names it: a user's, or the library's or the runtime's, which a user-facing location skips.
 */
import { compileFunction } from "node:vm"
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	codePoint,
	element,
	type Gen,
	int,
	map,
	option,
	string,
	weighted
} from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { malformedDescription, within } from "#compiler/core/errors.ts"
import {
	captureLoc,
	isLibraryFrame,
	isSourceLoc,
	parseFrame,
	parseSourceLoc,
	parseStack,
	readSite,
	SourceLoc,
	sitedLoc,
	siteFromStack
} from "#compiler/core/loc.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

type FileKind =
	| "a file URL"
	| "a POSIX path"
	| "a Windows path"
	| "an HTTP URL"
	| "the library"
	| "the runtime"

/** Each kind's spelling of a file named `name`. */
const spelled: { readonly [K in FileKind]: (name: string) => string } = {
	"a file URL": (name) => `file:///app/src/${name}.ts`,
	"a POSIX path": (name) => `/home/u/${name}.ts`,
	"a Windows path": (name) => `C:\\work\\${name}.ts`,
	"an HTTP URL": (name) => `http://localhost:3000/${name}.js`,
	"the library": (name) => `file:///repo/packages/engine/src/core/${name}.ts`,
	"the runtime": (name) => `node:internal/${name}`
}

/** The kinds of a user's file, which a user-facing location names. */
const userKinds = [
	"a file URL",
	"a POSIX path",
	"a Windows path",
	"an HTTP URL"
] as const satisfies ReadonlyArray<FileKind>

/** A file of one of `kinds`, its name drawn. */
const fileOf =
	(
		kinds: ReadonlyArray<FileKind> & Readonly<{ 0: FileKind }>
	): Gen<{ readonly kind: FileKind; readonly file: string }> =>
	(source) => {
		const kind = source.draw(element(kinds))
		return { kind, file: spelled[kind](source.draw(matching(regex("^[a-z][a-z0-9_]{0,7}$")))) }
	}

const fileGen = fileOf([...userKinds, "the library", "the runtime"])

/** Whether a frame in a file of this kind is the user's, which a user-facing location names. */
const userKind = (kind: FileKind): boolean => kind !== "the library" && kind !== "the runtime"

type Form =
	| "V8 in a function"
	| "V8 at top level"
	| "SpiderMonkey in a function"
	| "SpiderMonkey anonymous"

/** A frame by its parts, and the form an engine writes it in. */
interface Frame {
	readonly form: Form
	readonly fn: string
	readonly at: { readonly kind: FileKind; readonly file: string }
	readonly line: number
	readonly column: number
}

const frameGen: Gen<Frame> = (source) => ({
	form: source.draw(
		element<Form>([
			"V8 in a function",
			"V8 at top level",
			"SpiderMonkey in a function",
			"SpiderMonkey anonymous"
		])
	),
	fn: source.draw(element(["relation", "new Thing", "Object.<anonymous>", "async run"])),
	at: source.draw(fileGen),
	line: source.draw(int(1, 99_999)),
	column: source.draw(int(1, 999))
})

const written = (f: Frame): string => {
	const location = `${f.at.file}:${f.line}:${f.column}`
	switch (f.form) {
		case "V8 in a function":
			return `    at ${f.fn} (${location})`
		case "V8 at top level":
			return `    at ${location}`
		case "SpiderMonkey in a function":
			return `${Str.replace(regex("[ .<>]", "g"), "")(f.fn)}@${location}`
		case "SpiderMonkey anonymous":
			return `@${location}`
	}
}

/** Lines a stack holds that name no call site: the message line and native frames. */
const noSiteGen = element([
	"Error: boom",
	"Error",
	"    at async Promise.all (index 0)",
	"    at <anonymous>"
])

describe("stack frame parsing", () => {
	it.effect(
		"reads every engine's frame as its file, line and column, and no site from any other line",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "specification", name: "the parts each frame was written from" },
						suite: "unit/core/loc-frames",
						draw: drawn(
							array(
								weighted<Frame | string>([
									[3, frameGen],
									[1, noSiteGen]
								]),
								{ min: 1, max: 8 }
							)
						),
						literal: Formatter.format,
						coverage: required<Form | FileKind | "a line of no site">(
							[
								"V8 in a function",
								"V8 at top level",
								"SpiderMonkey in a function",
								"SpiderMonkey anonymous",
								"a file URL",
								"a POSIX path",
								"a Windows path",
								"an HTTP URL",
								"the library",
								"the runtime",
								"a line of no site"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(lines, c) =>
						Effect.sync(() => {
							const sites = Arr.flatMap(lines, (line) => {
								if (typeof line === "string") {
									assert.equal(parseFrame(line), undefined)
									c.note("a line of no site")
									return []
								}
								const site = { file: line.at.file, line: line.line, column: line.column }
								assert.deepEqual(parseFrame(written(line)), site)
								c.note(line.form)
								c.note(line.at.kind)
								return [
									{
										site,
										user: userKind(line.at.kind)
									}
								]
							})
							const stack = Arr.join(
								Arr.map(lines, (line) => (typeof line === "string" ? line : written(line))),
								"\n"
							)
							assert.deepEqual(
								parseStack(stack),
								Arr.map(sites, (s) => s.site)
							)
							for (const s of sites) {
								assert.equal(isLibraryFrame(s.site.file), !s.user)
							}
							assert.deepEqual(
								siteFromStack(stack),
								Arr.findFirst(sites, (s) => s.user).pipe(
									Option.map((s) => s.site),
									Option.getOrUndefined
								)
							)
						})
				)
			)
	)
})

/**
 * A frame placed in a drawn file: its call `blank` lines into a body compiled after line `lineOffset`, so the line a
 * stack names for it is the drawn one, wherever this file's own lines fall.
 */
/** A frame placed in a file: where its body is compiled, and its call's blank lines and indent. */
interface Placed {
	readonly at: { readonly kind: FileKind; readonly file: string }
	readonly lineOffset: number
	readonly blank: number
	readonly indent: number
}

const placedIn =
	(file: Gen<{ readonly kind: FileKind; readonly file: string }>): Gen<Placed> =>
	(source) => ({
		at: source.draw(file),
		lineOffset: source.draw(int(0, 9_999)),
		blank: source.draw(int(0, 4)),
		indent: source.draw(int(0, 12))
	})

const placedGen = placedIn(fileGen)

/** The line a stack names for the placed frame's call. */
const callLine = (p: Placed): number => p.lineOffset + p.blank + 1

/**
 * The placed frame as a function of a chain: it calls the chain's head with the rest, its last link with the label and
 * path alone, so the frames of a chain ending in captureLoc are a real stack through the drawn files.
 */
const compiled = (p: Placed) =>
	compileFunction(
		`${Str.repeat(p.blank)("\n")}${Str.repeat(p.indent)(" ")}const [next, ...rest] = chain; return rest.length === 0 ? next(label, path) : next(rest, label, path)`,
		["chain", "label", "path"],
		{ filename: p.at.file, lineOffset: p.lineOffset }
	)

/** A path segment: a member's name or an index. */
const pathSegment: Gen<string | number> = weighted<string | number>([
	[1, string(codePoint(0x20, 0x7e), { min: 0, max: 4 })],
	[1, int(0, 2 ** 31 - 1)]
])

type Reach = "the caller's own call" | "through the library" | "a user frame the library calls"

describe("call-site capture", () => {
	it.effect(
		"locates a declaration at the line of its innermost caller outside the library",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "specification", name: "the drawn chain's placed call lines" },
						suite: "unit/core/loc-capture",
						draw: drawn((source) => ({
							label: source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 8 })),
							path: source.draw(array(pathSegment, { min: 0, max: 3 })),
							caller: source.draw(placedIn(fileOf(userKinds))),
							inner: source.draw(array(placedGen, { min: 0, max: 3 }))
						})),
						literal: Formatter.format,
						coverage: required<Reach>(
							["the caller's own call", "through the library", "a user frame the library calls"],
							{ cases: 50, sense: notesOnly }
						),
						kept: [],
						runs: 50,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ label, path, caller, inner }, c) =>
						Effect.sync(() => {
							const user = (p: Placed): boolean => userKind(p.at.kind)
							const expected = Option.getOrElse(Arr.findLast(inner, user), () => caller)
							if (inner.length === 0) {
								c.note("the caller's own call")
							}
							if (Option.exists(Arr.last(inner), (p) => !user(p))) {
								c.note("through the library")
							}
							if (Arr.some(Arr.dropWhile(inner, user), user)) {
								c.note("a user frame the library calls")
							}
							const captured: unknown = Reflect.apply(compiled(caller), undefined, [
								[...Arr.map(inner, compiled), captureLoc],
								label,
								path
							])
							const loc = defined(parseSourceLoc(captured), "the captured location")
							const site = defined(readSite(loc.site), "the captured site")
							assert.deepEqual(
								{ label: loc.label, path: loc.path, file: site.file, line: site.line },
								{ label, path, file: expected.at.file, line: callLine(expected) }
							)
						})
				)
			)
	)
})

describe("SourceLoc", () => {
	type Spelling =
		| "a location"
		| "a location with a site"
		| "an extra key"
		| "a bad path segment"
		| "a bad site"
		| "no record"
	it.effect("is recognized by its exact structure", (ctx) =>
		Effect.gen(function* () {
			const partsGen: Gen<{
				readonly label: string
				readonly path: ReadonlyArray<string | number>
				readonly site: { readonly file: string; readonly line: number; readonly column: number }
			}> = (source) => ({
				label: source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 6 })),
				path: source.draw(
					array(pathSegment, {
						min: 0,
						max: 3
					})
				),
				site: {
					file: source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 6 })),
					line: source.draw(int(0, 2 ** 31 - 1)),
					column: source.draw(int(0, 2 ** 31 - 1))
				}
			})
			yield* searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the constructors, and each named malformation"
						},
						suite: "unit/core/loc-structure",
						draw: drawn(
							(source) =>
								[
									source.draw(partsGen),
									source.draw(
										element<Spelling>([
											"a location",
											"a location with a site",
											"an extra key",
											"a bad path segment",
											"a bad site",
											"no record"
										])
									)
								] as const
						),
						literal: Formatter.format,
						coverage: required<Spelling>(
							[
								"a location",
								"a location with a site",
								"an extra key",
								"a bad path segment",
								"a bad site",
								"no record"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([{ label, path, site }, spelling], c) =>
						Effect.sync(() => {
							c.note(spelling)
							switch (spelling) {
								case "a location":
									assert.deepEqual(parseSourceLoc({ path, label }), SourceLoc(label, path))
									return
								case "a location with a site":
									assert.deepEqual(
										parseSourceLoc({ path, label, site }),
										sitedLoc(label, path, site)
									)
									return
								case "an extra key":
									assert.equal(isSourceLoc({ path, label, extra: 1 }), false)
									return
								case "a bad path segment":
									assert.equal(isSourceLoc({ path: [...path, {}], label }), false)
									return
								case "a bad site":
									assert.equal(isSourceLoc({ path, label, site: { file: site.file } }), false)
									return
								case "no record":
									assert.equal(isSourceLoc(label), false)
									assert.equal(isSourceLoc(null), false)
									return
							}
						})
				)
			)
		})
	)

	it.effect(
		"relocates a refusal inside a value by prefixing its path, keeping its label, site, reason and capability",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "specification", name: "the location built at the prefixed path" },
						suite: "unit/core/loc-within",
						draw: drawn((source) => ({
							label: source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 6 })),
							path: source.draw(array(pathSegment, { min: 0, max: 3 })),
							prefix: source.draw(array(pathSegment, { min: 0, max: 3 })),
							site: source.draw(
								map(
									option((source) => ({
										file: source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 6 })),
										line: source.draw(int(0, 2 ** 31 - 1)),
										column: source.draw(int(0, 2 ** 31 - 1))
									})),
									Option.getOrUndefined
								)
							)
						})),
						literal: Formatter.format,
						coverage: required<"a site" | "no site">(["a site", "no site"], {
							cases: 200,
							sense: notesOnly
						}),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ label, path, prefix, site }, c) =>
						Effect.sync(() => {
							c.note(site === undefined ? "no site" : "a site")
							const refusal = malformedDescription(sitedLoc(label, path, site), "a planted rule")
							const moved = within(refusal, prefix)
							assert.deepEqual(moved.reason, {
								_tag: "MalformedDescription",
								at: sitedLoc(label, [...prefix, ...path], site),
								what: "a planted rule"
							})
						})
				)
			)
	)
})
