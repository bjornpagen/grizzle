import { isRecord } from "#compiler/core/record.ts"

/** A JavaScript call site: its file, line and column. */
export interface CallSite {
	readonly file: string
	readonly line: number
	readonly column: number
}

/**
 * The call stack the runtime captured where a value was built, frozen and unread: the runtime formats a stack only
 * when it is read, so a build that prints no location formats none. Its call site is the first frame outside the
 * library (readSite), read where a location is printed or written out. captureLoc is its one maker.
 */
class CapturedStack extends Error {}

export type { CapturedStack }

/** Whether a value is a stack captureLoc captured. */
export const isCapturedStack = (value: unknown): value is CapturedStack =>
	value instanceof CapturedStack

/**
 * Where a location's value was built: a call site, as a location spelled in JSON states it; the stack the runtime
 * captured there; or none, for a location the compiler names.
 */
export type Site = CallSite | CapturedStack | undefined

/**
 * Source locations for diagnostics.
 *
 * A SourceLoc names where a declaration or expression came from: a logical path through the owned graph (for example
 * ["Work", "relations", "Task", "fields", "id"]), a human label, and where the JavaScript that built it ran (Site),
 * whose call site is undefined for a location the compiler names and when the runtime gives no usable stack.
 * It is excluded from semantic identity: fingerprints omit it (fingerprint.ts), so moving a declaration to another
 * line changes no fingerprint.
 *
 * Call sites are read from a captured stack's text and parsed by hand. Nothing here imports a Node module, and src/
 * constructs no RegExp, so the parser is a plain scanner over V8 ("    at fn (file:line:col)") and
 * SpiderMonkey/JavaScriptCore ("fn@file:line:col") frame lines.
 */
export interface SourceLoc {
	readonly path: ReadonlyArray<string | number>
	readonly label: string
	readonly site: Site
}

/** A location the compiler names, at no call site. */
export const SourceLoc = (label: string, path: ReadonlyArray<string | number>): SourceLoc => ({
	path: [...path],
	label,
	site: undefined
})

/** A location at `site`. */
export const sitedLoc = (
	label: string,
	path: ReadonlyArray<string | number>,
	site: Site
): SourceLoc => ({
	path: [...path],
	label,
	site
})

/** A location the given segments deeper, keeping the label and call site. */
export const childLoc = (
	loc: SourceLoc,
	...segments: ReadonlyArray<string | number>
): SourceLoc => ({
	path: [...loc.path, ...segments],
	label: loc.label,
	site: loc.site
})

/** The same location inside the value at `path`: `path` prefixed to its path, keeping the label and call site. */
export const prefixedLoc = (path: ReadonlyArray<string | number>, loc: SourceLoc): SourceLoc => ({
	path: [...path, ...loc.path],
	label: loc.label,
	site: loc.site
})

/** A location one segment deeper under a label of its own, keeping the call site. */
export const labeledChildLoc = (
	loc: SourceLoc,
	segment: string | number,
	label: string
): SourceLoc => ({
	path: [...loc.path, segment],
	label,
	site: loc.site
})

const isCallSite = (value: unknown): value is CallSite =>
	isRecord(value) &&
	typeof value["file"] === "string" &&
	typeof value["line"] === "number" &&
	typeof value["column"] === "number"

const isSegment = (segment: unknown): segment is string | number =>
	typeof segment === "string" || typeof segment === "number"

/**
 * The SourceLoc a value spells where a location travels inside a description, or undefined when it spells none: its
 * site a call site, as JSON spells one, or the stack a builder captured. JSON carries no undefined, so a location
 * without a call site leaves the key out there.
 */
export const parseSourceLoc = (value: unknown): SourceLoc | undefined => {
	if (!isRecord(value) || Array.isArray(value)) {
		return undefined
	}
	if (!Object.keys(value).every((k) => k === "path" || k === "label" || k === "site")) {
		return undefined
	}
	const { label, path, site } = value
	if (typeof label !== "string" || !Array.isArray(path) || !path.every(isSegment)) {
		return undefined
	}
	if (site === undefined || site instanceof CapturedStack || isCallSite(site)) {
		return { path, label, site }
	}
	return undefined
}

/** Whether a value spells a SourceLoc, as parseSourceLoc reads it. */
export const isSourceLoc = (value: unknown): boolean => parseSourceLoc(value) !== undefined

/** "Work.relations.Task.fields[0]": string segments joined by dots, numeric segments as indices. */
export const formatPath = (path: ReadonlyArray<string | number>): string => {
	let out = ""
	for (const segment of path) {
		if (typeof segment === "number") {
			out += `[${segment}]`
		} else {
			out += out === "" ? segment : `.${segment}`
		}
	}
	return out
}

const formatSite = (site: CallSite): string => `${site.file}:${site.line}:${site.column}`

/** The one text of a location, printed where it leaves the compiler: "label at path (file:line:col)". */
export const formatLoc = (loc: SourceLoc): string => {
	const path = formatPath(loc.path)
	const head = path === "" ? loc.label : `${loc.label} at ${path}`
	const site = readSite(loc.site)
	return site === undefined ? head : `${head} (${formatSite(site)})`
}

const isDigits = (text: string): boolean => {
	if (text === "") {
		return false
	}
	for (const ch of text) {
		if (ch < "0" || ch > "9") {
			return false
		}
	}
	return true
}

/** "file:line:col" with the two numbers taken from the end, so a Windows drive letter or a URL scheme stays in file. */
const parseLocation = (location: string): CallSite | undefined => {
	const colon2 = location.lastIndexOf(":")
	if (colon2 <= 0) {
		return undefined
	}
	const colon1 = location.lastIndexOf(":", colon2 - 1)
	if (colon1 <= 0) {
		return undefined
	}
	const file = location.slice(0, colon1)
	const line = location.slice(colon1 + 1, colon2)
	const column = location.slice(colon2 + 1)
	if (!isDigits(line) || !isDigits(column)) {
		return undefined
	}
	return { file, line: Number(line), column: Number(column) }
}

/** What a V8 stack line of a call site begins with. */
const framePrefix = "at "

/** One stack line to its call site, or undefined for the message line, native frames, and anything unparseable. */
export const parseFrame = (frame: string): CallSite | undefined => {
	const text = frame.trim()
	if (text.startsWith(framePrefix)) {
		const rest = text.slice(framePrefix.length)
		if (rest.endsWith(")")) {
			const open = rest.lastIndexOf("(")
			return open < 0 ? undefined : parseLocation(rest.slice(open + 1, -1))
		}
		return parseLocation(rest)
	}
	const at = locationAt(text)
	return at === undefined ? undefined : parseLocation(text.slice(at + 1))
}

/** Whether a code unit is an ASCII letter, a digit, or one of a URL scheme's `+`, `.` and `-`. */
const isSchemeUnit = (unit: number): boolean =>
	(unit >= 0x61 && unit <= 0x7a) ||
	(unit >= 0x41 && unit <= 0x5a) ||
	(unit >= 0x30 && unit <= 0x39) ||
	unit === 0x2b ||
	unit === 0x2e ||
	unit === 0x2d

/** Whether `text` from `start` is a location: a URL (a scheme, `file:` or `node:` among them) or an absolute path. */
const isLocationStart = (text: string, start: number): boolean => {
	const first = text.charCodeAt(start)
	if (first === 0x2f) {
		return true
	}
	if (!((first >= 0x61 && first <= 0x7a) || (first >= 0x41 && first <= 0x5a))) {
		return false
	}
	for (let i = start + 1; i < text.length; i++) {
		const unit = text.charCodeAt(i)
		if (unit === 0x3a) {
			return true
		}
		if (!isSchemeUnit(unit)) {
			return false
		}
	}
	return false
}

/**
 * The `@` that starts a SpiderMonkey/JavaScriptCore frame's location ("fn@file:line:col"): the first one a location
 * follows. The file itself may hold an `@`, as a scoped package's path does (`…/node_modules/@scope/pkg/…`), so the
 * last `@` is not it; a function name holding one is passed over too.
 */
const locationAt = (text: string): number | undefined => {
	for (let i = text.indexOf("@"); i >= 0; i = text.indexOf("@", i + 1)) {
		if (isLocationStart(text, i + 1)) {
			return i
		}
	}
	return undefined
}

export const parseStack = (stack: string): ReadonlyArray<CallSite> => {
	const sites: Array<CallSite> = []
	for (const line of stack.split("\n")) {
		const site = parseFrame(line)
		if (site !== undefined) {
			sites.push(site)
		}
	}
	return sites
}

/** Frames belonging to grizzle itself or to the runtime, which a user-facing location skips. */
export const isLibraryFrame = (file: string): boolean =>
	file.startsWith("node:") ||
	file.includes("/packages/engine/src/") ||
	file.includes("/@bjornpagen/grizzle-engine/") ||
	file.includes("/@bjornpagen/grizzle/") ||
	file.includes("\\packages\\engine\\src\\")

/** The first call site of `stack` outside the library, or undefined when every frame is the library's. */
export const siteFromStack = (stack: string): CallSite | undefined =>
	parseStack(stack).find((site) => !isLibraryFrame(site.file))

/**
 * The call site a site names: the one it states, or the first frame outside the library of the stack it captured,
 * where the user wrote the declaration. Undefined at none, and when the runtime gave no usable stack.
 */
export const readSite = (site: Site): CallSite | undefined => {
	if (!(site instanceof CapturedStack)) {
		return site
	}
	const stack = site.stack
	return stack === undefined ? undefined : siteFromStack(stack)
}

/** A SourceLoc at the stack the runtime gives here, whose call site, the user's, is read only where it is printed. */
export const captureLoc = (label: string, path: ReadonlyArray<string | number>): SourceLoc =>
	sitedLoc(label, path, Object.freeze(new CapturedStack()))
