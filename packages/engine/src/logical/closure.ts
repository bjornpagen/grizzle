import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { postorder, stronglyConnected } from "@bjornpagen/grizzle-text/base/graph"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	lastNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { type Dependency, type Implication, implication } from "#compiler/ir/keys.ts"
import type { KeySet } from "#compiler/ir/rel.ts"
import {
	type Attributes,
	addTo,
	type Bits,
	capacityOf,
	copyBits,
	dropFrom,
	emptyLike,
	holdsAt,
	holdsName,
	lowest,
	intersect,
	minus,
	namesOf,
	noBits,
	positions,
	pushPositions,
	sizeOf,
	union,
	subsetOf
} from "#compiler/logical/attributes.ts"

/**
 * Closure over a node's stated dependencies, and the minimal-key search, over the node's attributes interned
 * (logical/attributes.ts): a set of attributes is a bitset, so a step's test that its determinants are reached is a
 * word-wise subset and its firing an OR.
 *
 * A closure is what a start determines under the dependencies, each column with the dependency that first reached it:
 * the steps that name the value they fix a column to fire first, in table order until none adds a column, then every
 * step, in table order until none adds a column. So a column fixed both by a step that names its value and by one that
 * does not is reached by the first, and the value it holds is read off its derivation. Its derivation of some targets is
 * the dependencies that reached them, transitively, in the order they first fired, which is an order in which each
 * one's determinants are known: an Implication (ir/keys.ts).
 *
 * Each round is at most one pass more than the columns it adds, since a pass that adds none ends it, so a closure
 * visits each of the node's dependencies at most once for each attribute it adds and twice more: its work is bounded by
 * its dependencies times its attributes, each visit a few words (test/unit/analysis/logical/closure-cost.test.ts).
 *
 * The minimal keys are found by Lucchesi and Osborn's exchange: every minimal key follows from any other by exchanging
 * the columns a dependency determines for its determinants and minimizing, so the keys the seeds minimize to, closed
 * under the exchange over every stated dependency, are every minimal key the dependencies prove. The search has no bound:
 * its work grows with the keys it finds, and no key is dropped.
 */

/**
 * A dependency a table states, interned: the dependency itself, `D` (a node's logical dependency, ir/keys.ts, or a
 * physical implication with its justification, analysis/physical/fds.ts), its determinants as a set, its targets that
 * are attributes, in its order and as a set, the set a closure's visit reads to know in a few words that it has none
 * left to reach, and the evidence stage it holds through: its index among its table's stages, 0 the least demanding,
 * which every row of a table of one stage, a logical one among them, holds.
 */
export interface Row<D = Dependency> {
	readonly dependency: D
	readonly from: Bits
	readonly to: ReadonlyArray<number>
	readonly targets: Bits
	readonly stage: number
}

/**
 * A node's dependencies as its closures read them: over its attributes interned, each a row, in table order, with the
 * index a closure fires them by (Beeri and Bernstein's LINCLOSURE, below): each row's determinants counted, and each
 * position's rows reading it.
 */
export interface Rows<D = Dependency> {
	readonly attributes: Attributes
	readonly rows: ReadonlyArray<Row<D>>
	/** Each row's determinants, counted: the positions a closure waits for before the row fires. */
	readonly determinants: Int32Array
	/**
	 * Each position's rows that read it among their determinants, ascending, packed: position p's are `readers` from
	 * `readersAt[p]` to `readersAt[p + 1]`.
	 */
	readonly readersAt: Int32Array
	readonly readers: Int32Array
	/** The one set of buffers every closure over the rows runs in, one closure at a time (Closing). */
	readonly buffers: ClosureBuffers
	/** The most demanding stage a row of the table holds through: 0 for a table of one stage, a logical one among them. */
	readonly highest: number
	/**
	 * The table through each stage less demanding than its highest, by the stage's index: the rows holding through it,
	 * those of its stage or of a less demanding one, in table order (rowsThrough); none for a table of one stage.
	 */
	readonly below: ReadonlyArray<Rows<D>>
}

/** The tables below a table of one stage: none. */
const noneBelow: ReadonlyArray<never> = Object.freeze([])

/**
 * `rows` through the evidence stage at `stage`: the rows holding through it, those of its stage or of a less demanding
 * one, in table order; the table itself through any stage at or past its rows' most demanding. A closure through a
 * stage is a closure of its table (closure), so the rows the stage does not admit never fire, and those it admits fire
 * as the passes over the table would fire them were the others not there.
 */
export const rowsThrough = <D>(rows: Rows<D>, stage: number): Rows<D> =>
	stage >= rows.highest
		? rows
		: defined(rows.below[stage], "a table holds each stage below its highest")

/**
 * What a closure over a table keeps of each row while it runs, held by the table for every closure over it: each row's
 * marks and its determinants not reached yet, the rows due, and the rows the closure touched. Between closures every
 * mark is clear and every count is its row's determinants (Rows determinants), so a closure begins at once and, when it
 * ends, sets back only the rows it touched: its work is what it reads, never the table's size twice over.
 */
interface ClosureBuffers {
	readonly marks: Uint8Array
	readonly missing: Int32Array
	readonly due: PassQueue
	readonly touched: Array<number>
}

/** Rows over `attributes`, indexed: each row's determinants counted, each position's readers packed. */
const indexed = <D>(attributes: Attributes, rows: ReadonlyArray<Row<D>>): Rows<D> => {
	const size = attributes.names.length
	const determinants = new Int32Array(rows.length)
	const readersAt = new Int32Array(size + 1)
	/** One row's determinants at a time, read out of its set. */
	const from: Array<number> = []
	for (let i = 0; i < rows.length; i++) {
		from.length = 0
		pushPositions(from, defined(rows[i], "a row of the table").from)
		determinants[i] = from.length
		for (const p of from) {
			readersAt[p + 1] = (readersAt[p + 1] ?? 0) + 1
		}
	}
	for (let p = 0; p < size; p++) {
		readersAt[p + 1] = (readersAt[p + 1] ?? 0) + (readersAt[p] ?? 0)
	}
	const readers = new Int32Array(readersAt[size] ?? 0)
	const filled = readersAt.slice(0, size)
	for (let i = 0; i < rows.length; i++) {
		from.length = 0
		pushPositions(from, defined(rows[i], "a row of the table").from)
		for (const p of from) {
			const at = filled[p] ?? 0
			readers[at] = i
			filled[p] = at + 1
		}
	}
	const buffers: ClosureBuffers = {
		marks: new Uint8Array(rows.length),
		missing: determinants.slice(),
		due: new PassQueue(rows.length),
		touched: []
	}
	const highest = rows.reduce((most, row) => Math.max(most, row.stage), 0)
	const below =
		highest === 0
			? noneBelow
			: Array.from({ length: highest }, (_, stage) =>
					indexed(
						attributes,
						rows.filter((row) => row.stage <= stage)
					)
				)
	return { attributes, rows, determinants, readersAt, readers, buffers, highest, below }
}

/** The set of a dependency's determinants `columns`, every one an attribute of its node. */
const determinantsAt = (attributes: Attributes, columns: ReadonlyArray<string>): Bits => {
	const out = noBits(attributes)
	for (const c of columns) {
		addTo(
			out,
			defined(attributes.at.get(c), "a dependency's determinant is an attribute of its node")
		)
	}
	return out
}

/** The positions of the attributes among `columns`, in their order; a name the node lacks has none. */
const positionsIn = (
	attributes: Attributes,
	columns: ReadonlyArray<string>
): ReadonlyArray<number> => {
	const out: Array<number> = []
	for (const c of columns) {
		const p = attributes.at.get(c)
		if (p !== undefined) {
			out.push(p)
		}
	}
	return out
}

/**
 * A node's dependencies interned over its attributes: each one's determinants, every one an attribute of the node, as
 * every builder of a node's dependencies states them (logical/props.ts), and its targets among the attributes.
 */
export const rowsOf = (attributes: Attributes, dependencies: ReadonlyArray<Dependency>): Rows =>
	rowsOver(
		attributes,
		dependencies.map((dependency) => ({
			dependency,
			from: determinantsAt(attributes, dependency.from),
			to: positionsIn(attributes, dependency.to),
			stage: 0
		}))
	)

/**
 * A table of `entries` over `attributes`, each a dependency `D` with its determinants as a set, its targets among the
 * attributes in its order and the evidence stage it holds through: the one table every closure reads, a node's logical
 * dependencies (rowsOf) and a fragment's physical implications alike.
 */
export const rowsOver = <D>(
	attributes: Attributes,
	entries: ReadonlyArray<{
		readonly dependency: D
		readonly from: Bits
		readonly to: ReadonlyArray<number>
		readonly stage: number
	}>
): Rows<D> =>
	indexed(
		attributes,
		entries.map((entry) => {
			const targets = noBits(attributes)
			for (const p of entry.to) {
				addTo(targets, p)
			}
			return { ...entry, targets }
		})
	)

/** The rows of a node's dependencies `kept` holds, in table order: a closure over some of its dependencies. */
export const rowsAmong = <D>(rows: Rows<D>, kept: ReadonlyArray<Row<D>>): Rows<D> =>
	indexed(rows.attributes, kept)

/**
 * What a start determines at a node, each position reached with how: the start's, ascending, then each step's targets in
 * the order its dependency states them, as the step fired; the row each step's targets were reached by; and the value
 * each column a step naming its value reached holds.
 */
export interface Closure<V, D = Dependency> {
	readonly rows: Rows<D>
	/** The start, which the closure keeps: the caller never changes it. */
	readonly start: Bits
	readonly reached: Bits
	/** The positions reached, in the order reached. */
	readonly sequence: ReadonlyArray<number>
	/** How each position was reached, by its row's index plus one: 0 by the start, or for a position not reached. */
	readonly by: Int32Array
	/** The indexes of the rows that reached a position, in the order they first did. */
	readonly fired: ReadonlyArray<number>
	readonly named: ReadonlyMap<number, V>
}

/**
 * Where a step reads the value it fixes one of its targets to: a value of its own (a literal, a parameter, a column an
 * input fixes), the value named of another attribute of the node (an equality's), or none.
 */
export type NameSource<V> =
	| { readonly kind: "value"; readonly value: V }
	| { readonly kind: "copy"; readonly at: number }
	| { readonly kind: "none" }

/** A step that names none of its targets. */
export const namesNone: NameSource<never> = Object.freeze({ kind: "none" })

/**
 * What names the values a closure's steps fix its columns to: nothing, or each row's sources, one for each of its targets
 * in its order (namingOver), with the rows that copy each attribute's value, packed as Rows readers are.
 */
export type Naming<V> =
	| { readonly kind: "none" }
	| {
			readonly kind: "named"
			readonly sources: ReadonlyArray<ReadonlyArray<NameSource<V>>>
			/** Whether each row names any target: a source of each kind but none. */
			readonly names: Uint8Array
			readonly copiersAt: Int32Array
			readonly copiers: Int32Array
	  }

/**
 * The naming of `rows` whose row at i reads the value it fixes its target at j from `sources[i][j]`: the sources as data,
 * read by every named closure over the rows, and the rows each attribute's value is copied by. Rows none of which names
 * a target are named by nothing (namesNothing), whose closure is the same; a row that names none holds no sources.
 */
export const namingOver = <V, D>(
	rows: Rows<D>,
	sources: ReadonlyArray<ReadonlyArray<NameSource<V>>>
): Naming<V> => {
	const size = rows.attributes.names.length
	const names = new Uint8Array(rows.rows.length)
	const copiersAt = new Int32Array(size + 1)
	sources.forEach((row, i) => {
		for (const source of row) {
			if (source.kind !== "none") {
				names[i] = 1
			}
			if (source.kind === "copy") {
				copiersAt[source.at + 1] = (copiersAt[source.at + 1] ?? 0) + 1
			}
		}
	})
	for (let p = 0; p < size; p++) {
		copiersAt[p + 1] = (copiersAt[p + 1] ?? 0) + (copiersAt[p] ?? 0)
	}
	const copiers = new Int32Array(copiersAt[size] ?? 0)
	const filled = copiersAt.slice(0, size)
	sources.forEach((row, i) => {
		for (const source of row) {
			if (source.kind !== "copy") {
				continue
			}
			const at = filled[source.at] ?? 0
			copiers[at] = i
			filled[source.at] = at + 1
		}
	})
	if (!names.includes(1)) {
		return namesNothing
	}
	return {
		kind: "named",
		sources: sources.map((row, i) => (names[i] === 1 ? row : namesNoTarget)),
		names,
		copiersAt,
		copiers
	}
}

/**
 * The sources of a row that names none of its targets, which a closure never asks (it asks only a row that names one,
 * Naming names), so every such row of every node holds this one.
 */
const namesNoTarget: ReadonlyArray<never> = Object.freeze([])

/** A closure that names nothing: what each column is reached by, whatever value it holds. */
export const namesNothing: Naming<never> = Object.freeze({ kind: "none" })

/** Which steps a round of a closure lets reach a column: those its naming names the column by, or every step. */
type Admission<V> = Extract<Naming<V>, { readonly kind: "named" }> | { readonly kind: "every" }

const every: Admission<never> = Object.freeze({ kind: "every" })

/**
 * Every attribute `start` determines under `rows`: first by the steps `naming` gives a value, each target by its source
 * (a value of the step's own, or the value named of another attribute so far), then by every step. A closure that names
 * nothing has the second round alone, since the first would reach no column.
 *
 * Each round fires the rows as passes over them in table order until a pass adds no column would, and a step fires at its
 * turn in the pass once its determinants are reached. A row's standing only advances: its determinants not all reached
 * yet; asked, each target it did not reach then unnamed by its source; or every target reached, so it adds nothing
 * again. A pass visits again only what can still add a column: a row whose determinants were not all reached, or one
 * asked that copies a value named since, since a source of its own names the same value whenever it is asked, and a
 * target reached since only leaves it fewer to ask about. A visit it skips is one that would add nothing and learn
 * nothing, so the columns, each one's step and the order the steps fire in are the passes' own: a row whose every source
 * names nothing is never asked, as asking it adds nothing. A step's targets are reached when its visit ends, each once,
 * so a target it lists twice is asked about twice.
 *
 * The passes are never run: a row is visited only once it can add a column, as Beeri and Bernstein's LINCLOSURE fires a
 * dependency ("Computational Problems Related to the Design of Normal Form Relational Schemas", ACM TODS 4(1), 1979):
 * each row counts its determinants not reached yet, each position reached counts down the rows reading it (Rows
 * readers), and a row whose count reaches nothing is due, as is an asked row once a value it copies is named (Naming
 * copiers). A row due while the passes would be at a row before it is visited in that pass, at its turn, and one due at
 * or after it in the next (PassQueue), so the visits are the passes' visits that add or learn something, in the passes'
 * order. A closure that names nothing visits each row at most once and tests each row whether to visit it once and again
 * for each of its determinants reached: its work is its rows, their determinants and targets, and a word of the due rows
 * for each 32 rows a pass reads past (test/unit/analysis/logical/closure-cost.test.ts).
 */
export const closure = <V, D = Dependency>(
	rows: Rows<D>,
	start: Bits,
	naming: Naming<V>
): Closure<V, D> => {
	const run = new Closing<V, D>(rows, start)
	if (naming.kind === "named") {
		run.reach(naming)
	}
	run.reach(every)
	run.release()
	return run.closure()
}

/** One closure's run (closure): what it has reached so far and how, and each row's standing. */
class Closing<V, D> {
	readonly #rows: Rows<D>
	readonly #start: Bits
	readonly #reached: Bits
	readonly #sequence: Array<number>
	readonly #by: Int32Array
	readonly #fired: Array<number> = []
	/** The values named so far, by position: none until a step names one. */
	#named: Map<number, V> | undefined
	/**
	 * Each row's marks: spent, every target it can reach reached; fired, a target reached by it; asked, asked in the
	 * round of namings since a value it copies was last named, so asking it again names nothing; and touched, set back
	 * when the closure ends (release). The table's buffers (Rows buffers), as its count of each row's determinants not
	 * reached yet and its rows due are.
	 */
	readonly #marks: Uint8Array
	/** Each row's determinants not reached yet. */
	readonly #missing: Int32Array
	readonly #due: PassQueue
	/** The rows whose mark or count this closure changed, each once: what release sets back. */
	readonly #touched: Array<number>
	/**
	 * The positions a visit adds, one visit's at a time: in the round of namings, each one it names, since a visit there
	 * adds only a target it names.
	 */
	readonly #added: Array<number> = []

	constructor(rows: Rows<D>, start: Bits) {
		const { attributes, readersAt, readers, buffers } = rows
		this.#rows = rows
		this.#start = start
		this.#reached = copyBits(start)
		this.#sequence = positions(start)
		this.#by = new Int32Array(attributes.names.length)
		this.#marks = buffers.marks
		this.#missing = buffers.missing
		this.#due = buffers.due
		this.#touched = buffers.touched
		for (const p of this.#sequence) {
			for (let r = readersAt[p] ?? 0; r < (readersAt[p + 1] ?? 0); r++) {
				this.#count(readers[r] ?? 0)
			}
		}
	}

	/** A determinant of the row at `i` reached: one fewer missing, the row touched. */
	#count(i: number): void {
		this.#touch(i)
		this.#missing[i] = (this.#missing[i] ?? 0) - 1
	}

	/** The row at `i` touched by this closure, once: set back when it ends (release). */
	#touch(i: number): void {
		const mark = this.#marks[i] ?? 0
		if ((mark & touchedMark) === 0) {
			this.#marks[i] = mark | touchedMark
			this.#touched.push(i)
		}
	}

	/**
	 * The table's buffers as they were before the closure, once its rounds have run: each row it touched unmarked and
	 * missing all its determinants again. No row is due, since every round runs until none is, so the next closure over
	 * the table begins where this one did.
	 */
	release(): void {
		const determinants = this.#rows.determinants
		for (const i of this.#touched) {
			this.#marks[i] = 0
			this.#missing[i] = determinants[i] ?? 0
		}
		this.#touched.length = 0
	}

	/** The closure reached. */
	closure(): Closure<V, D> {
		return {
			rows: this.#rows,
			start: this.#start,
			reached: this.#reached,
			sequence: this.#sequence,
			by: this.#by,
			fired: this.#fired,
			named: this.#named ?? namedNothing
		}
	}

	/**
	 * Whether a pass would visit the row at `i` and add or learn something: its determinants reached and a target left to
	 * reach, and in the round of namings a target it names, not asked since a value it copies was last named.
	 */
	visits(i: number, admission: Admission<V>): boolean {
		const marks = this.#marks
		return (
			this.#missing[i] === 0 &&
			((marks[i] ?? 0) & spentMark) === 0 &&
			(admission.kind === "every" ||
				(admission.names[i] === 1 && ((marks[i] ?? 0) & askedMark) === 0))
		)
	}

	/** A visit of the row at `i`, adding the attributes it reaches, each row it makes due due. */
	step(row: Row<D>, i: number, admission: Admission<V>): void {
		const { readersAt, readers } = this.#rows
		const reached = this.#reached
		const marks = this.#marks
		const added = this.#added
		this.#touch(i)
		if (subsetOf(row.targets, reached)) {
			marks[i] = (marks[i] ?? 0) | spentMark
			return
		}
		added.length = 0
		let unreached = 0
		const targets = row.to
		for (let j = 0; j < targets.length; j++) {
			const p = targets[j] ?? 0
			if (holdsAt(reached, p)) {
				continue
			}
			unreached++
			if (admission.kind === "every") {
				added.push(p)
				continue
			}
			const source = admission.sources[i]?.[j] ?? namesNone
			const value =
				source.kind === "value"
					? source.value
					: source.kind === "copy"
						? this.#named?.get(source.at)
						: undefined
			if (value !== undefined) {
				this.#named ??= new Map()
				this.#named.set(p, value)
				added.push(p)
			}
		}
		marks[i] = (marks[i] ?? 0) | (added.length === unreached ? spentMark : askedMark)
		if (added.length > 0 && ((marks[i] ?? 0) & firedMark) === 0) {
			marks[i] = (marks[i] ?? 0) | firedMark
			this.#fired.push(i)
		}
		for (const p of added) {
			if (holdsAt(reached, p)) {
				continue
			}
			addTo(reached, p)
			this.#by[p] = i + 1
			this.#sequence.push(p)
			for (let r = readersAt[p] ?? 0; r < (readersAt[p + 1] ?? 0); r++) {
				const j = readers[r] ?? 0
				this.#count(j)
				if (this.visits(j, admission)) {
					this.#due.add(j)
				}
			}
		}
		if (admission.kind === "named") {
			for (const p of added) {
				for (let r = admission.copiersAt[p] ?? 0; r < (admission.copiersAt[p + 1] ?? 0); r++) {
					const j = admission.copiers[r] ?? 0
					this.#touch(j)
					marks[j] = (marks[j] ?? 0) & ~askedMark
					if (this.visits(j, admission)) {
						this.#due.add(j)
					}
				}
			}
		}
	}

	/** A round: every row the first pass would visit due, then each due row visited in the passes' order. */
	reach(admission: Admission<V>): void {
		const table = this.#rows.rows
		const due = this.#due
		due.restart()
		for (let i = 0; i < table.length; i++) {
			if (this.visits(i, admission)) {
				due.add(i)
			}
		}
		for (let i = due.next(); i !== undefined; i = due.next()) {
			this.step(defined(table[i], "a due row is its closure's"), i, admission)
		}
	}
}

/**
 * The rows due in a round, in the order passes over the table in table order would visit them: a row due while the passes
 * are at a row before it in this pass, a row due at or after it in the next. Each pass's due rows are a bitset over the
 * rows, read upward from the row the passes are at, a word at a time; the next pass's become this pass's once this
 * pass holds none after it.
 */
class PassQueue {
	readonly #words: number
	/** This pass's due rows and the next pass's, `#words` words each, at `#now` and `#later` in one array. */
	readonly #bits: Uint32Array
	#now = 0
	#later: number
	#at = -1

	constructor(size: number) {
		this.#words = (size + 31) >>> 5
		this.#bits = new Uint32Array(2 * this.#words)
		this.#later = this.#words
	}

	/** Holds the row at `i` due: in this pass after the row visited, else in the next. */
	add(i: number): void {
		const into = i > this.#at ? this.#now : this.#later
		const w = into + (i >>> 5)
		this.#bits[w] = (this.#bits[w] ?? 0) | (1 << (i & 31))
	}

	/** The next due row in the passes' order, none when no row is due. */
	next(): number | undefined {
		const here = this.#take(this.#now, this.#at + 1)
		if (here !== undefined) {
			this.#at = here
			return here
		}
		const swapped = this.#now
		this.#now = this.#later
		this.#later = swapped
		const first = this.#take(this.#now, 0)
		this.#at = first ?? -1
		return first
	}

	/** A new round's passes: the first, before its first row. */
	restart(): void {
		this.#at = -1
	}

	/** The least row of the pass at `base` at `from` or after, clearing it; none when it holds none there. */
	#take(base: number, from: number): number | undefined {
		const bits = this.#bits
		for (let w = from >>> 5; w < this.#words; w++) {
			const word = (bits[base + w] ?? 0) & (w === from >>> 5 ? ~0 << (from & 31) : ~0)
			if (word === 0) {
				continue
			}
			const bit = 31 - Math.clz32(word & -word)
			bits[base + w] = (bits[base + w] ?? 0) & ~(1 << bit)
			return (w << 5) + bit
		}
		return undefined
	}
}

/** A row's mark that every target it can reach is reached, so it adds nothing again. */
const spentMark = 1

/** A row's mark that it reached a column, so it is among the closure's fired rows. */
const firedMark = 2

/** A row's mark that it was asked in the round of namings since a value it copies was last named. */
const askedMark = 4

/** A row's mark that the closure running changed its mark or its count, so the closure sets it back when it ends. */
const touchedMark = 8

/** The values of a closure that named none. */
const namedNothing: ReadonlyMap<number, never> = new Map<number, never>()

/** Whether a closure holds every attribute of `targets`. */
export const covers = <V, D>(c: Closure<V, D>, targets: Bits): boolean =>
	subsetOf(targets, c.reached)

/** Whether a closure holds the attribute named `column`: never a name its node lacks. */
export const reaches = <V, D>(c: Closure<V, D>, column: string): boolean =>
	holdsName(c.rows.attributes, c.reached, column)

/** The positions a closure reached past its start, in the order reached. */
export const stepsOf = <V, D>(c: Closure<V, D>): ReadonlyArray<number> =>
	c.sequence.filter((p) => !holdsAt(c.start, p))

/**
 * The rows that reached `targets` (positions of the closure's attributes), transitively, in the order they first fired:
 * a target the closure did not reach, or reached from the start, needs none.
 */
export const derivationRows = <V, D>(
	c: Closure<V, D>,
	targets: Iterable<number>
): ReadonlyArray<Row<D>> => {
	const table = c.rows.rows
	const used = new Uint8Array(table.length)
	const seen = emptyLike(c.reached)
	const stack = [...targets]
	for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
		if (holdsAt(seen, p)) {
			continue
		}
		addTo(seen, p)
		const how = c.by[p]
		if (how === undefined || how === 0) {
			continue
		}
		if (used[how - 1] === 1) {
			continue
		}
		used[how - 1] = 1
		pushPositions(stack, defined(table[how - 1], "a step's row is its closure's").from)
	}
	const rows: Array<Row<D>> = []
	for (const i of c.fired) {
		if (used[i] === 1) {
			rows.push(defined(table[i], "a fired row is its closure's"))
		}
	}
	return rows
}

/**
 * The derivation that the closure's start determines `targets`, positions of its attributes: the dependencies that
 * reached them, transitively, in the order they first fired. Every target is in the closure.
 */
export const derivation = <V>(c: Closure<V>, targets: Iterable<number>): Implication =>
	implication(
		namesOf(c.rows.attributes, c.start),
		derivationRows(c, targets).map((row) => row.dependency)
	)

/**
 * The order of keys over attributes in heading order: the smaller first, then the one holding the first attribute that
 * only one of them holds, which is where the two, read in heading order, first differ.
 */
const keyOrder = (a: Bits, b: Bits): number => {
	const sizeA = sizeOf(a)
	const sizeB = sizeOf(b)
	if (sizeA !== sizeB) {
		return sizeA - sizeB
	}
	const first = lowest(union(minus(a, b), minus(b, a)))
	return first === undefined ? 0 : holdsAt(a, first) ? -1 : 1
}

/** The given columns that a heading has, each once, in heading order. */
export const inHeadingOrder = (columns: ReadonlyArray<string>, given: Iterable<string>): KeySet => {
	const set = new Set(given)
	return columns.filter((c) => set.has(c))
}

/**
 * The minimal keys `witness` proves among `columns`, each with the witness it gave for that key: each seed, its columns
 * among `columns`, minimized greedily from the end of the heading, closed under the exchange over `dependencies` (each
 * `from` for the columns `closureOf` gives it), as a sorted antichain. A superset of a key found is no new key. The
 * iteration reaches the keys the exchange appends to `found` as well.
 */
export const minimalKeys = <W>(
	columns: Bits,
	seeds: Iterable<Bits>,
	witness: (key: Bits) => W | undefined,
	dependencies: ReadonlyArray<{ readonly from: Bits; readonly to: Bits }>
): ReadonlyArray<{ readonly key: Bits; readonly witness: W }> => {
	const found: Array<{ readonly key: Bits; readonly witness: W }> = []
	const index = keyTrie()
	/** Whether a key found is a subset of `set`. */
	const contains = (set: Bits) => keyWithin(index, positions(set), 0, sizeOf(set) + 1, 0)
	const add = (candidate: Bits): void => {
		const key = intersect(candidate, columns)
		const proved = contains(key) ? undefined : witness(key)
		if (proved === undefined) {
			return
		}
		let shrunk = { key, witness: proved }
		const at = positions(key)
		for (let i = at.length - 1; i >= 0; i--) {
			const p = at[i] ?? 0
			const without = copyBits(shrunk.key)
			dropFrom(without, p)
			const w = witness(without)
			if (w !== undefined) {
				shrunk = { key: without, witness: w }
			}
		}
		if (!contains(shrunk.key)) {
			found.push(shrunk)
			insertKey(index, shrunk.key)
		}
	}
	for (const seed of seeds) {
		add(seed)
	}
	for (const { key } of found) {
		for (const d of dependencies) {
			add(union(d.from, minus(key, d.to)))
		}
	}
	const antichain = found.filter((k) => !keyWithin(index, positions(k.key), 0, sizeOf(k.key), 0))
	return antichain.toSorted((a, b) => keyOrder(a.key, b.key))
}

/**
 * The keys a search found, as a set-trie (Savnik, "Index Data Structure for Fast Subset and Superset Queries", CD-ARES
 * 2013): each key the path of its positions ascending from the root, its last node marking it. Whether a key found is a
 * subset of a set walks only the paths of the set's own positions, each node by a lookup of the set's positions after
 * its own, so a candidate is tested in time bounded by the prefixes of keys found that the set holds, never by every key
 * found, as a scan of them was.
 */
interface KeyTrie {
	readonly next: Map<number, KeyTrie>
	/** Whether a key found ends here: the path to this node is one. */
	ends: boolean
}

const keyTrie = (): KeyTrie => ({ next: new Map(), ends: false })

/** Adds `key` to `trie`: its positions ascending, a path from the root, its last node marked. */
const insertKey = (trie: KeyTrie, key: Bits): void => {
	let at = trie
	for (const p of positions(key)) {
		const known = at.next.get(p)
		if (known === undefined) {
			const added = keyTrie()
			at.next.set(p, added)
			at = added
		} else {
			at = known
		}
	}
	at.ends = true
}

/**
 * Whether a key found is a subset of the set whose positions ascending are `set`, of fewer than `fewerThan` positions:
 * from `node`, `depth` positions below the root along positions of the set before `from`, a key ending here, or one
 * below a child at a position of the set at `from` or after. A key of the set has as many positions as it at most, so
 * fewer than one more than the set asks whether any key found is a subset of it, and fewer than the set's own size
 * whether a proper subset is.
 */
const keyWithin = (
	node: KeyTrie,
	set: ReadonlyArray<number>,
	from: number,
	fewerThan: number,
	depth: number
): boolean => {
	if (depth >= fewerThan) {
		return false
	}
	if (node.ends) {
		return true
	}
	for (let i = from; i < set.length; i++) {
		const child = node.next.get(defined(set[i], "a position of the set"))
		if (child !== undefined && keyWithin(child, set, i + 1, fewerThan, depth + 1)) {
			return true
		}
	}
	return false
}

/**
 * The dependencies of the factor search, indexed as a closure reads them (as Rows are, for Beeri and Bernstein's
 * counters): each one's determinants, each once, and their count; each position's dependencies reading it, packed:
 * position p's are `readers` from `readersAt[p]` to `readersAt[p + 1]`; the dependencies of no determinant, which every
 * closure fires; the positions each determines as it now stands, which irredundant shrinks; and how many of them
 * determine each position as they now stand, so a position none determines is known reached by no closure that does not
 * start from it.
 */
interface FactorTable {
	/** A set of the table's positions, whose words every set of them takes. */
	readonly like: Bits
	readonly from: ReadonlyArray<ReadonlyArray<number>>
	readonly to: Array<ReadonlyArray<number>>
	readonly determinants: Int32Array
	readonly readersAt: Int32Array
	readonly readers: Int32Array
	readonly given: ReadonlyArray<number>
	readonly determiners: Int32Array
}

/** The factor table of `dependencies`, over positions whose sets take the words of `like`. */
const factorTable = (
	like: Bits,
	dependencies: ReadonlyArray<{ readonly from: Bits; readonly to: ReadonlyArray<number> }>
): FactorTable => {
	const size = capacityOf(like)
	const from = dependencies.map((d) => positions(d.from))
	const determinants = new Int32Array(from.length)
	const readersAt = new Int32Array(size + 1)
	from.forEach((f, i) => {
		determinants[i] = f.length
		for (const p of f) {
			readersAt[p + 1] = (readersAt[p + 1] ?? 0) + 1
		}
	})
	for (let p = 0; p < size; p++) {
		readersAt[p + 1] = (readersAt[p + 1] ?? 0) + (readersAt[p] ?? 0)
	}
	const readers = new Int32Array(readersAt[size] ?? 0)
	const filled = readersAt.slice(0, size)
	from.forEach((f, i) => {
		for (const p of f) {
			const at = filled[p] ?? 0
			readers[at] = i
			filled[p] = at + 1
		}
	})
	const determiners = new Int32Array(size)
	for (const d of dependencies) {
		for (const t of d.to) {
			determiners[t] = (determiners[t] ?? 0) + 1
		}
	}
	return {
		like,
		from,
		to: dependencies.map((d) => d.to),
		determiners,
		determinants,
		readersAt,
		readers,
		given: from.flatMap((f, i) => (f.length === 0 ? [i] : []))
	}
}

/**
 * Closures over one factor table, one at a time, each firing a dependency once its last determinant is known (Beeri and
 * Bernstein's LINCLOSURE) and sharing the table's counters: a counter is set again the first time a closure reads it,
 * by its closure's mark, and a closure's positions are cleared from the set it holds when the next begins, so a
 * closure costs what it reaches, never the table's size.
 *
 * A closure begins with nothing known but `skipped` left out (begin), grows with the positions added (add), and fires
 * the dependencies of no determinant once what was added determines no more. Where it is asked for some positions
 * (want), it stops as soon as it holds every one: a closure that reaches them near its start reads no more of the table.
 */
interface FactorClosures {
	readonly known: Bits
	readonly begin: (skipped: number) => void
	readonly want: (targets: ReadonlyArray<number>) => void
	readonly add: (columns: Iterable<number>) => void
}

const factorClosures = (table: FactorTable): FactorClosures => {
	const known = emptyLike(table.like)
	const wanted = emptyLike(table.like)
	const missing = new Int32Array(table.from.length)
	/** The closure that last set each counter, by its number: a counter of another is unset in this one. */
	const setBy = new Int32Array(table.from.length)
	let current = 0
	let skipped = -1
	let givenFired = false
	/** The wanted positions not held yet, and whether any is wanted. */
	let open = 0
	let wanting = false
	const touched: Array<number> = []
	const wantedAt: Array<number> = []
	const queue: Array<number> = []
	const reach = (c: number): void => {
		if (holdsAt(known, c)) {
			return
		}
		addTo(known, c)
		touched.push(c)
		queue.push(c)
		if (holdsAt(wanted, c)) {
			open--
		}
	}
	const fire = (row: number): void => {
		if (row === skipped) {
			return
		}
		for (const t of table.to[row] ?? []) {
			reach(t)
		}
	}
	const done = (): boolean => wanting && open === 0
	const drain = (): void => {
		for (let c = queue.pop(); c !== undefined && !done(); c = queue.pop()) {
			for (let r = table.readersAt[c] ?? 0; r < (table.readersAt[c + 1] ?? 0); r++) {
				const row = table.readers[r] ?? 0
				if (setBy[row] !== current) {
					setBy[row] = current
					missing[row] = table.determinants[row] ?? 0
				}
				const left = (missing[row] ?? 0) - 1
				missing[row] = left
				if (left === 0) {
					fire(row)
				}
			}
		}
	}
	return {
		known,
		begin: (leftOut) => {
			for (const c of touched) {
				dropFrom(known, c)
			}
			for (const c of wantedAt) {
				dropFrom(wanted, c)
			}
			touched.length = 0
			wantedAt.length = 0
			queue.length = 0
			current++
			skipped = leftOut
			givenFired = false
			open = 0
			wanting = false
		},
		want: (targets) => {
			wanting = true
			for (const t of targets) {
				if (holdsAt(wanted, t)) {
					continue
				}
				addTo(wanted, t)
				wantedAt.push(t)
				if (!holdsAt(known, t)) {
					open++
				}
			}
		},
		add: (columns) => {
			for (const c of columns) {
				reach(c)
			}
			drain()
			if (givenFired) {
				return
			}
			givenFired = true
			for (const row of table.given) {
				if (done()) {
					return
				}
				fire(row)
				drain()
			}
		}
	}
}

/**
 * The dependencies with each one of several determinants stating only what the others do not reach from them, in
 * table order, each judged against the ones before it as they now stand and the ones after it as stated: the same
 * closure of every start. A dependency a parent closes over a key of its input's independent factors, or a view's key
 * beside its alternatives, determines what each factor's own dependencies already reach, and states none of it here.
 * A dependency of one determinant joins nothing its targets do not: what it reaches through the others, it reaches
 * through dependencies its determinant stands in.
 *
 * One closure per dependency of several determinants, asked for the targets it judges, so it reads the table only
 * until it holds them: a target no other dependency determines, nor its determinants hold, is reached by none but the
 * one judged, so it is not asked for, and a dependency with no other target is judged by no closure at all.
 */
const irredundant = (table: FactorTable, closures: FactorClosures): void => {
	const targeted = table.determiners
	table.from.forEach((from, judged) => {
		if (from.length < 2) {
			return
		}
		const to = table.to[judged] ?? []
		const asked = to.filter((t) => from.includes(t) || (targeted[t] ?? 0) > 1)
		if (asked.length === 0) {
			return
		}
		closures.begin(judged)
		closures.want(asked)
		closures.add(from)
		const kept = to.filter((c) => !holdsAt(closures.known, c))
		if (kept.length === to.length) {
			return
		}
		for (const c of to) {
			if (holdsAt(closures.known, c)) {
				targeted[c] = (targeted[c] ?? 0) - 1
			}
		}
		table.to[judged] = kept
	})
}

/** A strongly connected set of positions, and the sets it leans on: each with a position a dependency reaching it reads. */
interface Part {
	readonly columns: NonEmptyReadonlyArray<number>
	readonly leansOn: Set<Part>
}

/**
 * The strongly connected sets of `columns` under `next` (core/graph.ts stronglyConnected), each its root first,
 * ordered so that each set comes after every set that reaches it, and otherwise in the order of its first position:
 * each position's set in turn, after the sets it leans on that have not come yet (core/graph.ts postorder).
 */
const connectedSets = (
	columns: ReadonlyArray<number>,
	next: (column: number) => ReadonlyArray<number>
): ReadonlyArray<NonEmptyReadonlyArray<number>> => {
	const partOf = new Map<number, Part>()
	for (const members of stronglyConnected(columns, next)) {
		const part: Part = {
			columns: [lastNonEmpty(members), ...members.slice(0, -1)],
			leansOn: new Set()
		}
		for (const m of part.columns) {
			partOf.set(m, part)
		}
	}
	for (const [c, part] of partOf) {
		for (const d of next(c)) {
			const reached = partOf.get(d)
			if (reached !== undefined && reached !== part) {
				reached.leansOn.add(part)
			}
		}
	}
	return postorder(
		columns.map((c) => defined(partOf.get(c), `the strongly connected set of position ${c}`)),
		(part) => [...part.leansOn]
	).map((part) => part.columns)
}

/**
 * The factors of a table's minimal keys among `columns`: the attributes that can stand in a minimal key, in parts no
 * key's choice in one constrains in another, each in an order where a part's keys may lean only on the parts before it.
 * Every minimal key of the table is one minimal key of each factor, given the attributes of the factors before it,
 * together, and every such choice is one (a product), so the factors state 2^k keys in 2k when each of k factors has
 * two.
 *
 * The parts are the strongly connected sets of the attributes under what the dependencies reading them determine, read
 * off the dependencies irredundant (above), each after all that determine it and otherwise in the order of its first
 * attribute. A dependency determining an attribute of a set reads only it and the sets before it, so a key holds a key
 * of each set given the sets before it, which every key determines, and each set's keys are found apart: the product. A
 * dependency's targets the others reach from its determinants join nothing, so a key of k independent factors that a
 * parent closes over, or a view states beside its factors' alternatives, leaves them k factors; a set the ones before
 * it determine whole is in no minimal key and is no factor: an attribute a key determines, a cycle of attributes another
 * factor's key determines, an attribute two factors each determine. Each factor is a set of attributes.
 *
 * Linear in the table's size after the irredundant dependencies.
 *
 * The search keeps its table and its engine, so the key search over its factors (logical/props.ts finish) asks them
 * whether a set of positions determines a factor, a closure that stops as soon as it holds the factor, over the
 * dependencies by their classes' representatives, irredundant, which have every closure the node's dependencies have
 * among those positions.
 */
export interface FactorSearch {
	readonly factors: ReadonlyArray<Bits>
	/**
	 * Whether `start` determines every position of `targets` under the table's dependencies: a closure of the search's
	 * engine (factorClosures) asked for them, which stops as soon as it holds every one, and none where a target outside
	 * `start` is one no dependency determines.
	 */
	readonly covers: (start: Bits, targets: Bits) => boolean
	/** What `start` determines under the table's dependencies: a closure of the search's engine, whole. */
	readonly reached: (start: Bits) => Bits
}

export const independentFactors = (
	columns: Bits,
	stated: ReadonlyArray<{ readonly from: Bits; readonly to: ReadonlyArray<number> }>
): FactorSearch => {
	const table = factorTable(columns, stated)
	const closures = factorClosures(table)
	irredundant(table, closures)
	/** Each dependency's targets among `columns`, as irredundant left them. */
	const among = table.to.map((to) => to.filter((t) => holdsAt(columns, t)))
	/** What the dependencies reading each position determine among `columns`, read once a position. */
	const nexts = new Map<number, ReadonlyArray<number>>()
	const next = (c: number): ReadonlyArray<number> => {
		const read = nexts.get(c)
		if (read !== undefined) {
			return read
		}
		const out: Array<number> = []
		for (let r = table.readersAt[c] ?? 0; r < (table.readersAt[c + 1] ?? 0); r++) {
			appendAll(out, among[table.readers[r] ?? 0] ?? [])
		}
		nexts.set(c, out)
		return out
	}
	closures.begin(-1)
	closures.add([])
	const factors: Array<Bits> = []
	for (const set of connectedSets(positions(columns), next)) {
		if (isNonEmpty(set) && !set.every((c) => holdsAt(closures.known, c))) {
			const factor = emptyLike(columns)
			for (const c of set) {
				addTo(factor, c)
			}
			factors.push(factor)
		}
		closures.add(set)
	}
	/** One question's positions at a time, read out of its set: the engine reads each list before it returns. */
	const at: Array<number> = []
	const read = (bits: Bits): ReadonlyArray<number> => {
		at.length = 0
		pushPositions(at, bits)
		return at
	}
	return {
		factors,
		covers: (start, targets) => {
			if (read(targets).some((t) => !holdsAt(start, t) && (table.determiners[t] ?? 0) === 0)) {
				return false
			}
			closures.begin(-1)
			closures.want(read(targets))
			closures.add(read(start))
			return subsetOf(targets, closures.known)
		},
		reached: (start) => {
			closures.begin(-1)
			closures.add(read(start))
			return copyBits(closures.known)
		}
	}
}
