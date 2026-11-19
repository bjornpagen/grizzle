/** What the properties of loc.test.ts read: its spaces, models and helpers. */

import { compileFunction } from "node:vm"
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
} from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import { regex } from "arkregex"
import { Option, String as Str } from "effect"

export type FileKind =
	| "a file URL"
	| "a POSIX path"
	| "a Windows path"
	| "an HTTP URL"
	| "the library"
	| "the shell"
	| "the runtime"

/** Each kind's spelling of a file named `name`. */
const spelled: { readonly [K in FileKind]: (name: string) => string } = {
	"a file URL": (name) => `file:///app/src/${name}.ts`,
	"a POSIX path": (name) => `/home/u/${name}.ts`,
	"a Windows path": (name) => `C:\\work\\${name}.ts`,
	"an HTTP URL": (name) => `http://localhost:3000/${name}.js`,
	"the library": (name) => `file:///repo/packages/engine/src/core/${name}.ts`,
	"the shell": (name) => `file:///repo/packages/grizzle/src/adapter/public/${name}.ts`,
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

const fileGen = fileOf([...userKinds, "the library", "the shell", "the runtime"])

/** Whether a frame in a file of this kind is the user's, which a user-facing location names. */
export const userKind = (kind: FileKind): boolean =>
	kind !== "the library" && kind !== "the shell" && kind !== "the runtime"

export type Form =
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

export const written = (f: Frame): string => {
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

/**
 * A frame placed in a drawn file: its call `blank` lines into a body compiled after line `lineOffset`, so the line a
 * stack names for it is the drawn one, wherever this file's own lines fall.
 */
/** A frame placed in a file: where its body is compiled, and its call's blank lines and indent. */
export interface Placed {
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
export const callLine = (p: Placed): number => p.lineOffset + p.blank + 1

/**
 * The placed frame as a function of a chain: it calls the chain's head with the rest, its last link with the label and
 * path alone, so the frames of a chain ending in captureLoc are a real stack through the drawn files.
 */
export const compiled = (p: Placed) =>
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

export type Reach =
	| "the caller's own call"
	| "through the library"
	| "a user frame the library calls"

/** A stack's lines: frames of every engine's form and kind of file, among lines that name no site. */
export const linesGen: Gen<ReadonlyArray<Frame | string>> = array(
	weighted<Frame | string>([
		[3, frameGen],
		[1, noSiteGen]
	]),
	{ min: 1, max: 8 }
)

/** A declaration's label and path, made through a user's caller and a chain of frames in drawn files. */
export const captureGen: Gen<{
	readonly label: string
	readonly path: ReadonlyArray<string | number>
	readonly caller: Placed
	readonly inner: ReadonlyArray<Placed>
}> = (source) => ({
	label: source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 8 })),
	path: source.draw(array(pathSegment, { min: 0, max: 3 })),
	caller: source.draw(placedIn(fileOf(userKinds))),
	inner: source.draw(array(placedGen, { min: 0, max: 3 }))
})

/** How a value is spelled against a SourceLoc's exact structure: as one, or by one named malformation. */
export type Spelling =
	| "a location"
	| "a location with a site"
	| "an extra key"
	| "a bad path segment"
	| "a bad site"
	| "no record"

/** A SourceLoc's parts: a label, a path and a site. */
interface Parts {
	readonly label: string
	readonly path: ReadonlyArray<string | number>
	readonly site: { readonly file: string; readonly line: number; readonly column: number }
}

const partsGen: Gen<Parts> = (source) => ({
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

/** A SourceLoc's parts and the spelling they are written in. */
export const structureGen: Gen<readonly [Parts, Spelling]> = (source) =>
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

/** A refusal's label, path and site, or none, and the path it is moved inside. */
export const withinGen: Gen<{
	readonly label: string
	readonly path: ReadonlyArray<string | number>
	readonly prefix: ReadonlyArray<string | number>
	readonly site:
		| { readonly file: string; readonly line: number; readonly column: number }
		| undefined
}> = (source) => ({
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
})
