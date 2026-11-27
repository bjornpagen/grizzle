import { defined } from "@bjornpagen/grizzle-text/base/invariant"
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
	emptyWords,
	holdsAt,
	holdsName,
	lowest,
	intersect,
	minus,
	namesOf,
	noBits,
	positions,
	positionsInto,
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

/** An array of small integers of room for `n`: a FactorScratch's one allocation, made only where an array grows (grown). */
const allocated = (n: number): Int32Array => new Int32Array(n)

/** `held` where it has room for `n`, else an array of room for `n`: a scratch array grows to the largest search it holds. */
const grown = (held: Int32Array, n: number): Int32Array => (n <= held.length ? held : allocated(n))

/**
 * The last epoch a FactorScratch's closures take before their epochs begin again, its counters' marks cleared: the
 * greatest value an Int32Array holds.
 *
 * @formatConstant an Int32Array element: a signed 32-bit integer, 2³¹ − 1 the greatest
 */
const lastEpoch = 0x7fff_ffff

/** A dependency of the factor search: its determinants as a set, its targets in its order. */
interface FactorDependency {
	readonly from: Bits
	readonly to: ReadonlyArray<number>
}

/**
 * The factors of a table's minimal keys among `columns`: the attributes that can stand in a minimal key, in parts no
 * key's choice in one constrains in another, each in an order where a part's keys may lean only on the parts before it.
 * Every minimal key of the table is one minimal key of each factor, given the attributes of the factors before it,
 * together, and every such choice is one (a product), so the factors state 2^k keys in 2k when each of k factors has
 * two.
 *
 * The parts are the strongly connected sets of the attributes under what the dependencies reading them determine, read
 * off the dependencies irredundant (FactorScratch), each after all that determine it and otherwise in the order of its
 * first attribute. A dependency determining an attribute of a set reads only it and the sets before it, so a key holds
 * a key of each set given the sets before it, which every key determines, and each set's keys are found apart: the
 * product. A dependency's targets the others reach from its determinants join nothing, so a key of k independent
 * factors that a parent closes over, or a view states beside its factors' alternatives, leaves them k factors; a set the
 * ones before it determine whole is in no minimal key and is no factor: an attribute a key determines, a cycle of
 * attributes another factor's key determines, an attribute two factors each determine. Each factor is a set of
 * attributes.
 *
 * Linear in the table's size after the irredundant dependencies.
 *
 * The search keeps its table and its engine in its scratch, so the key search over its factors (logical/props.ts
 * finish) asks them whether a set of positions determines a factor, a closure that stops as soon as it holds the
 * factor, over the dependencies by their classes' representatives, irredundant, which have every closure the node's
 * dependencies have among those positions. It is the scratch's until the next search begins.
 */
export interface FactorSearch {
	readonly factors: ReadonlyArray<Bits>
	/**
	 * Whether `start` determines every position of `targets` under the table's dependencies: a closure of the search's
	 * engine asked for them, which stops as soon as it holds every one, and none where a target outside `start` is one
	 * no dependency determines.
	 */
	covers(start: Bits, targets: Bits): boolean
	/** What `start` determines under the table's dependencies: a closure of the search's engine, whole. */
	reached(start: Bits): Bits
}

/**
 * Where a key search works (independentFactors): its factor table, its closures' counters and lists, and its walk of
 * the table's connected sets, each an array of small integers grown to the largest search it has held and never
 * shrunk, so a search over a table no larger than one before it allocates none of them (grown); made once an analysis
 * (logical/props.ts PropsEnv scratch) and read by one search at a time, the search being the scratch itself
 * (FactorSearch) until the next begins.
 *
 * The table, as a closure reads it (Beeri and Bernstein's counters): each dependency's determinants, packed (dependency
 * i's are fromList from fromAt[i] to fromAt[i + 1]), and their count; each position's dependencies reading it, packed
 * likewise (readersAt, readers); each dependency's targets, packed (toAt, toList), the first toEnd[i] − toAt[i] of
 * dependency i's those it determines as it now stands, which irredundant shrinks; the dependencies of no determinant,
 * which every closure fires; and how many dependencies determine each position as they now stand, so a position none
 * determines is known reached by no closure that does not start from it.
 *
 * Its closures run one at a time over the table, each firing a dependency once its last determinant is known
 * (LINCLOSURE) and sharing the table's counters: a counter is set again the first time a closure reads it, by the
 * closure's epoch, and a closure's positions are cleared from the set it holds when the next begins, so a closure costs
 * what it reaches, never the table's size. A closure begins with nothing known but `skipped` left out (begin), grows
 * with the positions added (add), and fires the dependencies of no determinant once what was added determines no more.
 * Where it is asked for some positions (want), it stops as soon as it holds every one: a closure that reaches them near
 * its start reads no more of the table.
 */
export class FactorScratch implements FactorSearch {
	factors: ReadonlyArray<Bits> = []
	#known: Bits = emptyWords(0)
	#wanted: Bits = emptyWords(0)
	#rows = 0
	#determinants = allocated(0)
	#fromAt = allocated(0)
	#fromList = allocated(0)
	#toAt = allocated(0)
	#toEnd = allocated(0)
	#toList = allocated(0)
	#given = allocated(0)
	#givenCount = 0
	#readersAt = allocated(0)
	#readers = allocated(0)
	#filled = allocated(0)
	#determiners = allocated(0)
	/** Each dependency's determinants the running closure has not reached, its own where setBy holds the closure's epoch. */
	#missing = allocated(0)
	#setBy = allocated(0)
	#epoch = 0
	#skipped = -1
	#givenFired = false
	/** The wanted positions not held yet, and whether any is wanted. */
	#open = 0
	#wanting = false
	#touched = allocated(0)
	#touchedCount = 0
	#wantedAt = allocated(0)
	#wantedCount = 0
	#queue = allocated(0)
	#queueCount = 0
	/** One question's positions, read out of its set: a closure reads each before the next question. */
	#at = allocated(0)
	/** What the dependencies reading each position determine among the search's columns, packed (nextAt, nextList). */
	#nextAt = allocated(0)
	#nextList = allocated(0)
	/** Tarjan's walk: each position's discovery index (−1 unentered) and whether its set is open, the walk, the stack. */
	#index = allocated(0)
	#isOpen = allocated(0)
	#walkVertex = allocated(0)
	#walkCursor = allocated(0)
	#walkLow = allocated(0)
	#stack = allocated(0)
	#entered = 0
	#walk = 0
	#stacked = 0
	/** The connected sets in the order the walk closes them, each packed with its root first (partAt, partList). */
	#partAt = allocated(0)
	#partList = allocated(0)
	#partOf = allocated(0)
	/** The sets each set leans on, in the order first found: a linked list a set (leanHead, leanTail, leanNext, leanPart). */
	#leanHead = allocated(0)
	#leanTail = allocated(0)
	#leanMark = allocated(0)
	#leanNext = allocated(0)
	#leanPart = allocated(0)
	/** The postorder of the sets: each one seen, the walk's frames, the order. */
	#seen = allocated(0)
	#postPart = allocated(0)
	#postCursor = allocated(0)
	#order = allocated(0)

	/** The factor search of `stated` among `columns` (independentFactors), run in the scratch: the scratch, its search. */
	searchFactors(columns: Bits, stated: ReadonlyArray<FactorDependency>): FactorSearch {
		const size = this.#table(columns, stated)
		this.#irredundant()
		this.#nexts(columns, size)
		const parts = this.#connectedSets(columns, size)
		this.#begin(-1)
		this.#add(this.#at, 0, 0)
		const factors: Array<Bits> = []
		const order = this.#order
		const partAt = this.#partAt
		const partList = this.#partList
		for (let o = 0; o < parts; o++) {
			const part = order[o] ?? 0
			const start = partAt[part] ?? 0
			const end = partAt[part + 1] ?? 0
			let known = true
			for (let k = start; k < end && known; k++) {
				known = holdsAt(this.#known, partList[k] ?? 0)
			}
			if (!known) {
				const factor = emptyLike(columns)
				for (let k = start; k < end; k++) {
					addTo(factor, partList[k] ?? 0)
				}
				factors.push(factor)
			}
			this.#add(partList, start, end)
		}
		this.factors = factors
		return this
	}

	covers(start: Bits, targets: Bits): boolean {
		const at = this.#at
		const n = positionsInto(at, 0, targets)
		for (let k = 0; k < n; k++) {
			const t = at[k] ?? 0
			if (!holdsAt(start, t) && (this.#determiners[t] ?? 0) === 0) {
				return false
			}
		}
		this.#begin(-1)
		this.#wanting = true
		for (let k = 0; k < n; k++) {
			this.#want(at[k] ?? 0)
		}
		this.#add(at, 0, positionsInto(at, 0, start))
		return subsetOf(targets, this.#known)
	}

	reached(start: Bits): Bits {
		this.#begin(-1)
		this.#add(this.#at, 0, positionsInto(this.#at, 0, start))
		return copyBits(this.#known)
	}

	/** The table of `dependencies` over positions whose sets take the words of `like`, in the scratch: its positions' room. */
	#table(like: Bits, dependencies: ReadonlyArray<FactorDependency>): number {
		const size = capacityOf(like)
		const rows = dependencies.length
		let fromTotal = 0
		let toTotal = 0
		for (const d of dependencies) {
			fromTotal += sizeOf(d.from)
			toTotal += d.to.length
		}
		if (this.#known.length !== like.length) {
			this.#known = emptyLike(like)
			this.#wanted = emptyLike(like)
			this.#touchedCount = 0
			this.#wantedCount = 0
		}
		this.#rows = rows
		this.#determinants = grown(this.#determinants, rows)
		const determinants = this.#determinants
		this.#fromAt = grown(this.#fromAt, rows + 1)
		const fromAt = this.#fromAt
		this.#fromList = grown(this.#fromList, fromTotal)
		const fromList = this.#fromList
		this.#toAt = grown(this.#toAt, rows + 1)
		const toAt = this.#toAt
		this.#toEnd = grown(this.#toEnd, rows)
		const toEnd = this.#toEnd
		this.#toList = grown(this.#toList, toTotal)
		const toList = this.#toList
		this.#given = grown(this.#given, rows)
		const given = this.#given
		this.#readersAt = grown(this.#readersAt, size + 1)
		const readersAt = this.#readersAt
		this.#readers = grown(this.#readers, fromTotal)
		const readers = this.#readers
		this.#filled = grown(this.#filled, size)
		const filled = this.#filled
		this.#determiners = grown(this.#determiners, size)
		const determiners = this.#determiners
		this.#missing = grown(this.#missing, rows)
		this.#setBy = grown(this.#setBy, rows)
		this.#touched = grown(this.#touched, size)
		this.#wantedAt = grown(this.#wantedAt, size)
		this.#queue = grown(this.#queue, size)
		this.#at = grown(this.#at, size)
		readersAt.fill(0, 0, size + 1)
		determiners.fill(0, 0, size)
		let f = 0
		let t = 0
		let g = 0
		for (let i = 0; i < rows; i++) {
			const d = defined(dependencies[i], "a dependency of the table")
			fromAt[i] = f
			f = positionsInto(fromList, f, d.from)
			determinants[i] = f - (fromAt[i] ?? 0)
			for (let k = fromAt[i] ?? 0; k < f; k++) {
				const p = (fromList[k] ?? 0) + 1
				readersAt[p] = (readersAt[p] ?? 0) + 1
			}
			if (f === fromAt[i]) {
				given[g] = i
				g++
			}
			toAt[i] = t
			for (const x of d.to) {
				toList[t] = x
				t++
				determiners[x] = (determiners[x] ?? 0) + 1
			}
			toEnd[i] = t
		}
		fromAt[rows] = f
		toAt[rows] = t
		this.#givenCount = g
		for (let p = 0; p < size; p++) {
			readersAt[p + 1] = (readersAt[p + 1] ?? 0) + (readersAt[p] ?? 0)
			filled[p] = readersAt[p] ?? 0
		}
		for (let i = 0; i < rows; i++) {
			for (let k = fromAt[i] ?? 0; k < (fromAt[i + 1] ?? 0); k++) {
				const p = fromList[k] ?? 0
				const at = filled[p] ?? 0
				readers[at] = i
				filled[p] = at + 1
			}
		}
		return size
	}

	/** A closure begins: the last one's positions cleared, its counters its own by a new epoch, `skipped` left out. */
	#begin(skipped: number): void {
		for (let i = 0; i < this.#touchedCount; i++) {
			dropFrom(this.#known, this.#touched[i] ?? 0)
		}
		for (let i = 0; i < this.#wantedCount; i++) {
			dropFrom(this.#wanted, this.#wantedAt[i] ?? 0)
		}
		this.#touchedCount = 0
		this.#wantedCount = 0
		this.#queueCount = 0
		if (this.#epoch === lastEpoch) {
			this.#setBy.fill(0)
			this.#epoch = 0
		}
		this.#epoch++
		this.#skipped = skipped
		this.#givenFired = false
		this.#open = 0
		this.#wanting = false
	}

	/** Position `t` wanted by the running closure, which stops once it holds every position wanted. */
	#want(t: number): void {
		if (holdsAt(this.#wanted, t)) {
			return
		}
		addTo(this.#wanted, t)
		this.#wantedAt[this.#wantedCount] = t
		this.#wantedCount++
		if (!holdsAt(this.#known, t)) {
			this.#open++
		}
	}

	#reach(c: number): void {
		if (holdsAt(this.#known, c)) {
			return
		}
		addTo(this.#known, c)
		this.#touched[this.#touchedCount] = c
		this.#touchedCount++
		this.#queue[this.#queueCount] = c
		this.#queueCount++
		if (holdsAt(this.#wanted, c)) {
			this.#open--
		}
	}

	#fire(row: number): void {
		if (row === this.#skipped) {
			return
		}
		const toList = this.#toList
		for (let k = this.#toAt[row] ?? 0; k < (this.#toEnd[row] ?? 0); k++) {
			this.#reach(toList[k] ?? 0)
		}
	}

	#done(): boolean {
		return this.#wanting && this.#open === 0
	}

	#drain(): void {
		const readersAt = this.#readersAt
		const readers = this.#readers
		const setBy = this.#setBy
		const missing = this.#missing
		const determinants = this.#determinants
		const epoch = this.#epoch
		while (this.#queueCount > 0) {
			this.#queueCount--
			const c = this.#queue[this.#queueCount] ?? 0
			if (this.#done()) {
				return
			}
			for (let r = readersAt[c] ?? 0; r < (readersAt[c + 1] ?? 0); r++) {
				const row = readers[r] ?? 0
				if (setBy[row] !== epoch) {
					setBy[row] = epoch
					missing[row] = determinants[row] ?? 0
				}
				const left = (missing[row] ?? 0) - 1
				missing[row] = left
				if (left === 0) {
					this.#fire(row)
				}
			}
		}
	}

	/** The positions of `list` from `start` to `end` added to the running closure, and what they determine. */
	#add(list: Int32Array, start: number, end: number): void {
		for (let k = start; k < end; k++) {
			this.#reach(list[k] ?? 0)
		}
		this.#drain()
		if (this.#givenFired) {
			return
		}
		this.#givenFired = true
		for (let i = 0; i < this.#givenCount; i++) {
			if (this.#done()) {
				return
			}
			this.#fire(this.#given[i] ?? 0)
			this.#drain()
		}
	}

	/**
	 * The dependencies with each one of several determinants stating only what the others do not reach from them, in
	 * table order, each judged against the ones before it as they now stand and the ones after it as stated: the same
	 * closure of every start. A dependency a parent closes over a key of its input's independent factors, or a view's
	 * key beside its alternatives, determines what each factor's own dependencies already reach, and states none of it
	 * here. A dependency of one determinant joins nothing its targets do not: what it reaches through the others, it
	 * reaches through dependencies its determinant stands in.
	 *
	 * One closure per dependency of several determinants, asked for the targets it judges, so it reads the table only
	 * until it holds them: a target no other dependency determines, nor its determinants hold, is reached by none but
	 * the one judged, so it is not asked for, and a dependency with no other target is judged by no closure at all.
	 */
	#irredundant(): void {
		const fromAt = this.#fromAt
		const fromList = this.#fromList
		const toAt = this.#toAt
		const toEnd = this.#toEnd
		const toList = this.#toList
		const determiners = this.#determiners
		for (let judged = 0; judged < this.#rows; judged++) {
			const from = fromAt[judged] ?? 0
			const fromEnd = fromAt[judged + 1] ?? 0
			if (fromEnd - from < 2) {
				continue
			}
			const to = toAt[judged] ?? 0
			const toStop = toEnd[judged] ?? 0
			let any = false
			for (let k = to; k < toStop && !any; k++) {
				any = this.#asked(toList[k] ?? 0, from, fromEnd)
			}
			if (!any) {
				continue
			}
			this.#begin(judged)
			this.#wanting = true
			for (let k = to; k < toStop; k++) {
				const t = toList[k] ?? 0
				if (this.#asked(t, from, fromEnd)) {
					this.#want(t)
				}
			}
			this.#add(fromList, from, fromEnd)
			let kept = to
			for (let k = to; k < toStop; k++) {
				const c = toList[k] ?? 0
				if (holdsAt(this.#known, c)) {
					determiners[c] = (determiners[c] ?? 0) - 1
				} else {
					toList[kept] = c
					kept++
				}
			}
			toEnd[judged] = kept
		}
	}

	/**
	 * Whether the closure judging the dependency whose determinants are fromList from `from` to `to` is asked for its
	 * target `t`: one of those determinants, or a position another dependency determines too.
	 */
	#asked(t: number, from: number, to: number): boolean {
		const fromList = this.#fromList
		for (let k = from; k < to; k++) {
			if (fromList[k] === t) {
				return true
			}
		}
		return (this.#determiners[t] ?? 0) > 1
	}

	/** What the dependencies reading each of `columns` determine among them, as they now stand, packed by position. */
	#nexts(columns: Bits, size: number): void {
		const readersAt = this.#readersAt
		const readers = this.#readers
		const toAt = this.#toAt
		const toEnd = this.#toEnd
		const toList = this.#toList
		let total = 0
		for (let p = 0; p < size; p++) {
			if (holdsAt(columns, p)) {
				for (let r = readersAt[p] ?? 0; r < (readersAt[p + 1] ?? 0); r++) {
					const row = readers[r] ?? 0
					total += (toEnd[row] ?? 0) - (toAt[row] ?? 0)
				}
			}
		}
		this.#nextAt = grown(this.#nextAt, size + 1)
		const nextAt = this.#nextAt
		this.#nextList = grown(this.#nextList, total)
		const nextList = this.#nextList
		let n = 0
		for (let p = 0; p < size; p++) {
			nextAt[p] = n
			if (!holdsAt(columns, p)) {
				continue
			}
			for (let r = readersAt[p] ?? 0; r < (readersAt[p + 1] ?? 0); r++) {
				const row = readers[r] ?? 0
				for (let k = toAt[row] ?? 0; k < (toEnd[row] ?? 0); k++) {
					const t = toList[k] ?? 0
					if (holdsAt(columns, t)) {
						nextList[n] = t
						n++
					}
				}
			}
		}
		nextAt[size] = n
	}

	/**
	 * The strongly connected sets of `columns` under what the dependencies reading each determine (Tarjan's walk from
	 * each position in turn and through each one's successors in their order), each its root first and then its other
	 * positions as the walk's stack gives them back, ordered so that each set comes after every set that reaches it, and
	 * otherwise in the order of its first position: each position's set in turn, after the sets it leans on that have
	 * not come yet, in the order each was first found leaned on (postorder). Into partAt, partList and order: how many.
	 */
	#connectedSets(columns: Bits, size: number): number {
		const nextAt = this.#nextAt
		const nextList = this.#nextList
		this.#index = grown(this.#index, size)
		const index = this.#index
		this.#isOpen = grown(this.#isOpen, size)
		const isOpen = this.#isOpen
		this.#walkVertex = grown(this.#walkVertex, size)
		const walkVertex = this.#walkVertex
		this.#walkCursor = grown(this.#walkCursor, size)
		const walkCursor = this.#walkCursor
		this.#walkLow = grown(this.#walkLow, size)
		const walkLow = this.#walkLow
		this.#stack = grown(this.#stack, size)
		const stack = this.#stack
		this.#partAt = grown(this.#partAt, size + 1)
		const partAt = this.#partAt
		this.#partList = grown(this.#partList, size)
		const partList = this.#partList
		this.#partOf = grown(this.#partOf, size)
		const partOf = this.#partOf
		index.fill(-1, 0, size)
		this.#entered = 0
		this.#walk = 0
		this.#stacked = 0
		let parts = 0
		let listed = 0
		partAt[0] = 0
		const roots = this.#at
		const rootCount = positionsInto(roots, 0, columns)
		for (let i = 0; i < rootCount; i++) {
			const root = roots[i] ?? 0
			if ((index[root] ?? 0) !== -1) {
				continue
			}
			this.#enter(root)
			while (this.#walk > 0) {
				const top = this.#walk - 1
				const v = walkVertex[top] ?? 0
				const cursor = walkCursor[top] ?? 0
				if (cursor < (nextAt[v + 1] ?? 0)) {
					walkCursor[top] = cursor + 1
					const s = nextList[cursor] ?? 0
					if ((index[s] ?? 0) === -1) {
						this.#enter(s)
					} else if (isOpen[s] === 1) {
						walkLow[top] = Math.min(walkLow[top] ?? 0, index[s] ?? 0)
					}
					continue
				}
				this.#walk--
				const low = walkLow[top] ?? 0
				if (top > 0) {
					walkLow[top - 1] = Math.min(walkLow[top - 1] ?? 0, low)
				}
				if (low === index[v]) {
					partList[listed] = v
					listed++
					this.#stacked--
					for (let m = stack[this.#stacked] ?? 0; m !== v; m = stack[this.#stacked] ?? 0) {
						partList[listed] = m
						listed++
						isOpen[m] = 0
						partOf[m] = parts
						this.#stacked--
					}
					isOpen[v] = 0
					partOf[v] = parts
					parts++
					partAt[parts] = listed
				}
			}
		}
		this.#leans(parts, nextAt[size] ?? 0)
		return this.#postorder(parts, rootCount)
	}

	/** Tarjan's walk enters position `v`: its discovery index, open, its frame on the walk and itself on the stack. */
	#enter(v: number): void {
		const walk = this.#walk
		this.#index[v] = this.#entered
		this.#walkLow[walk] = this.#entered
		this.#entered++
		this.#isOpen[v] = 1
		this.#walkVertex[walk] = v
		this.#walkCursor[walk] = this.#nextAt[v] ?? 0
		this.#walk = walk + 1
		this.#stack[this.#stacked] = v
		this.#stacked++
	}

	/**
	 * The sets each set leans on, each once, in the order first found: for each set in turn and each of its positions,
	 * the set of each position a dependency reading it determines leans on it.
	 */
	#leans(parts: number, edgesAtMost: number): void {
		const nextAt = this.#nextAt
		const nextList = this.#nextList
		const partAt = this.#partAt
		const partList = this.#partList
		const partOf = this.#partOf
		this.#leanHead = grown(this.#leanHead, parts)
		const head = this.#leanHead
		this.#leanTail = grown(this.#leanTail, parts)
		const tail = this.#leanTail
		this.#leanMark = grown(this.#leanMark, parts)
		const mark = this.#leanMark
		this.#leanNext = grown(this.#leanNext, edgesAtMost)
		const next = this.#leanNext
		this.#leanPart = grown(this.#leanPart, edgesAtMost)
		const leaned = this.#leanPart
		head.fill(-1, 0, parts)
		tail.fill(-1, 0, parts)
		mark.fill(-1, 0, parts)
		let edges = 0
		for (let p = 0; p < parts; p++) {
			for (let k = partAt[p] ?? 0; k < (partAt[p + 1] ?? 0); k++) {
				const c = partList[k] ?? 0
				for (let j = nextAt[c] ?? 0; j < (nextAt[c + 1] ?? 0); j++) {
					const q = partOf[nextList[j] ?? 0] ?? 0
					if (q === p || mark[q] === p) {
						continue
					}
					mark[q] = p
					leaned[edges] = p
					next[edges] = -1
					const last = tail[q] ?? -1
					if (last === -1) {
						head[q] = edges
					} else {
						next[last] = edges
					}
					tail[q] = edges
					edges++
				}
			}
		}
	}

	/**
	 * The sets in postorder from each root position's set in turn (`rootCount` of them, in the scratch's question), each
	 * after the sets it leans on: into order, how many.
	 */
	#postorder(parts: number, rootCount: number): number {
		const roots = this.#at
		const partOf = this.#partOf
		const head = this.#leanHead
		const next = this.#leanNext
		const leaned = this.#leanPart
		this.#seen = grown(this.#seen, parts)
		const seen = this.#seen
		this.#postPart = grown(this.#postPart, parts)
		const framePart = this.#postPart
		this.#postCursor = grown(this.#postCursor, parts)
		const frameCursor = this.#postCursor
		this.#order = grown(this.#order, parts)
		const order = this.#order
		seen.fill(0, 0, parts)
		let placed = 0
		let frames = 0
		for (let i = 0; i < rootCount; i++) {
			const root = partOf[roots[i] ?? 0] ?? 0
			if (seen[root] === 1) {
				continue
			}
			seen[root] = 1
			framePart[frames] = root
			frameCursor[frames] = head[root] ?? -1
			frames++
			while (frames > 0) {
				const top = frames - 1
				const edge = frameCursor[top] ?? -1
				if (edge === -1) {
					frames--
					order[placed] = framePart[top] ?? 0
					placed++
					continue
				}
				frameCursor[top] = next[edge] ?? -1
				const input = leaned[edge] ?? 0
				if (seen[input] !== 1) {
					seen[input] = 1
					framePart[frames] = input
					frameCursor[frames] = head[input] ?? -1
					frames++
				}
			}
		}
		return placed
	}
}

/**
 * The factors of `stated`'s minimal keys among `columns` (FactorSearch), searched in `scratch`: the scratch, its
 * search until the next.
 */
export const independentFactors = (
	scratch: FactorScratch,
	columns: Bits,
	stated: ReadonlyArray<FactorDependency>
): FactorSearch => scratch.searchFactors(columns, stated)
