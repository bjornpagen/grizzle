import { regex } from "arkregex"
import { Array as Arr, Option, pipe, String as Str } from "effect"

/**
 * Where every plant lives, from the repository's root: test/plants/<suite>/<name>.patch, <suite> the directory under
 * test/ of the first test that cites it. A plant is a patch that breaks the code on purpose, and the tests citing it
 * must turn red while it is applied.
 */
export const plantRoot = "test/plants/"

/**
 * A plant's path as a citation must spell it: under plantRoot, lower-case segments that start with a letter or a digit
 * (so none is `.` or `..`), ending .patch.
 */
const plantPath = regex("^test/plants/(?:[a-z0-9][a-z0-9._-]*/)*[a-z0-9][a-z0-9._-]*\\.patch$")

/**
 * A plant tag, `@plant <path> <bug>`, on a JSDoc line (` * @plant …`) or opening a one-line JSDoc (`/** @plant … *\/`):
 * what follows the tag, and the comment's close when the line carries it.
 */
const tagLine = regex("^\\s*(?:/\\*\\*|\\*)\\s*@plant(?:\\s+(.*?))?\\s*(\\*/)?$")

/**
 * A line that carries on the tag above it: a JSDoc line holding text that opens no other tag, and the comment's close
 * when the line carries it.
 */
const continuation = regex("^\\s*\\*\\s+([^@\\s].*?)\\s*(\\*/)?$")

/** A test's citation of one plant: the plant's path, the bug the plant introduces, and the line its tag starts on. */
export interface Citation {
	readonly plant: string
	readonly bug: string
	readonly line: number
}

/** A plant tag the check cannot read: one whose first word is no plant path, or that names no bug. */
export interface Malformed {
	readonly line: number
	readonly text: string
}

/** What one file's comments say about plants: the citations its tags make, and the tags that make none. */
export interface Reading {
	readonly citations: ReadonlyArray<Citation>
	readonly malformed: ReadonlyArray<Malformed>
}

/** A tag being read: where it starts, what it says, the words of its bug so far, and whether its comment has closed. */
interface Open {
	readonly line: number
	readonly text: string
	readonly words: ReadonlyArray<string>
	readonly closed: boolean
}

/** A tag's words once read: a citation when its first word is a plant path and some bug follows it. */
const settled = (open: Open): Reading => {
	const [first = "", ...rest] = Arr.flatMap(open.words, (words) =>
		Arr.filter(Str.split(regex("\\s+"))(words), Str.isNonEmpty)
	)
	return plantPath.test(first) && Arr.isReadonlyArrayNonEmpty(rest)
		? { citations: [{ plant: first, bug: Arr.join(rest, " "), line: open.line }], malformed: [] }
		: { citations: [], malformed: [{ line: open.line, text: open.text }] }
}

/** Two readings, one after the other. */
const joined = (a: Reading, b: Reading): Reading => ({
	citations: Arr.appendAll(a.citations, b.citations),
	malformed: Arr.appendAll(a.malformed, b.malformed)
})

/** The state of the walk over a file's lines: what is read so far, and the tag still open. */
interface Walk {
	readonly read: Reading
	readonly open: Option.Option<Open>
}

/** One line's step: it opens a tag, carries on the open one, or closes it. */
const step = (walk: Walk, text: string, index: number): Walk => {
	const closeOpen = (): Reading =>
		Option.match(walk.open, {
			onNone: () => walk.read,
			onSome: (open) => joined(walk.read, settled(open))
		})
	const tag = tagLine.exec(text)
	if (tag !== null) {
		const open: Open = {
			line: index + 1,
			text: Str.trim(text),
			words: pipe(Option.fromNullishOr(tag[1]), Option.toArray),
			closed: tag[2] !== undefined
		}
		return { read: closeOpen(), open: Option.some(open) }
	}
	const carried = Option.flatMap(
		Option.filter(walk.open, (open) => !open.closed),
		(open) =>
			Option.map(Option.fromNullishOr(continuation.exec(text)), (more) => ({
				...open,
				words: Arr.append(open.words, more[1]),
				closed: more[2] !== undefined
			}))
	)
	return Option.match(carried, {
		onNone: () => ({ read: closeOpen(), open: Option.none() }),
		onSome: (open) => ({ read: walk.read, open: Option.some(open) })
	})
}

/**
 * What a file's text says about plants. A citation is a JSDoc block tag, `@plant <path> <bug>`: the plant's path from
 * the repository's root, under test/plants/ and ending .patch, then the bug the plant introduces, which may carry on
 * over the JSDoc lines below it until a blank line, another tag or the comment's close. A tag whose first word is no
 * such path, or that names no bug, is malformed.
 */
export const readingOf = (text: string): Reading => {
	const start: Walk = { read: { citations: [], malformed: [] }, open: Option.none() }
	const walked = Arr.reduce(Str.split("\n")(text), start, step)
	return Option.match(walked.open, {
		onNone: () => walked.read,
		onSome: (open) => joined(walked.read, settled(open))
	})
}
