/**
 * The plant check's reading of a file and its judgment of the tree (scripts/dev/plants/citations.ts and tree.ts), and
 * the trials a plant run plans from the tree.
 *
 * - Reading: a file drawn as blocks: JSDoc comments, indented or not, of prose lines, blank lines, other tags and plant
 *   tags; one-line JSDoc plant tags; and code lines whose strings spell a plant tag. A tag's words are drawn from plant
 *   paths, paths the citation form refuses (upper case, a dot segment, another suffix, another directory, the old cache
 *   directories) and prose, so a tag may name a plant and a bug on its own line, carry its bug over the prose lines
 *   below it, or name no plant path or no bug. Oracle: the citations and malformed tags the drawn blocks state, read
 *   off the blocks rather than the text: a tag's words are its own and those of the prose lines right below it in its
 *   comment, and its first word is a plant path by its segments, a second implementation of the path's form.
 * - Judgment: a tree drawn as plant files from a pool of three suites and three names, so two suites can hold one
 *   name, beside a file under test/plants that no tag can name, and sources, tests or a support file, each citing
 *   plants of the pool, some holding a malformed tag. Oracle: the findings the drawn tree states, by set differences
 *   over its citations and its plants.
 * - Plan: the same trees, and either the changed target over a drawn history (each path's age, 0 for the working tree
 *   or none for a file no commit touched, and the files each plant's patch changes) or a set of names drawn among the
 *   tests, the plants and a test that cites nothing. Oracle: for changed, the citations whose plant no commit holds or
 *   whose newest watched change, its test's or a changed file's, is newer than the plant's own; for names, the
 *   citations each name picks; grouped by plant, and the names that pick none.
 *
 * Features: for reading, a citation on its tag's line, a citation whose bug carries over the lines below, a one-line
 * citation, a tag naming no plant path, a tag naming no bug, and a tag spelled in code; for judgment, each finding
 * kind and a tree the check passes; for plans, a plant no commit holds, a citation due by its test, one due by a file
 * its plant changes alone, one nothing moved, a named test's plants, a named plant's tests, a plant two tests cite, and
 * a name that picks nothing.
 *
 * @plant test/plants/unit/dev/plants-continuation-dropped.patch A tag's bug is read off its own line alone, so a
 * citation whose bug sits on the lines below it is malformed; the reading property fails.
 * @plant test/plants/unit/dev/plants-path-unchecked.patch Any first word is taken for a plant path, so a tag naming
 * none cites it; the reading property fails.
 * @plant test/plants/unit/dev/plants-dangling-unchecked.patch The judgment never finds a citation of a plant that is
 * no file; the judgment property fails.
 * @plant test/plants/unit/dev/plants-same-name-unchecked.patch The judgment never finds two plants under one name; the
 * judgment property fails.
 * @plant test/plants/unit/dev/plants-plan-test-unpicked.patch A named test picks none of its citations, so the plan
 * fails it as a name that picks nothing; the plan property fails.
 * @plant test/plants/unit/dev/plants-changed-files-unwatched.patch The changed target watches a citation's test alone,
 * never the files its plant changes, so a plant whose code moved is not retried; the plan property fails.
 * @plant test/plants/unit/dev/plants-changed-working-tree-skipped.patch The changed target takes a plant the working
 * tree changes for one a commit holds, so a plant never run at a commit is skipped; the plan property fails.
 */
import { type Case, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, boolean, element, type Gen, subset, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Result, String as Str } from "effect"
import { type Citation, type Malformed, readingOf } from "#scripts/dev/plants/citations.ts"
import {
	type Finding,
	findingsOf,
	findingText,
	planOf,
	type Since,
	type Targets,
	type Tree,
	type Trial
} from "#scripts/dev/plants/tree.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** Paths in the citation form: under test/plants/, lower-case segments, ending .patch. */
const PLANT_PATHS = [
	"test/plants/unit/a/x.patch",
	"test/plants/pg/b.patch",
	"test/plants/x-1.patch"
] as const

/** Paths the citation form refuses, each one way: case, a dot segment, a suffix, a directory, the old cache. */
const REFUSED_PATHS = [
	"test/plants/A.patch",
	"test/plants/../x.patch",
	"test/plants/.x.patch",
	"test/plants//x.patch",
	"test/plants/x.txt",
	"test/plants/x.patch.bak",
	"test/plant/x.patch",
	"plants/x.patch",
	"~/.cache/grizzle-release/BR06/plants/x.patch",
	"x-dropped"
] as const

/** Prose a line may open with: plain words, the words of plants, punctuation a pattern could trip on. */
const OPENING = [
	"the",
	"count",
	"Plant",
	"plants",
	"planted",
	"(a",
	"past.",
	"x*y",
	"\\s",
	"test"
] as const

/** Words anywhere in a line: the openings, every path, and a tag's name where it opens nothing. */
const WORDS = [...OPENING, ...PLANT_PATHS, ...REFUSED_PATHS, "@plant", "bug)"] as const

/** A tag's words: weighted toward a path first, so citations, refused paths and words alone are all common. */
const tagWordsGen: Gen<ReadonlyArray<string>> = (source) => [
	...source.draw(
		weighted<ReadonlyArray<string>>([
			[3, (s) => [s.draw(element(PLANT_PATHS))]],
			[2, (s) => [s.draw(element(REFUSED_PATHS))]],
			[1, () => []]
		])
	),
	...source.draw(array(element(WORDS), { min: 0, max: 3 }))
]

/** A line of a JSDoc comment. */
type Item =
	| Readonly<{ kind: "tag"; words: ReadonlyArray<string> }>
	| Readonly<{ kind: "prose"; words: Arr.NonEmptyReadonlyArray<string> }>
	| Readonly<{ kind: "blank" }>
	| Readonly<{ kind: "other"; tag: string; words: ReadonlyArray<string> }>

/** A block of a file: a JSDoc comment at an indent, a one-line JSDoc tag, or a line of code. */
type Block =
	| Readonly<{ kind: "comment"; indent: string; items: ReadonlyArray<Item> }>
	| Readonly<{ kind: "oneLine"; words: ReadonlyArray<string> }>
	| Readonly<{ kind: "code"; words: ReadonlyArray<string> }>

const itemGen: Gen<Item> = weighted<Item>([
	[3, (s) => ({ kind: "tag", words: s.draw(tagWordsGen) })],
	[
		3,
		(s) => ({
			kind: "prose",
			words: [s.draw(element(OPENING)), ...s.draw(array(element(WORDS), { min: 0, max: 3 }))]
		})
	],
	[2, () => ({ kind: "blank" })],
	[
		1,
		(s) => ({
			kind: "other",
			tag: s.draw(element(["see", "param"])),
			words: s.draw(array(element(WORDS), { min: 0, max: 2 }))
		})
	]
])

const blockGen: Gen<Block> = weighted<Block>([
	[
		4,
		(s) => ({
			kind: "comment",
			indent: s.draw(element(["", "\t", "\t\t"])),
			items: s.draw(array(itemGen, { min: 0, max: 6 }))
		})
	],
	[1, (s) => ({ kind: "oneLine", words: s.draw(tagWordsGen) })],
	[1, (s) => ({ kind: "code", words: s.draw(tagWordsGen) })]
])

const fileGen: Gen<ReadonlyArray<Block>> = array(blockGen, { min: 1, max: 4 })

/** Words after a tag's name, as a line spells them. */
const spelled = (words: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(words, (word) => ` ${word}`),
		""
	)

/** An item's line at an indent. */
const itemLine = (indent: string, item: Item): string => {
	switch (item.kind) {
		case "tag":
			return `${indent} * @plant${spelled(item.words)}`
		case "prose":
			return `${indent} *${spelled(item.words)}`
		case "blank":
			return `${indent} *`
		case "other":
			return `${indent} * @${item.tag}${spelled(item.words)}`
	}
}

/** A block's lines. */
const blockLines = (block: Block): Arr.NonEmptyReadonlyArray<string> => {
	switch (block.kind) {
		case "comment":
			return [
				`${block.indent}/**`,
				...Arr.map(block.items, (item) => itemLine(block.indent, item)),
				`${block.indent} */`
			]
		case "oneLine":
			return [`/** @plant${spelled(block.words)} */`]
		case "code":
			return [`export const line = "* @plant${spelled(block.words)}"`]
	}
}

/** A file's text: its blocks' lines, one after another. */
const textOf = (file: ReadonlyArray<Block>): string =>
	`${Arr.join(Arr.flatMap(file, blockLines), "\n")}\n`

/** The characters a plant path's segment is spelled with, and those it may open with. */
const SEGMENT = "abcdefghijklmnopqrstuvwxyz0123456789._-"
const OPENS = "abcdefghijklmnopqrstuvwxyz0123456789"

/** A segment of a plant path: opened by a letter or digit, then letters, digits, dots, dashes and underscores. */
const isSegment = (segment: string): boolean =>
	Arr.match(Arr.fromIterable(segment), {
		onEmpty: () => false,
		onNonEmpty: ([first, ...rest]) =>
			Str.includes(first)(OPENS) && Arr.every(rest, (char) => Str.includes(char)(SEGMENT))
	})

/** A plant path by its segments: test, plants, then segments, the last a name ending .patch. */
const isPlantPath = (word: string): boolean => {
	const [top, plants = "", ...rest] = Str.split("/")(word)
	return (
		top === "test" &&
		plants === "plants" &&
		Arr.every(rest, isSegment) &&
		Arr.match(rest, {
			onEmpty: () => false,
			onNonEmpty: (segments) => {
				const last = Arr.lastNonEmpty(segments)
				return (
					Str.endsWith(".patch")(last) &&
					isSegment(Str.slice(0, last.length - ".patch".length)(last))
				)
			}
		})
	)
}

type ReadingFeature =
	| "a citation on its tag's line"
	| "a citation whose bug carries over the lines below"
	| "a one-line citation"
	| "a tag naming no plant path"
	| "a tag naming no bug"
	| "a tag spelled in code"

/** What a tag states, its citation or its malformation, and the feature it is. */
type JudgedTag = readonly [
	Readonly<{ citation: ReadonlyArray<Citation>; malformed: ReadonlyArray<Malformed> }>,
	ReadingFeature
]

/** What a tag's words state, and the feature it is. */
const judgedTag = (
	line: number,
	text: string,
	own: ReadonlyArray<string>,
	carried: ReadonlyArray<string>,
	oneLine: boolean
): JudgedTag => {
	const words = Arr.appendAll(own, carried)
	return Arr.match(words, {
		onEmpty: () =>
			[{ citation: [], malformed: [{ line, text }] }, "a tag naming no plant path"] as const,
		onNonEmpty: ([first, ...bug]) =>
			!isPlantPath(first)
				? ([{ citation: [], malformed: [{ line, text }] }, "a tag naming no plant path"] as const)
				: Arr.isReadonlyArrayNonEmpty(bug)
					? ([
							{ citation: [{ plant: first, bug: Arr.join(bug, " "), line }], malformed: [] },
							oneLine
								? "a one-line citation"
								: Arr.isReadonlyArrayNonEmpty(carried)
									? "a citation whose bug carries over the lines below"
									: "a citation on its tag's line"
						] as const)
					: ([{ citation: [], malformed: [{ line, text }] }, "a tag naming no bug"] as const)
	})
}

/** The prose words right below item `at` of a comment, up to the first line that is not prose. */
const carriedAfter = (items: ReadonlyArray<Item>, at: number): ReadonlyArray<string> =>
	Arr.flatMap(
		Arr.takeWhile(Arr.drop(items, at + 1), (item: Item) => item.kind === "prose"),
		(item: Item) => (item.kind === "prose" ? item.words : [])
	)

/** The reading the drawn blocks state, and the features they reach, line by line from the first. */
const statedOf = (file: ReadonlyArray<Block>) => {
	const starts = Arr.scan(file, 1, (line, block) => line + blockLines(block).length)
	const judged = Arr.flatMap(
		Arr.zip(file, starts),
		([block, start]: readonly [Block, number]): ReadonlyArray<JudgedTag> => {
			switch (block.kind) {
				case "comment":
					return Arr.flatMap(block.items, (item: Item, at: number): ReadonlyArray<JudgedTag> =>
						item.kind === "tag"
							? [
									judgedTag(
										start + 1 + at,
										Str.trim(itemLine(block.indent, item)),
										item.words,
										carriedAfter(block.items, at),
										false
									)
								]
							: []
					)
				case "oneLine":
					return [
						judgedTag(start, Str.trim(Arr.headNonEmpty(blockLines(block))), block.words, [], true)
					]
				case "code":
					return []
			}
		}
	)
	return {
		citations: Arr.flatMap(judged, ([stated]: JudgedTag) => stated.citation),
		malformed: Arr.flatMap(judged, ([stated]: JudgedTag) => stated.malformed),
		features: [
			...Arr.map(judged, ([, feature]: JudgedTag) => feature),
			...(Arr.some(file, (block) => block.kind === "code")
				? ["a tag spelled in code" as const]
				: [])
		]
	}
}

/** The suites and names plants are drawn from: three suites holding three names, so two suites can share one. */
const POOL = Arr.flatMap(["unit/a", "unit/b", "pg/c"], (suite) =>
	Arr.map(["x", "y", "z"], (name) => `test/plants/${suite}/${name}.patch`)
)

/** A file under test/plants/ that no tag can name. */
const STRAY = "test/plants/unit/a/notes.md"

/** The sources a tree draws: three tests in three suites, and a support file. */
const SOURCES = [
	"test/unit/a/one.test.ts",
	"test/unit/b/two.test.ts",
	"test/pg/c/three.test.ts",
	"test/support/four.ts"
] as const

/** A source of a drawn tree: its path, the plants it cites, and whether it holds a malformed tag after them. */
interface DrawnSource {
	readonly path: string
	readonly cites: ReadonlyArray<string>
	readonly malformed: boolean
}

/** A drawn tree: its plant files and its sources. */
interface DrawnTree {
	readonly plants: ReadonlyArray<string>
	readonly sources: ReadonlyArray<DrawnSource>
}

/** Any tree over the pools: plants, a stray file among them, and sources citing any plants of the pool. */
const anyTreeGen: Gen<DrawnTree> = (source) => ({
	plants: source.draw(subset([...POOL, STRAY], { min: 0, max: 10 })),
	sources: Arr.map(source.draw(subset(SOURCES, { min: 1, max: 4 })), (path) => ({
		path,
		cites: source.draw(subset(POOL, { min: 0, max: 4 })),
		malformed: source.draw(boolean)
	}))
})

/** The tests among the sources. */
const TESTS = Arr.filter(SOURCES, (path) => Str.endsWith(".test.ts")(path))

/**
 * A tree built to pass: at most one plant under each name, each cited by some test, every test's tags well formed and
 * naming only those plants.
 */
const passingTreeGen: Gen<DrawnTree> = (source) => {
	const plants = Arr.flatMap(["x", "y", "z"], (name) =>
		Arr.map(
			source.draw(subset(["unit/a", "unit/b", "pg/c"], { min: 0, max: 1 })),
			(suite) => `test/plants/${suite}/${name}.patch`
		)
	)
	const tests = source.draw(subset(TESTS, { min: 1, max: TESTS.length }))
	const holders = Arr.map(plants, (plant) => [plant, source.draw(element([0, 1, 2]))] as const)
	return {
		plants,
		sources: Arr.map(tests, (path, at) => ({
			path,
			cites: Arr.map(
				Arr.filter(holders, ([, holder]) => holder % tests.length === at),
				([plant]) => plant
			),
			malformed: false
		}))
	}
}

const treeGen: Gen<DrawnTree> = weighted<DrawnTree>([
	[3, anyTreeGen],
	[1, passingTreeGen]
])

/** The malformed tag a source may hold. */
const MALFORMED_TAG = " * @plant test/plants/Bad.patch a plant the form refuses"

/** A source's text: a header citing its plants, one tag a line from the fourth, then its malformed tag. */
const sourceText = (drawnSource: DrawnSource): string =>
	`${Arr.join(
		[
			"/**",
			" * A header.",
			" *",
			...Arr.map(drawnSource.cites, (plant) => ` * @plant ${plant} the bug of ${plant}.`),
			...(drawnSource.malformed ? [MALFORMED_TAG] : []),
			" */",
			"export {}"
		],
		"\n"
	)}\n`

const treeOf = (drawnTree: DrawnTree): Tree => ({
	plants: drawnTree.plants,
	sources: Arr.map(drawnTree.sources, (drawnSource) => ({
		path: drawnSource.path,
		text: sourceText(drawnSource)
	}))
})

/** The first line a source's citations take. */
const FIRST_TAG_LINE = 4

const isTestPath = (path: string): boolean => Str.endsWith(".test.ts")(path)

/** The findings a drawn tree states. */
const statedFindings = (drawnTree: DrawnTree): ReadonlyArray<Finding> => {
	const plants = new Set(drawnTree.plants)
	const cited = new Set(Arr.flatMap(drawnTree.sources, (drawnSource) => drawnSource.cites))
	const ofSources = Arr.flatMap(drawnTree.sources, (drawnSource): ReadonlyArray<Finding> => [
		...Arr.flatMap(drawnSource.cites, (plant, at): ReadonlyArray<Finding> => {
			const where = { file: drawnSource.path, line: FIRST_TAG_LINE + at, plant }
			return [
				...(isTestPath(drawnSource.path) ? [] : [{ kind: "outsideTest" as const, ...where }]),
				...(plants.has(plant) ? [] : [{ kind: "dangling" as const, ...where }])
			]
		}),
		...(drawnSource.malformed
			? [
					{
						kind: "malformed" as const,
						file: drawnSource.path,
						line: FIRST_TAG_LINE + drawnSource.cites.length,
						text: Str.trim(MALFORMED_TAG)
					}
				]
			: [])
	])
	const uncited = Arr.map(
		Arr.filter(drawnTree.plants, (plant) => !cited.has(plant)),
		(plant): Finding => ({ kind: "uncited", plant })
	)
	const nameOf = (plant: string) => Arr.lastNonEmpty(Str.split("/")(plant))
	const shared = Arr.flatMap(
		Arr.dedupe(Arr.map(drawnTree.plants, nameOf)),
		(name): ReadonlyArray<Finding> => {
			const holding = Arr.filter(drawnTree.plants, (plant) => nameOf(plant) === name)
			return Arr.isReadonlyArrayNonEmpty(holding) && holding.length > 1
				? [{ kind: "sameName", name, plants: Arr.sort(holding, Order.String) }]
				: []
		}
	)
	return [...ofSources, ...uncited, ...shared]
}

/** Findings as a sorted list of their words, so a set of findings compares by what it holds. */
const asSet = (findings: ReadonlyArray<Finding>): ReadonlyArray<string> =>
	Arr.sort(Arr.map(findings, findingText), Order.String)

type JudgmentFeature =
	| "a malformed tag"
	| "a citation outside a test"
	| "a dangling citation"
	| "an uncited plant"
	| "two plants under one name"
	| "a tree the check passes"

/** A test that cites nothing, a name no citation answers to. */
const NOWHERE = "test/unit/a/none.test.ts"

/** Source files a plant's patch may change. */
const PATCHED = [
	"packages/engine/src/p.ts",
	"packages/engine/src/q.ts",
	"packages/engine/src/r.ts"
] as const

/** The ages a path may have: 0, the working tree, then the first, second and third newest commit. */
const AGES = [0, 1, 2, 3] as const

/**
 * A history over the pools: every plant and source an age, each changed file an age or none (no commit touched it), and
 * each plant of the pool the changed files its patch names.
 */
const sinceGen: Gen<Since> = (source) => ({
	ages: new Map([
		...Arr.map(
			[...POOL, STRAY, ...SOURCES, NOWHERE],
			(path) => [path, source.draw(element(AGES))] as const
		),
		...Arr.flatMap(PATCHED, (path) =>
			source.draw(boolean) ? [[path, source.draw(element(AGES))] as const] : []
		)
	]),
	patched: new Map(
		Arr.map(POOL, (plant) => [plant, source.draw(subset(PATCHED, { min: 0, max: 2 }))] as const)
	)
})

/** A drawn tree and what a run tries over it. */
interface DrawnPlan {
	readonly tree: DrawnTree
	readonly targets: Targets
}

const planGen: Gen<DrawnPlan> = (source) => ({
	tree: source.draw(treeGen),
	targets: source.draw(
		weighted<Targets>([
			[1, (s) => ({ kind: "changed", since: s.draw(sinceGen) })],
			[
				3,
				(s) => ({
					kind: "named",
					names: [
						s.draw(element([...SOURCES, ...POOL, NOWHERE])),
						...s.draw(subset([...SOURCES, ...POOL, NOWHERE], { min: 0, max: 2 }))
					]
				})
			]
		])
	)
})

/**
 * Whether the changed target retries a plant against a test, restated: unless the plant's age is a commit's, it never
 * ran at a commit; otherwise when the newest of its test's and its changed files' ages is newer than the plant's.
 */
const statedDue = (since: Since, pair: Readonly<{ test: string; plant: string }>): boolean => {
	const planted = since.ages.get(pair.plant)
	const watched = Arr.flatMap([pair.test, ...(since.patched.get(pair.plant) ?? [])], (path) =>
		Option.toArray(Option.fromUndefinedOr(since.ages.get(path)))
	)
	return (
		planted === undefined ||
		planted === 0 ||
		(Arr.isReadonlyArrayNonEmpty(watched) && Arr.min(watched, Order.Number) < planted)
	)
}

/** The plan a drawn tree and its targets state. */
const statedPlan = (
	plan: DrawnPlan
): Result.Result<ReadonlyArray<Trial>, Arr.NonEmptyReadonlyArray<string>> => {
	const pairs = Arr.flatMap(
		Arr.filter(plan.tree.sources, (drawnSource: DrawnSource) => isTestPath(drawnSource.path)),
		(drawnSource: DrawnSource) =>
			Arr.map(drawnSource.cites, (plant) => ({ test: drawnSource.path, plant }))
	)
	const answers = (name: string) => (pair: Readonly<{ test: string; plant: string }>) =>
		pair.test === name || pair.plant === name
	const unknown =
		plan.targets.kind === "changed"
			? []
			: Arr.filter(plan.targets.names, (name) => !Arr.some(pairs, answers(name)))
	if (Arr.isReadonlyArrayNonEmpty(unknown)) {
		return Result.fail(unknown)
	}
	const targets = plan.targets
	const picked =
		targets.kind === "changed"
			? Arr.filter(pairs, (pair) => statedDue(targets.since, pair))
			: Arr.filter(pairs, (pair) => Arr.some(targets.names, (name) => answers(name)(pair)))
	return Result.succeed(
		Arr.flatMap(
			Arr.sort(Arr.dedupe(Arr.map(picked, (pair) => pair.plant)), Order.String),
			(plant: string): ReadonlyArray<Trial> => {
				const tests = Arr.sort(
					Arr.dedupe(
						Arr.map(
							Arr.filter(picked, (pair) => pair.plant === plant),
							(pair) => pair.test
						)
					),
					Order.String
				)
				return Arr.isReadonlyArrayNonEmpty(tests) ? [{ plant, tests }] : []
			}
		)
	)
}

type PlanFeature =
	| "a plant no commit holds"
	| "a citation due by its test"
	| "a citation due by a file its plant changes alone"
	| "a citation nothing moved"
	| "a named test's plants"
	| "a named plant's tests"
	| "a plant two tests cite"
	| "a name that picks nothing"

/** The features a plan reaches. */
const notePlan = (
	plan: DrawnPlan,
	stated: ReturnType<typeof statedPlan>,
	c: Case<PlanFeature>
): void => {
	if (plan.targets.kind === "changed") {
		const { since } = plan.targets
		const age = (path: string) => since.ages.get(path)
		Arr.forEach(plan.tree.sources, (drawnSource: DrawnSource) => {
			if (!isTestPath(drawnSource.path)) {
				return
			}
			Arr.forEach(drawnSource.cites, (plant) => {
				const planted = age(plant)
				const test = age(drawnSource.path)
				const files = Arr.flatMap(since.patched.get(plant) ?? [], (path) =>
					Option.toArray(Option.fromUndefinedOr(age(path)))
				)
				if (planted === undefined || planted === 0) {
					c.note("a plant no commit holds")
				} else if (test !== undefined && test < planted) {
					c.note("a citation due by its test")
				} else if (Arr.some(files, (changed) => changed < planted)) {
					c.note("a citation due by a file its plant changes alone")
				} else {
					c.note("a citation nothing moved")
				}
			})
		})
	} else {
		if (Arr.some(plan.targets.names, isTestPath)) {
			c.note("a named test's plants")
		}
		if (Arr.some(plan.targets.names, (name) => Str.endsWith(".patch")(name))) {
			c.note("a named plant's tests")
		}
	}
	Result.match(stated, {
		onFailure: () => c.note("a name that picks nothing"),
		onSuccess: (trials) => {
			if (Arr.some(trials, (trial) => trial.tests.length > 1)) {
				c.note("a plant two tests cite")
			}
		}
	})
}

const steered = Object.freeze({ cases: 200, sense: notesOnly })

describe("readingOf", () => {
	it.effect(
		"reads every citation and malformed tag a file's comments state, and nothing its code spells",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the citations and malformed tags read off the drawn blocks, a tag's words its own and the prose lines below it"
						},
						suite: "unit/dev/plants-reading",
						draw: drawn(fileGen),
						literal: Formatter.format,
						coverage: required<ReadingFeature>(
							[
								"a citation on its tag's line",
								"a citation whose bug carries over the lines below",
								"a one-line citation",
								"a tag naming no plant path",
								"a tag naming no bug",
								"a tag spelled in code"
							],
							steered
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(file, c) =>
						Effect.sync(() => {
							const stated = statedOf(file)
							const read = readingOf(textOf(file))
							assert.deepEqual(read.citations, stated.citations)
							assert.deepEqual(read.malformed, stated.malformed)
							for (const feature of stated.features) {
								c.note(feature)
							}
						})
				)
			)
	)
})

describe("findingsOf", () => {
	it.effect(
		"finds exactly the malformed tags, misplaced and dangling citations, uncited plants and shared names",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "set differences over the drawn tree's citations and plants"
						},
						suite: "unit/dev/plants-findings",
						draw: drawn(treeGen),
						literal: Formatter.format,
						coverage: required<JudgmentFeature>(
							[
								"a malformed tag",
								"a citation outside a test",
								"a dangling citation",
								"an uncited plant",
								"two plants under one name",
								"a tree the check passes"
							],
							steered
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(drawnTree, c: Case<JudgmentFeature>) =>
						Effect.sync(() => {
							const stated = statedFindings(drawnTree)
							assert.deepEqual(asSet(findingsOf(treeOf(drawnTree))), asSet(stated))
							const kinds = new Set(Arr.map(stated, (finding) => finding.kind))
							const noted: ReadonlyArray<readonly [Finding["kind"], JudgmentFeature]> = [
								["malformed", "a malformed tag"],
								["outsideTest", "a citation outside a test"],
								["dangling", "a dangling citation"],
								["uncited", "an uncited plant"],
								["sameName", "two plants under one name"]
							]
							for (const [kind, feature] of noted) {
								if (kinds.has(kind)) {
									c.note(feature)
								}
							}
							if (!Arr.isReadonlyArrayNonEmpty(stated)) {
								c.note("a tree the check passes")
							}
						})
				)
			)
	)
})

describe("planOf", () => {
	it.effect(
		"tries each plant the targets pick with the tests citing it, or names the targets that pick nothing",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the drawn tests' citations each target picks, grouped by plant"
						},
						suite: "unit/dev/plants-plan",
						draw: drawn(planGen),
						literal: Formatter.format,
						coverage: required<PlanFeature>(
							[
								"a plant no commit holds",
								"a citation due by its test",
								"a citation due by a file its plant changes alone",
								"a citation nothing moved",
								"a named test's plants",
								"a named plant's tests",
								"a plant two tests cite",
								"a name that picks nothing"
							],
							steered
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(plan, c) =>
						Effect.sync(() => {
							const stated = statedPlan(plan)
							assert.deepEqual(planOf(treeOf(plan.tree), plan.targets), stated)
							notePlan(plan, stated, c)
						})
				)
			)
	)
})
