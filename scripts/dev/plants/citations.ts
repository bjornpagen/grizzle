import { regex } from "arkregex"
import { Array as Arr, Option, Order, pipe, String as Str } from "effect"

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

/**
 * A line the check refuses, by what is wrong with it:
 * - `malformed`: a plant tag whose first word is no plant path, or that names no bug;
 * - `prose`: the word Plant or Plants, capitalized, in a comment outside a plant tag, which is how every citation
 *   began before plants had a home (a name in prose, which no check can resolve);
 * - `lost`: a plant directory outside the repository, ~/.cache/grizzle-release/<lane>/plants, where the plants the
 *   old VM took with it lived.
 */
export interface Refusal {
	readonly kind: "malformed" | "prose" | "lost"
	readonly line: number
	readonly text: string
}

/** What one file says about plants: the citations its tags make, and the lines the check refuses. */
export interface Reading {
	readonly citations: ReadonlyArray<Citation>
	readonly refusals: ReadonlyArray<Refusal>
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
		? { citations: [{ plant: first, bug: Arr.join(rest, " "), line: open.line }], refusals: [] }
		: { citations: [], refusals: [{ kind: "malformed", line: open.line, text: open.text }] }
}

/** A line of a comment: one that opens a block comment, carries one on (` * …`), or is a line comment. */
const commentLine = regex("^\\s*(?:/\\*|\\*|//)")

/** The word every old citation began with: Plant or Plants, capitalized, as a whole word. */
const proseCitation = regex("\\bPlants?\\b")

/** A plant directory outside the repository, as the old citations spelled it. */
const lostDirectory = regex("grizzle-release/[^/\\s]+/plants")

/**
 * What the check refuses on a line beyond its tags: a lost plant directory on any line, or, on a comment line no plant
 * tag holds, the capitalized word of the old citations.
 */
const refusedLine = (text: string, line: number, tagged: boolean): ReadonlyArray<Refusal> =>
	lostDirectory.test(text)
		? [{ kind: "lost", line, text: Str.trim(text) }]
		: !tagged && commentLine.test(text) && proseCitation.test(text)
			? [{ kind: "prose", line, text: Str.trim(text) }]
			: []

/** Two readings, one after the other. */
const joined = (a: Reading, b: Reading): Reading => ({
	citations: Arr.appendAll(a.citations, b.citations),
	refusals: Arr.appendAll(a.refusals, b.refusals)
})

/** The state of the walk over a file's lines: what is read so far, and the tag still open. */
interface Walk {
	readonly read: Reading
	readonly open: Option.Option<Open>
}

/** A reading that holds a line's refusals and nothing else. */
const refusalsOf = (refusals: ReadonlyArray<Refusal>): Reading => ({ citations: [], refusals })

/**
 * One line's step: it opens a tag, carries on the open one, or closes it, and the line's own refusals are read beside
 * it, a tag's lines refused only for a lost directory.
 */
const step = (walk: Walk, text: string, index: number): Walk => {
	const line = index + 1
	const closeOpen = (): Reading =>
		Option.match(walk.open, {
			onNone: () => walk.read,
			onSome: (open) => joined(walk.read, settled(open))
		})
	const tag = tagLine.exec(text)
	if (tag !== null) {
		const open: Open = {
			line,
			text: Str.trim(text),
			words: pipe(Option.fromNullishOr(tag[1]), Option.toArray),
			closed: tag[2] !== undefined
		}
		return {
			read: joined(closeOpen(), refusalsOf(refusedLine(text, line, true))),
			open: Option.some(open)
		}
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
		onNone: () => ({
			read: joined(closeOpen(), refusalsOf(refusedLine(text, line, false))),
			open: Option.none()
		}),
		onSome: (open) => ({
			read: joined(walk.read, refusalsOf(refusedLine(text, line, true))),
			open: Option.some(open)
		})
	})
}

/** Refusals in line order, and on one line in the order of their kinds' names. */
const refusalOrder: Order.Order<Refusal> = Order.combine(
	Order.mapInput(Order.Number, (refusal: Refusal) => refusal.line),
	Order.mapInput(Order.String, (refusal: Refusal) => refusal.kind)
)

/**
 * What a file's text says about plants. A citation is a JSDoc block tag, `@plant <path> <bug>`: the plant's path from
 * the repository's root, under test/plants/ and ending .patch, then the bug the plant introduces, which may carry on
 * over the JSDoc lines below it until a blank line, another tag or the comment's close. A tag whose first word is no
 * such path, or that names no bug, is malformed. Any line naming a plant directory outside the repository is lost, and
 * a comment line outside a tag holding the capitalized word Plant or Plants is prose: both are the old citations'
 * forms, which named plants no check could find. Citations come in line order, and so do refusals.
 */
export const readingOf = (text: string): Reading => {
	const start: Walk = { read: { citations: [], refusals: [] }, open: Option.none() }
	const walked = Arr.reduce(Str.split("\n")(text), start, step)
	const read = Option.match(walked.open, {
		onNone: () => walked.read,
		onSome: (open) => joined(walked.read, settled(open))
	})
	return { citations: read.citations, refusals: Arr.sort(read.refusals, refusalOrder) }
}
