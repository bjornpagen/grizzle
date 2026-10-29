import { Array as Arr } from "effect"
import type { NodeOf } from "#compiler/ir/rel.ts"
import {
	baseOf,
	contractOf,
	numericTypmodOf,
	type ScalarType,
	sameScalarType
} from "#compiler/ir/scalar.ts"
import type {
	ConservativeProgram,
	StatementRole,
	StatementRoots,
	StatementTree
} from "#compiler/lower/conservative/types.ts"
import type { RawRow } from "#test/support/oracle/install/capture.ts"
import { indices } from "#test/support/oracle/pick.ts"

import { regex } from "arkregex"
/** A statement of a program in flight order: its structural label, and the Attach node it delivers, for an attachment. */
export interface Labeled<S> {
	readonly statement: S
	readonly label: string
	readonly attach: NodeOf<"Attach"> | undefined
}

/** The label of a delivered statement of `role`: "main", or "group <g>" for a heading group of a heterogeneous union. */
const rootLabel = (role: StatementRole): string => {
	switch (role.kind) {
		case "main":
			return "main"
		case "headingGroup":
			return `group ${role.group}`
		case "attachment":
			return "attachment"
	}
}

/**
 * Each statement of a program in flight order with its structural label: "main", "group <g>" for a heading group of a
 * heterogeneous union, and "<parent label>/<name>" for an attachment, so nested attachments are labeled by their path.
 */
export const labeledStatements = <S extends { readonly role: StatementRole }>(
	roots: StatementRoots<S>
): ReadonlyArray<Labeled<S>> => {
	const out: Array<Labeled<S>> = []
	const under = (tree: StatementTree<S>, label: string): void => {
		for (const a of tree.attachments) {
			const own = `${label}/${a.attach.name}`
			out.push({ statement: a.statement, label: own, attach: a.attach })
			under(a, own)
		}
	}
	for (const tree of roots) {
		const label = rootLabel(tree.statement.role)
		out.push({ statement: tree.statement, label, attach: undefined })
		under(tree, label)
	}
	return out
}

/** The structural label of each statement of a program, in flight order (labeledStatements). */
export const statementLabels = (program: ConservativeProgram): ReadonlyArray<string> =>
	Arr.map(labeledStatements(program.roots), (l) => l.label)

/**
 * The cells of a statement's rows a run states by value alone: for each row holding one, by its index in the
 * statement's rows, the indexes of those cells.
 */
export type MergedCells = ReadonlyMap<number, ReadonlySet<number>>

/**
 * What a statement of a run leaves unstated: nothing (a database run); the spellings of some cells alone; or besides
 * those the columns some row leaves unstated, whose unstated cells hold no value's text, and the rows that state every
 * column (by their index), each of which the other run must hold as written.
 */
export type Unstated =
	| { readonly kind: "none" }
	| { readonly kind: "merged"; readonly merged: MergedCells }
	| {
			readonly kind: "some"
			readonly columns: ReadonlyArray<string>
			readonly complete: ReadonlyArray<number>
			readonly merged: MergedCells
	  }

/** One statement of a run: what it delivers and the rows it returned. */
export interface StatementRows {
	readonly label: string
	/** The output column names, the parent key columns of an attachment first. */
	readonly columns: ReadonlyArray<string>
	/**
	 * The output column types, position by position: a lowering's statement heading, or the query's own heading for the
	 * reference.
	 */
	readonly types: ReadonlyArray<ScalarType>
	readonly unstated: Unstated
	readonly rows: ReadonlyArray<RawRow>
}

/** Whether a run leaves some cell of some statement unstated. */
export const holdsUnstated = (run: Run): boolean =>
	Arr.some(run.statements, (s) => s.unstated.kind === "some")

/** The columns a statement leaves unstated in some row. */
const unstatedColumns = (s: StatementRows): ReadonlyArray<string> =>
	s.unstated.kind === "some" ? s.unstated.columns : []

/** The cells a statement states by value alone. */
const mergedCells = (s: StatementRows): MergedCells =>
	s.unstated.kind === "none" ? new Map() : s.unstated.merged

/**
 * A merged cell's output text up to its spelling: a numeric's fraction's trailing zeros, and a bare point, dropped,
 * and a float zero's sign. Only a cell a run states by value alone is read so.
 */
const valueText = (text: string): string => {
	if (text === "-0") {
		return "0"
	}
	const m = regex("^(-?\\d+)\\.(\\d*?)0*$").exec(text)
	if (m === null) {
		return text
	}
	const [, whole, fraction] = m
	return fraction === "" ? whole : `${whole}.${fraction}`
}

/** The cell at column i of a row its statement's heading covers; a missing one is a defect of the run. */
const cellAt = (row: RawRow, i: number): string => {
	const cell = row[i]
	if (cell === undefined) {
		throw new Error(`a row holds no column ${i}`)
	}
	return cell
}

/** A row as the comparison reads it: its cells' texts, and the indexes of the cells its run states by value alone. */
interface ReadRow {
	readonly row: RawRow
	readonly merged: ReadonlySet<number>
}

/**
 * The rows at `indexes` of a statement, each keeping the columns `keep` admits, its merged cells renumbered to them.
 */
const readRows = (
	s: StatementRows,
	indexes: ReadonlyArray<number>,
	keep: (column: string) => boolean
): ReadonlyArray<ReadRow> => {
	const merged = mergedCells(s)
	const kept = Arr.flatMap(s.columns, (c, i) => (keep(c) ? [i] : []))
	return Arr.map(indexes, (r) => {
		const row = s.rows[r]
		if (row === undefined) {
			throw new Error(`${s.label}: no row ${r}`)
		}
		const cells = merged.get(r)
		return {
			row: Arr.map(kept, (i) => cellAt(row, i)),
			merged: new Set(Arr.flatMap(kept, (i, j) => (cells?.has(i) === true ? [j] : [])))
		}
	})
}

/** Whether two rows agree: every cell as written, and a cell either run states by value alone up to its spelling. */
const agree = (a: ReadRow, b: ReadRow): boolean =>
	a.row.length === b.row.length &&
	Arr.every(a.row, (cell, i) => {
		const other = cellAt(b.row, i)
		return a.merged.has(i) || b.merged.has(i)
			? valueText(cell) === valueText(other)
			: cell === other
	})

/**
 * The rows of each side no pairing of agreeing rows covers, each with how often, by a largest pairing. Rows that hold
 * no merged cell are paired by their text first, which a largest pairing may always do: any row agreeing with one of
 * them agrees with every row of that text. The rest are paired by augmenting paths (Kuhn's algorithm).
 */
const unpaired = (
	left: ReadonlyArray<ReadRow>,
	right: ReadonlyArray<ReadRow>
): Pick<StatementDiff, "missing" | "extra"> => {
	if (Arr.every(left, (r) => r.merged.size === 0) && Arr.every(right, (r) => r.merged.size === 0)) {
		return compareMultisets(
			Arr.map(left, (r) => r.row),
			Arr.map(right, (r) => r.row)
		)
	}
	/** The plain rows of the right side by text, each paired with a plain left row of that text while one is left. */
	const plainRight = new Map<string, Array<number>>()
	for (const [j, r] of right.entries()) {
		if (r.merged.size > 0) {
			continue
		}
		const key = rawRowKey(r.row)
		plainRight.set(key, [...(plainRight.get(key) ?? []), j])
	}
	const pairedRight = new Set<number>()
	const restLeft: Array<number> = []
	for (const [i, r] of left.entries()) {
		const same = r.merged.size === 0 ? plainRight.get(rawRowKey(r.row)) : undefined
		const j = same?.pop()
		if (j === undefined) {
			restLeft.push(i)
		} else {
			pairedRight.add(j)
		}
	}
	const restRight = Arr.filter(indices(right.length), (j) => !pairedRight.has(j))
	const rowAt = (side: ReadonlyArray<ReadRow>, i: number): ReadRow => {
		const r = side[i]
		if (r === undefined) {
			throw new Error(`the comparison holds no row ${i}`)
		}
		return r
	}
	/** A largest pairing of the rest: each right row's partner, found by an augmenting path. */
	const partnerOf = new Map<number, number>()
	const augment = (i: number, seen: Set<number>): boolean => {
		const l = rowAt(left, i)
		for (const j of restRight) {
			if (seen.has(j) || !agree(l, rowAt(right, j))) {
				continue
			}
			seen.add(j)
			const holder = partnerOf.get(j)
			if (holder === undefined || augment(holder, seen)) {
				partnerOf.set(j, i)
				return true
			}
		}
		return false
	}
	const lone = Arr.filter(restLeft, (i) => !augment(i, new Set()))
	/** Rows each with how often, in the order excess reports them. */
	const counted = (
		side: ReadonlyArray<ReadRow>,
		at: ReadonlyArray<number>
	): ReadonlyArray<RowCount> =>
		excess(rowMultiset(Arr.map(at, (i) => rowAt(side, i).row)), new Map())
	return {
		missing: counted(left, lone),
		extra: counted(
			right,
			Arr.filter(restRight, (j) => !partnerOf.has(j))
		)
	}
}

export interface Run {
	readonly name: string
	readonly statements: ReadonlyArray<StatementRows>
}

/** One row and how often it occurs, in a deterministic order (by its text). */
interface RowCount {
	readonly row: RawRow
	readonly count: number
}

interface StatementDiff {
	readonly label: string
	/** Rows the left run has more often than the right, with the excess count. */
	readonly missing: ReadonlyArray<RowCount>
	/** Rows the right run has more often than the left, with the excess count. */
	readonly extra: ReadonlyArray<RowCount>
}

/**
 * A structural difference of two runs: a statement one run lacks, a statement the two deliver under different
 * headings, or a column both type and type differently. Printed only by printComparison.
 */
export type StructuralDifference =
	| { readonly kind: "missing"; readonly side: string; readonly label: string }
	| {
			readonly kind: "heading"
			readonly label: string
			readonly left: ReadonlyArray<string>
			readonly right: ReadonlyArray<string>
	  }
	| {
			readonly kind: "type"
			readonly label: string
			readonly column: string
			readonly left: ScalarType
			readonly right: ScalarType
	  }

export interface Comparison {
	readonly equal: boolean
	readonly structural: ReadonlyArray<StructuralDifference>
	readonly diffs: ReadonlyArray<StatementDiff>
	/** Repeated rows the right run returned, summed over its statements: rows.length minus distinct rows. */
	readonly rightDuplicates: number
	readonly leftDuplicates: number
}

/**
 * A row's identity as text: each cell a text cell, `\u0002` and its text, joined by `\u0000`. PostgreSQL text never
 * holds NUL, so the separator separates columns unambiguously; the marker tells a row of one empty cell from a row of
 * none. A raw row holds no NULL (capture.ts refuses one), so the NULL spelling `\u0001` never occurs.
 */
export const rawRowKey = (row: RawRow): string =>
	Arr.join(
		Arr.map(row, (cell) => `\u0002${cell}`),
		"\u0000"
	)

/** The multiset of rows: each distinct row with its count, keyed by rawRowKey. */
export const rowMultiset = (rows: ReadonlyArray<RawRow>): ReadonlyMap<string, RowCount> => {
	const out = new Map<string, RowCount>()
	for (const row of rows) {
		const key = rawRowKey(row)
		const seen = out.get(key)
		out.set(key, { row, count: (seen?.count ?? 0) + 1 })
	}
	return out
}

/** The number of repeated rows: a set returns 0. */
const duplicateCount = (rows: ReadonlyArray<RawRow>): number => rows.length - rowMultiset(rows).size

const byKey = (a: readonly [string, RowCount], b: readonly [string, RowCount]): -1 | 0 | 1 =>
	a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0

/** The excess of `a` over `b`: each row `a` has more often, with how many more times. */
const excess = (
	a: ReadonlyMap<string, RowCount>,
	b: ReadonlyMap<string, RowCount>
): ReadonlyArray<RowCount> =>
	Arr.flatMap(Arr.sort(a.entries(), byKey), ([key, entry]: readonly [string, RowCount]) => {
		const more = entry.count - (b.get(key)?.count ?? 0)
		return more > 0 ? [{ row: entry.row, count: more }] : []
	})

/** Two statements' rows as multisets: the rows each has more often than the other. */
export const compareMultisets = (
	left: ReadonlyArray<RawRow>,
	right: ReadonlyArray<RawRow>
): Pick<StatementDiff, "missing" | "extra"> => {
	const l = rowMultiset(left)
	const r = rowMultiset(right)
	return { missing: excess(l, r), extra: excess(r, l) }
}

const sameColumns = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && Arr.every(a, (c, i) => c === b[i])

/** A type as text for a report: its carrier, typmod and contract. */
const typeText = (t: ScalarType): string => {
	const base = baseOf(t)
	const typmod = numericTypmodOf(base)
	const contract = contractOf(t)
	return `${contract === undefined ? "" : `${contract.name} over `}${base.carrier}${typmod === undefined ? "" : `(${typmod.precision}, ${typmod.scale})`}`
}

/**
 * The columns whose types two statements disagree on. A run that types some but not all of its columns is a harness
 * defect, never a difference.
 */
const typeDifferences = (
	l: StatementRows,
	r: StatementRows
): ReadonlyArray<StructuralDifference> => {
	const [lt, rt] = [l.types, r.types]
	if (lt.length !== l.columns.length || rt.length !== r.columns.length) {
		throw new Error(`${l.label}: a run types some but not all of its columns`)
	}
	return Arr.flatMap(l.columns, (column, i): ReadonlyArray<StructuralDifference> => {
		const a = lt[i]
		const b = rt[i]
		if (a === undefined || b === undefined) {
			throw new Error(`${l.label}: no type for column ${column} on both sides`)
		}
		if (sameScalarType(a, b)) {
			return []
		}
		return [{ kind: "type", label: l.label, column, left: a, right: b }]
	})
}

/**
 * Raw text multiset comparison for the oracle.
 *
 * The oracle compares two runs of one case statement by statement. Each statement's rows are its output-function
 * texts (install/capture.ts), and two runs agree when every statement's rows are equal as multisets: the same rows,
 * each the same number of times. A multiset, not a set, so a lowering that loses a DISTINCT it needed shows up as a
 * repeated row even when the distinct rows agree, and raw text, not values, so a lost distinction
 * (1.0 vs 1.00, -0, NaN, a supplementary-plane character) shows up as different text. Row order is ignored: ordering
 * is a delivery concern the comparison does not judge.
 *
 * Statements are aligned by a structural label, not by position: the main statement, a heading group by its index,
 * an attachment by the label of the statement it hangs off and its name. Two runs whose statements carry different
 * labels, an attachment whose parent key columns differ, or a column both runs type and type differently, are a
 * structural mismatch rather than a row difference. Types matter because raw text alone does not show every narrowing:
 * a double rendered as real still spells 0.1 as "0.1".
 *
 * A cell a run does not state (the reference's value of a term the host evaluator declines, which PostgreSQL alone
 * computes) is compared by its column's type alone, and every row stating every column must appear as written in the
 * other run: the rows are compared as multisets projected onto the columns no row of either run leaves unstated, and
 * then each fully stated row of a run leaving some cell unstated must occur in the other run at least as often. A
 * database run states every column, and holds no NULL (capture.ts refuses one), so a column compared by type is still
 * never NULL.
 *
 * A cell the reference states by its value alone, because a collapse kept one of natively equal values of other
 * spellings and PostgreSQL chooses which one survives (reference/values.ts merged values), is compared up to its
 * spelling, that one cell alone: a row holding such cells matches a row of the other run that agrees with it cell by
 * cell, those cells up to their spelling (valueText) and every other cell as written, the rows of the two runs paired
 * one to one where any pairing exists. Every cell not so marked keeps its exact text, so a float -0 against 0 there,
 * a sign lost or invented, is a difference.
 *
 * Compares two runs of one case (left is the baseline).
 */
export const compareRuns = (left: Run, right: Run): Comparison => {
	const structural: Array<StructuralDifference> = []
	const diffs: Array<StatementDiff> = []
	const rightByLabel = new Map(Arr.map(right.statements, (s) => [s.label, s]))
	const leftLabels = new Set(Arr.map(left.statements, (s) => s.label))
	for (const l of left.statements) {
		const r = rightByLabel.get(l.label)
		if (r === undefined) {
			structural.push({ kind: "missing", side: right.name, label: l.label })
			continue
		}
		if (!sameColumns(l.columns, r.columns)) {
			structural.push({ kind: "heading", label: l.label, left: l.columns, right: r.columns })
			continue
		}
		structural.push(...typeDifferences(l, r))
		const unstated = new Set([...unstatedColumns(l), ...unstatedColumns(r)])
		const all = (s: StatementRows) => Arr.map(indices(s.rows.length), (i) => i)
		const stated = (column: string) => !unstated.has(column)
		const projected = unpaired(readRows(l, all(l), stated), readRows(r, all(r), stated))
		/** Each fully stated row of a side leaving some cell unstated, which no row of the other side pairs with. */
		const complete = (side: StatementRows, other: StatementRows): ReadonlyArray<RowCount> =>
			side.unstated.kind === "some"
				? unpaired(
						readRows(side, side.unstated.complete, () => true),
						readRows(other, all(other), () => true)
					).missing
				: []
		const diff: StatementDiff = {
			label: l.label,
			missing: [...projected.missing, ...complete(l, r)],
			extra: [...projected.extra, ...complete(r, l)]
		}
		if (diff.missing.length > 0 || diff.extra.length > 0) {
			diffs.push(diff)
		}
	}
	for (const r of right.statements) {
		if (!leftLabels.has(r.label)) {
			structural.push({ kind: "missing", side: left.name, label: r.label })
		}
	}
	const dup = (run: Run) => Arr.reduce(run.statements, 0, (n, s) => n + duplicateCount(s.rows))
	return {
		equal: structural.length === 0 && diffs.length === 0,
		structural,
		diffs,
		rightDuplicates: dup(right),
		leftDuplicates: dup(left)
	}
}

const printRawRow = (row: RawRow): string =>
	`(${Arr.join(
		Arr.map(row, (v) => JSON.stringify(v)),
		", "
	)})`

/** A structural difference as text, for a report. */
const printStructural = (d: StructuralDifference, leftName: string, rightName: string): string => {
	switch (d.kind) {
		case "missing":
			return `${d.side} has no statement ${d.label}`
		case "heading":
			return `${d.label}: ${leftName} delivers (${Arr.join(d.left, ", ")}), ${rightName} (${Arr.join(d.right, ", ")})`
		case "type": {
			const [tl, tr] = [typeText(d.left), typeText(d.right)]
			return `${d.label}: column ${d.column} is ${tl}${tl === tr ? " (other capabilities)" : ""} on ${leftName} and ${tr} on ${rightName}`
		}
	}
}

/** A comparison as text, for a failing property's report. */
export const printComparison = (c: Comparison, leftName: string, rightName: string): string => {
	if (c.equal) {
		return `${leftName} and ${rightName} agree (${rightName} repeats ${c.rightDuplicates} rows)`
	}
	const lines = [`${leftName} and ${rightName} differ:`]
	for (const s of c.structural) {
		lines.push(`  structure: ${printStructural(s, leftName, rightName)}`)
	}
	for (const d of c.diffs) {
		lines.push(`  statement ${d.label}:`)
		for (const m of d.missing) {
			lines.push(`    only in ${leftName} ×${m.count}: ${printRawRow(m.row)}`)
		}
		for (const e of d.extra) {
			lines.push(`    only in ${rightName} ×${e.count}: ${printRawRow(e.row)}`)
		}
	}
	lines.push(`  ${rightName} repeats ${c.rightDuplicates} rows, ${leftName} ${c.leftDuplicates}`)
	return Arr.join(lines, "\n")
}

/** A run's rows as text, for reports. */
export const printRun = (run: Run): string =>
	Arr.join(
		[
			`${run.name}:`,
			...Arr.flatMap(run.statements, (s) => [
				`  ${s.label} (${Arr.join(s.columns, ", ")}): ${s.rows.length === 0 ? "{}" : ""}`,
				...Arr.map(s.rows, (r) => `    ${printRawRow(r)}`)
			])
		],
		"\n"
	)
