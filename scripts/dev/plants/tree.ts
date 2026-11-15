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
import { type Citation, plantRoot, readingOf } from "#scripts/dev/plants/citations.ts"

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
 * - `malformed`: an @plant tag whose first word is no plant path, or that names no bug;
 * - `outsideTest`: a citation in a file that is no test, so no test runs while its plant is planted;
 * - `dangling`: a citation of a plant that is no file;
 * - `uncited`: a file under test/plants/ that no citation names, so nothing runs it;
 * - `sameName`: two plants under one name, which a plant's name alone no longer tells apart.
 */
export type Finding =
	| Readonly<{ kind: "malformed"; file: string; line: number; text: string }>
	| (Readonly<{ kind: "outsideTest" }> & At)
	| (Readonly<{ kind: "dangling" }> & At)
	| Readonly<{ kind: "uncited"; plant: string }>
	| Readonly<{ kind: "sameName"; name: string; plants: Arr.NonEmptyReadonlyArray<string> }>

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
 * Every finding of the tree, in a fixed order: each source's malformed tags, citations outside tests and dangling
 * citations, in source order; then each plant no citation names, in path order; then each name two plants share.
 */
export const findingsOf = (tree: Tree): ReadonlyArray<Finding> => {
	const plants = new Set(tree.plants)
	const named = new Set(Arr.map(citedIn(tree), ({ citation }) => citation.plant))
	const ofSources = Arr.flatMap(tree.sources, (source): ReadonlyArray<Finding> => {
		const reading = readingOf(source.text)
		const malformed = Arr.map(reading.malformed, (tag): Finding => ({
			kind: "malformed",
			file: source.path,
			line: tag.line,
			text: tag.text
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
		return Arr.appendAll(malformed, placed)
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

/** A finding in words, led by where it is. */
export const findingText = (finding: Finding): string => {
	switch (finding.kind) {
		case "malformed":
			return `${finding.file}:${finding.line}: an @plant tag names a plant by its path under ${plantRoot}, ending .patch, then the bug it plants: ${finding.text}`
		case "outsideTest":
			return `${finding.file}:${finding.line}: ${finding.plant} is cited outside a test, so no test runs while it is planted: cite it in the header of the test it turns red`
		case "dangling":
			return `${finding.file}:${finding.line}: ${finding.plant} is no file: a test cites only a plant the repository holds`
		case "uncited":
			return `${finding.plant}: no test cites it, so nothing runs it: cite it with an @plant tag in the test it turns red, or remove it`
		case "sameName":
			return `${finding.name} names ${finding.plants.length} plants, ${Arr.join(finding.plants, ", ")}: give each its own name`
	}
}

/** A plant and the tests that cite it, each of which must turn red while it is planted. */
export interface Trial {
	readonly plant: string
	readonly tests: Arr.NonEmptyReadonlyArray<string>
}

/**
 * What the changed target judges a plant by: how recently each path changed, `0` for a change only the working tree
 * holds (a file modified or untracked) and `n` for the n-th newest commit, and the files each plant's patch changes.
 */
export interface Since {
	readonly ages: ReadonlyMap<string, number>
	readonly patched: ReadonlyMap<string, ReadonlyArray<string>>
}

/**
 * What a run tries: the plants whose verdict may have moved since they last changed, or the plants of the tests and
 * the plants it names.
 */
export type Targets =
	| Readonly<{ kind: "changed"; since: Since }>
	| Readonly<{ kind: "named"; names: Arr.NonEmptyReadonlyArray<string> }>

/**
 * Whether a citation's plant must run against its test again: always when no commit last changed the plant, which so
 * never ran at one; otherwise when the test or a file the plant's patch changes has changed since, in a newer commit or
 * in the working tree. A plant that went red when it last changed, with nothing it reads changed after, is red still.
 */
const dueIn =
	(since: Since) =>
	({ file, citation }: Cited): boolean => {
		const age = (path: string) => Option.fromUndefinedOr(since.ages.get(path))
		const watched = [
			file,
			...Option.getOrElse(Option.fromUndefinedOr(since.patched.get(citation.plant)), () => [])
		]
		return Option.match(
			Option.filter(age(citation.plant), (planted) => planted > 0),
			{
				onNone: () => true,
				onSome: (planted) =>
					Arr.some(watched, (path) => Option.exists(age(path), (changed) => changed < planted))
			}
		)
	}

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
 * the tests citing it that it is due against (dueIn); for a named test, each plant it cites, with that test; for a named
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
			? Result.succeed(Arr.filter(pairs, dueIn(targets.since)))
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

/** The files git shows under test/, tracked or untracked but not ignored, by path from `root`, in path order. */
const testFiles = Effect.fn("testFiles")(function* (root: string) {
	const output = yield* gitOutput(root, [
		"ls-files",
		"--cached",
		"--others",
		"--exclude-standard",
		"-z",
		"--",
		"test"
	])
	return Arr.sort(pathsIn(output), Order.String)
})

/**
 * How recently each path under `root` changed (Since.ages): `0` for a path the working tree changes against HEAD or git
 * does not track, otherwise the place, from 1 for HEAD, of the newest commit in HEAD's history that touches it, read
 * from one pass over the history.
 */
export const agesOf = Effect.fn("agesOf")(function* (root: string) {
	const history = yield* gitOutput(root, ["log", "--format=%x00", "--name-only", "HEAD"])
	const modified = yield* gitOutput(root, ["diff", "--name-only", "-z", "HEAD"])
	const untracked = yield* gitOutput(root, ["ls-files", "--others", "--exclude-standard", "-z"])
	const committed = Arr.flatMap(Arr.drop(Str.split("\0")(history), 1), (commit, at) =>
		Arr.map(Arr.filter(Str.split("\n")(commit), Str.isNonEmpty), (path) => [path, at + 1] as const)
	)
	const working = Arr.map(
		[...pathsIn(modified), ...pathsIn(untracked)],
		(path) => [path, 0] as const
	)
	const ages: ReadonlyMap<string, number> = new Map(Arr.reverse([...working, ...committed]))
	return ages
})

/** The tree as it stands under `root`: every TypeScript source under test/ with its text, and every plant's path. */
export const readTree = Effect.fn("readTree")(function* (root: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const listed = yield* testFiles(root)
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
