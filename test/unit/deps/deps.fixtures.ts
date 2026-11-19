/** What the properties of deps.test.ts read: its spaces, models and helpers. */

import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { Checkout } from "@bjornpagen/testing/checkout"
import type { Need } from "@bjornpagen/testing/property"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Formatter,
	Option,
	Order,
	pipe,
	String as Str
} from "effect"
import { trustedJson } from "#compiler/core/trusted.ts"
import { assert } from "#test/support/assert.ts"
import { repoRoot } from "#test/support/files.ts"
import { hardenedNode, run, runOptions } from "#test/support/process.ts"
import {
	entriesOf,
	type Finding,
	modulesIn,
	type PackageJson,
	packageDirectories,
	packageOf
} from "#test/unit/deps/audit.ts"

/** Every TypeScript module under both packages' src, by its path from the root, sorted (audit.ts modulesIn). */
export const srcListing = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const modules = yield* Effect.forEach(["packages/engine/src", "packages/grizzle/src"], (dir) =>
		Effect.map(fs.readDirectory(`${repoRoot}${dir}`, { recursive: true }), (entries) =>
			modulesIn(entries, dir)
		)
	)
	return Arr.flatten(modules)
})

/** The packages' entry points (audit.ts entriesOf), read from each package.json under the root, sorted, each once. */
export const entryListing = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const targets: Array<string> = []
	for (const directory of packageDirectories) {
		const text = yield* fs.readFileString(`${repoRoot}packages/${directory}/package.json`)
		appendAll(targets, entriesOf(directory, trustedJson<PackageJson>(text)))
	}
	return Arr.sort(Arr.dedupe(targets), Order.String)
})

/** arkregex and the @ark packages it loads at runtime (@ark/util). */
export const isArk = (specifier: string): boolean =>
	packageOf(specifier) === "arkregex" || Str.startsWith("@ark/")(specifier)

/** A resolved module URL of arkregex or an @ark package. */
const isArkUrl = (url: string): boolean =>
	Str.includes("/node_modules/arkregex/")(url) || Str.includes("/@ark/")(url)

export const show = (findings: ReadonlyArray<Finding>): Array<string> =>
	Arr.map(findings, (f) => `${f.file}:${f.line}: ${f.rule} ${Formatter.format(f.text)}`)

/** A module URL Node resolved, and the module whose import asked for it. */
type Resolved = { readonly importer: string; readonly url: string }

/** A trapped call and the frame that made it. */
type Trapped = { readonly kind: string; readonly frame: string }

/** The probe's one JSON line, which runtime-probe.ts, the test's own child process, prints. */
type ProbeOutput = {
	readonly control: boolean
	readonly controlLine: number
	readonly protoAccessor: boolean
	readonly resolved: ReadonlyArray<Resolved>
	readonly trapped: ReadonlyArray<Trapped>
	readonly loads: ReadonlyArray<{
		readonly module: string
		readonly resolved: ReadonlyArray<Resolved>
		readonly trapped: ReadonlyArray<Trapped>
	}>
	readonly loadedTrapped: number
}

/** The negative control: a module that builds and runs RegExps at load, each statement on a line of its own. */
export const planted = "test/unit/deps/fixtures/planted-regex.ts"

/**
 * The lines of the planted module under `root` the trap must find, read off its text: the line of its one
 * `new RegExp`, and every line that exports a match, each of which runs exec once.
 */
export const plantedLines = (root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const text = yield* fs.readFileString(`${root}${planted}`)
		const lines = Str.split(text, "\n")
		const numbered = Arr.map(lines, (text, i) => ({ text, line: i + 1 }))
		return {
			construction: Arr.map(
				Arr.filter(numbered, ({ text }) => Str.includes("new RegExp(")(text)),
				({ line }) => line
			),
			matches: Arr.map(
				Arr.filter(numbered, ({ text }) => Str.startsWith("export const ")(text)),
				({ line }) => line
			)
		}
	})

/**
 * The probe of the repository at `root` (which ends in a slash), loading `modules`: a child of the test, killed if the
 * test is interrupted, and ended only once it has exited.
 */
const probe = (root: string, modules: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const result = yield* run(
			process.execPath,
			[...hardenedNode, `${root}test/unit/deps/runtime-probe.ts`, root, ...modules],
			{ ...runOptions, cwd: root }
		)
		assert.equal(result.status, 0, `runtime probe failed:\n${result.stderr}`)
		const last = Option.getOrThrowWith(
			Arr.last(Str.split(Str.trim(result.stdout), "\n")),
			() => new Error("the runtime probe printed nothing")
		)
		return trustedJson<ProbeOutput>(last)
	})

/**
 * The runtime probe's one run, in the directory the worker runs from (Checkout.dir's: a mutant's worker tree under the
 * mutator, so the mutant on disk is what it loads): one child Node under the RegExp trap loads every entry point the
 * packages name and the planted module, and drives every text parser, as the search's one probe did before the
 * conversion. Run once on each worker that readies the property (the need's open, outside every case's deadline); a
 * case reads its entry's load and the run's controls from it, where each case used to start a child Node of its own for
 * one entry point. A probe that fails fails the need's open, and so the property.
 */
export const probedEntries: Need<Readonly<{ root: string; out: ProbeOutput }>> = {
	key: "test/unit/deps/deps.fixtures.ts probedEntries",
	open: Effect.orDie(
		Effect.map(
			Effect.gen(function* () {
				const dir = yield* Effect.flatten(Checkout.dir.open)
				const root = `${dir}/`
				const entries = yield* entryListing
				const out = yield* probe(root, [...entries, planted])
				return { root, out }
			}),
			(probed) => Effect.succeed(probed)
		)
	)
}

/**
 * The trapped calls made from modules under a directory of the repository at `root`: the one filter every check
 * uses.
 */
export const trappedUnder = (
	root: string,
	trapped: ReadonlyArray<Trapped>,
	dir: string
): Array<string> =>
	Arr.map(
		Arr.filter(trapped, (t) => pipe(t.frame, Str.includes(`${root}${dir}/`))),
		(t) => `${t.kind} ${t.frame}`
	)

/**
 * The arkregex and @ark modules loaded from neither a test module of the repository at `root` nor arkregex's own:
 * arkregex is the tests' regex door (no-raw-regexp), so a test module may load it, and its own modules load @ark; src,
 * and every dependency src loads, never does.
 */
export const arkBeyondTests = (
	root: string,
	resolved: ReadonlyArray<Resolved>
): ReadonlyArray<Resolved> =>
	Arr.filter(
		resolved,
		(r) => isArkUrl(r.url) && !isArkUrl(r.importer) && !Str.includes(`${root}test/`)(r.importer)
	)
