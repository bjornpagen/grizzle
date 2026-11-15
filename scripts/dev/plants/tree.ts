import { availableParallelism } from "node:os"
import { DevtoolFailure, failureFrom } from "@bjornpagen/devtools/devtool"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	Record as Rec,
	Result,
	Stream,
	String as Str
} from "effect"
import { ChildProcess } from "effect/process"
import { type Citation, plantRoot, readingOf, type Refusal } from "#scripts/dev/plants/citations.ts"

/** A file under test/: its path from the repository's root, and its text. */
export interface Source {
	readonly path: string
	readonly text: string
}

/** What the check reads: every TypeScript file under test/, and every file under test/plants/, by path from the root. */
export interface Tree {
	readonly sources: ReadonlyArray<Source>
	readonly plants: ReadonlyArray<string>
}

/** Where a citation is: the file that makes it, the line its tag starts on, and the plant it names. */
type At = Readonly<{ file: string; line: number; plant: string }>

/**
 * What the check refuses, each a way a citation and its plant can fail to meet:
 * - `refused`: a line the citation form refuses (citations.ts Refusal): a malformed tag, a lost plant directory, or
 *   a plant named in prose;
 * - `outsideTest`: a citation in a file that is no test, so no test runs while its plant is planted;
 * - `dangling`: a citation of a plant that is no file;
 * - `uncited`: a file under test/plants/ that no citation names, so nothing runs it;
 * - `sameName`: two plants under one name, which a plant's name alone no longer tells apart;
 * - `unapplied`: a plant git will not apply to the tree as it stands, which plants nothing and so proves nothing.
 */
export type Finding =
	| Readonly<{ kind: "refused"; file: string; refusal: Refusal }>
	| (Readonly<{ kind: "outsideTest" }> & At)
	| (Readonly<{ kind: "dangling" }> & At)
	| Readonly<{ kind: "uncited"; plant: string }>
	| Readonly<{ kind: "sameName"; name: string; plants: Arr.NonEmptyReadonlyArray<string> }>
	| Readonly<{ kind: "unapplied"; plant: string; reason: string }>

/** A test file, by the suffix every test's name carries. */
const isTest = (path: string): boolean => Str.endsWith(".test.ts")(path)

/** A citation and the file that makes it. */
interface Cited {
	readonly file: string
	readonly citation: Citation
}

/** Every citation the tree's sources make, in source order. */
const citedIn = (tree: Tree): ReadonlyArray<Cited> =>
	Arr.flatMap(tree.sources, (source) =>
		Arr.map(readingOf(source.text).citations, (citation) => ({ file: source.path, citation }))
	)

/** A plant's name: the last segment of its path. */
const nameOf = (plant: string): string => Arr.lastNonEmpty(Str.split("/")(plant))

/** The entries of a grouping, in the order of their keys. */
const byKey = <A>(groups: Readonly<Record<string, Arr.NonEmptyArray<A>>>) =>
	Arr.sort(
		Rec.toEntries(groups),
		Order.mapInput(Order.String, (entry: readonly [string, Arr.NonEmptyArray<A>]) => entry[0])
	)

/**
 * Every finding of the tree, in a fixed order: each source's refused lines, citations outside tests and dangling
 * citations, in source order; then each plant no citation names, in path order; then each name two plants share.
 */
export const findingsOf = (tree: Tree): ReadonlyArray<Finding> => {
	const plants = new Set(tree.plants)
	const named = new Set(Arr.map(citedIn(tree), ({ citation }) => citation.plant))
	const ofSources = Arr.flatMap(tree.sources, (source): ReadonlyArray<Finding> => {
		const reading = readingOf(source.text)
		const refused = Arr.map(reading.refusals, (refusal): Finding => ({
			kind: "refused",
			file: source.path,
			refusal
		}))
		const placed = Arr.flatMap(reading.citations, (citation): ReadonlyArray<Finding> => {
			const at: At = { file: source.path, line: citation.line, plant: citation.plant }
			const outside: ReadonlyArray<Finding> = isTest(source.path)
				? []
				: [{ kind: "outsideTest", ...at }]
			const dangling: ReadonlyArray<Finding> = plants.has(citation.plant)
				? []
				: [{ kind: "dangling", ...at }]
			return Arr.appendAll(outside, dangling)
		})
		return Arr.appendAll(refused, placed)
	})
	const uncited = Arr.map(
		Arr.sort(
			Arr.filter(tree.plants, (plant) => !named.has(plant)),
			Order.String
		),
		(plant): Finding => ({ kind: "uncited", plant })
	)
	const shared = Arr.flatMap(
		byKey(Arr.groupBy(tree.plants, nameOf)),
		([name, group]): ReadonlyArray<Finding> =>
			group.length > 1 ? [{ kind: "sameName", name, plants: Arr.sort(group, Order.String) }] : []
	)
	return [...ofSources, ...uncited, ...shared]
}

/** What each kind of refused line is told. */
const refusalText: { readonly [K in Refusal["kind"]]: string } = {
	malformed: `an @plant tag names a plant by its path under ${plantRoot}, ending .patch, then the bug it plants`,
	prose: `a plant is cited only by an @plant tag naming its file under ${plantRoot}, never by name in prose (the capitalized Plant or Plants outside a tag)`,
	lost: `plants live under ${plantRoot}, never in ~/.cache/grizzle-release/<lane>/plants, where the old VM's were lost`
}

/** A finding in words, led by where it is. */
export const findingText = (finding: Finding): string => {
	switch (finding.kind) {
		case "refused":
			return `${finding.file}:${finding.refusal.line}: ${refusalText[finding.refusal.kind]}: ${finding.refusal.text}`
		case "outsideTest":
			return `${finding.file}:${finding.line}: ${finding.plant} is cited outside a test, so no test runs while it is planted: cite it in the header of the test it turns red`
		case "dangling":
			return `${finding.file}:${finding.line}: ${finding.plant} is no file: a test cites only a plant the repository holds`
		case "uncited":
			return `${finding.plant}: no test cites it, so nothing runs it: cite it with an @plant tag in the test it turns red, or remove it`
		case "sameName":
			return `${finding.name} names ${finding.plants.length} plants, ${Arr.join(finding.plants, ", ")}: give each its own name`
		case "unapplied":
			return `${finding.plant}: git apply --check refuses it against the tree, so it plants nothing: make it again against the code as it is, planting the same bug (${finding.reason})`
	}
}

/** A plant and the tests that cite it, each of which must turn red while it is planted. */
export interface Trial {
	readonly plant: string
	readonly tests: Arr.NonEmptyReadonlyArray<string>
}

/** A citation a test makes: the plant it names, and the test. */
export interface Pair {
	readonly plant: string
	readonly test: string
}

/**
 * What a run tries: the citations no verdict is kept for, their content as it stands (`changed`: `known` holds each
 * plant's tests that have one, and `within`, when given, the directories whose tests alone it tries), or the plants of
 * the tests and the plants it names.
 */
export type Targets =
	| Readonly<{
			kind: "changed"
			known: ReadonlyMap<string, ReadonlySet<string>>
			within: Option.Option<Arr.NonEmptyReadonlyArray<string>>
	  }>
	| Readonly<{ kind: "named"; names: Arr.NonEmptyReadonlyArray<string> }>

/** Every citation the tree's tests make, plant and test, in source order. */
export const pairsOf = (tree: Tree): ReadonlyArray<Pair> =>
	Arr.map(
		Arr.filter(citedIn(tree), ({ file }) => isTest(file)),
		({ file, citation }) => ({ plant: citation.plant, test: file })
	)

/** Whether a citation is one a name picks: the name is the test that makes it, or the plant it names. */
const picks =
	(name: string) =>
	({ file, citation }: Cited): boolean =>
		file === name || citation.plant === name

/** The citations named targets pick, or the names that pick none. */
const pickedBy = (
	pairs: ReadonlyArray<Cited>,
	names: Arr.NonEmptyReadonlyArray<string>
): Result.Result<ReadonlyArray<Cited>, Arr.NonEmptyReadonlyArray<string>> => {
	const unknown = Arr.filter(names, (name) => !Arr.some(pairs, picks(name)))
	return Arr.isReadonlyArrayNonEmpty(unknown)
		? Result.fail(unknown)
		: Result.succeed(Arr.filter(pairs, (pair) => Arr.some(names, (name) => picks(name)(pair))))
}

/**
 * The trials a run makes, one per plant in path order, each with its tests in path order: for `changed`, each plant with
 * the tests citing it that have no kept verdict, those under its directories when it names some; for a named test, each plant it cites, with that test; for a named
 * plant, every test that cites it. A name that is neither a test citing a plant nor a plant a test cites fails the plan, so a run
 * never passes for want of anything to try.
 */
export const planOf = (
	tree: Tree,
	targets: Targets
): Result.Result<ReadonlyArray<Trial>, Arr.NonEmptyReadonlyArray<string>> => {
	const pairs = Arr.filter(citedIn(tree), ({ file }) => isTest(file))
	const chosen =
		targets.kind === "changed"
			? Result.succeed(
					Arr.filter(
						pairs,
						({ file, citation }) =>
							targets.known.get(citation.plant)?.has(file) !== true &&
							Option.match(targets.within, {
								onNone: () => true,
								onSome: (directories) =>
									Arr.some(directories, (directory) => Str.startsWith(directory)(file))
							})
					)
				)
			: pickedBy(pairs, targets.names)
	return Result.map(chosen, (picked) =>
		Arr.map(
			byKey(Arr.groupBy(picked, ({ citation }) => citation.plant)),
			([plant, group]): Trial => ({
				plant,
				tests: Arr.sort(Arr.dedupe(Arr.map(group, ({ file }) => file)), Order.String)
			})
		)
	)
}

/** The repository's root, three directories above this one. */
export const repositoryRoot = Effect.gen(function* () {
	const path = yield* Path.Path
	return path.resolve(import.meta.dirname, "../../..")
})

/** What git prints for `args` in `root`, failing unless it exits 0. */
const gitOutput = Effect.fn("gitOutput")(function* (root: string, args: ReadonlyArray<string>) {
	const [output, status] = yield* Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* ChildProcess.make("git", args, {
				cwd: root,
				stdin: "ignore",
				stderr: "inherit"
			})
			const output = yield* Stream.mkString(Stream.decodeText(handle.stdout))
			const status = yield* handle.exitCode
			return [output, status] as const
		})
	).pipe(Effect.mapError(failureFrom(`git ${Arr.join(args, " ")} could not be run`)))
	if (status !== 0) {
		return yield* DevtoolFailure.make({
			detail: `git ${Arr.join(args, " ")} exited with ${status}`
		})
	}
	return output
})

/** The paths of a NUL-separated list git prints. */
const pathsIn = (output: string): ReadonlyArray<string> =>
	Arr.filter(Str.split("\0")(output), Str.isNonEmpty)

/**
 * Which files a reading of the tree takes: the `tracked` ones, what git holds and a commit or a push carries, which the
 * check judges (a gate's snapshot keeps untracked files from earlier runs, which are no part of what it checks); or the
 * `working` tree's, the untracked but not ignored files too, which a plant run plants in, a new plant or test before its
 * commit among them.
 */
export type Listing = "tracked" | "working"

/** The files under test/ that `listing` takes, by path from `root`, in path order. */
const testFiles = Effect.fn("testFiles")(function* (root: string, listing: Listing) {
	const output = yield* gitOutput(root, [
		"ls-files",
		"--cached",
		...(listing === "working" ? ["--others", "--exclude-standard"] : []),
		"-z",
		"--",
		"test"
	])
	return Arr.sort(pathsIn(output), Order.String)
})

/**
 * The plants among `plants` that git will not apply to the tree under `root` as it stands, each found by its own
 * `git apply --check`, as many at once as the machine has cores; a plant is checked alone, never after another.
 */
export const unappliedIn = Effect.fn("unappliedIn")(function* (
	root: string,
	plants: ReadonlyArray<string>
) {
	const checked = yield* Effect.forEach(
		plants,
		(plant) =>
			Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* ChildProcess.make("git", ["apply", "--check", plant], {
						cwd: root,
						stdin: "ignore"
					})
					const [reason, status] = yield* Effect.all(
						[Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
						{ concurrency: "unbounded" }
					)
					return status === 0
						? []
						: [{ kind: "unapplied" as const, plant, reason: Str.trim(reason) }]
				})
			).pipe(Effect.mapError(failureFrom(`git apply --check ${plant} could not be run`))),
		{ concurrency: availableParallelism() }
	)
	const unapplied: ReadonlyArray<Finding> = Arr.flatten(checked)
	return unapplied
})

/**
 * The tree as it stands under `root`, the files `listing` takes: every TypeScript source under test/ with its text, and
 * every plant's path.
 */
export const readTree = Effect.fn("readTree")(function* (root: string, listing: Listing) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const listed = yield* testFiles(root, listing)
	const files = yield* Effect.filter(listed, (file) =>
		fs.exists(path.join(root, file)).pipe(Effect.mapError(failureFrom(`${file} could not be read`)))
	)
	const sources = yield* Effect.forEach(
		Arr.filter(files, (file) => Str.endsWith(".ts")(file)),
		(file) =>
			Effect.mapBoth(fs.readFileString(path.join(root, file)), {
				onFailure: failureFrom(`${file} could not be read`),
				onSuccess: (text): Source => ({ path: file, text })
			})
	)
	const tree: Tree = {
		sources,
		plants: Arr.filter(files, (file) => Str.startsWith(plantRoot)(file))
	}
	return tree
})
