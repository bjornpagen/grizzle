import { Array as Arr, Formatter, Result } from "effect"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { appendAll } from "#compiler/core/array.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { NodeOf } from "#compiler/ir/rel.ts"
import {
	baseOf,
	contractOf,
	numericTypmodOf,
	type ScalarType,
	sameScalarType
} from "#compiler/ir/scalar.ts"
import type { ConservativeProgram } from "#compiler/lower/conservative/types.ts"
import type { StatementRole, StatementRoots, StatementTree } from "#compiler/runtime/lower/tree.ts"
import { admittedText } from "#compiler/scalar/values/identity.ts"
import { strictReader } from "#test/support/kernel/strict.ts"
import type { RawRow } from "#test/support/oracle/install/capture.ts"

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
 * What a statement of a run leaves unstated: nothing (a database run); or the columns some row leaves unstated, whose
 * unstated cells hold no value's text, and the rows that state every column (by their index), each of which the other
 * run must hold.
 */
export type Unstated =
	| { readonly kind: "none" }
	| {
			readonly kind: "some"
			readonly columns: ReadonlyArray<string>
			readonly complete: ReadonlyArray<number>
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
	/** The installation's codes, which a closed id's or a set's text is read under. */
	readonly codes: Codebook
	readonly unstated: Unstated
	readonly rows: ReadonlyArray<RawRow>
}

/** The columns a statement leaves unstated in some row. */
const unstatedColumns = (s: StatementRows): ReadonlyArray<string> =>
	s.unstated.kind === "some" ? s.unstated.columns : []

/** The cell at column i of a row its statement's heading covers; a missing one is a defect of the run. */
const cellAt = (row: RawRow, i: number): string => {
	const cell = row[i]
	if (cell === undefined) {
		throw new Error(`a row holds no column ${i}`)
	}
	return cell
}

/**
 * The canonical text of a cell of `type`: the kernel's strict reading of PostgreSQL's output text (kernel/strict.ts),
 * which admits only what the output function writes, written in the value's one form (values/identity.ts
 * canonicalText). Two cells have one canonical text exactly when their values are equal, so 1.50 and 1.5, or -0 and 0,
 * agree, and any other difference of value does not. The comparison shares no text shortcut with production
 * (codec/scalar.ts cellText): it reads every cell to its value first, a closed id's or a set's under the installation's
 * codes. A text the strict reader refuses is no output of the type, a defect of the run.
 */
export const canonicalCell = (type: ScalarType, codes: Codebook): ((cell: string) => string) => {
	const read = strictReader(type, codes)
	const spec = carrierSpecOf(type, codes)
	return (cell) => {
		const value = read(cell)
		if (Result.isFailure(value)) {
			throw new Error(`${Formatter.format(cell)} is no output text of its type (${value.failure})`)
		}
		return admittedText(spec, value.success)
	}
}

/**
 * A statement's rows as values: each cell of a column it states read as its canonical text (canonicalCell), and each
 * cell of a column some row leaves unstated as it is, so two spellings of one value (-0 and 0, 1.0 and 1.00) are one row.
 */
export const canonicalRows = (s: StatementRows): ReadonlyArray<RawRow> => {
	const unstated = new Set(unstatedColumns(s))
	const texts = Arr.map(s.columns, (c, i): ((cell: string) => string) => {
		if (unstated.has(c)) {
			return (cell) => cell
		}
		const type = s.types[i]
		if (type === undefined) {
			throw new Error(`${s.label}: no type for column ${i}`)
		}
		return canonicalCell(type, s.codes)
	})
	return Arr.map(s.rows, (row) => Arr.map(texts, (text, i) => text(cellAt(row, i))))
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

/** Which of two compared runs: the left, the baseline, or the right. */
export type RunSide = "left" | "right"

/** A row a statement of one run returned more than once as a value, and how many times past the first. */
export interface StatementRepeat {
	readonly side: RunSide
	readonly label: string
	readonly row: RawRow
	readonly count: number
}

export interface Comparison {
	/** Whether the runs agree: one structure, the same rows in every statement, and neither run repeating a row. */
	readonly equal: boolean
	readonly structural: ReadonlyArray<StructuralDifference>
	readonly diffs: ReadonlyArray<StatementDiff>
	/** Every row a statement of either run repeated: a statement delivers a set, so any repeat makes the runs unequal. */
	readonly repeated: ReadonlyArray<StatementRepeat>
}

/** How many repeated rows one side of a comparison returned, summed over its statements. */
export const repeatsOn = (c: Comparison, side: RunSide): number =>
	Arr.reduce(
		Arr.filter(c.repeated, (r) => r.side === side),
		0,
		(n, r) => n + r.count
	)

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

/** Adds one row to a multiset keyed by rawRowKey. */
const counted = (into: Map<string, RowCount>, row: RawRow): void => {
	const key = rawRowKey(row)
	const seen = into.get(key)
	into.set(key, { row, count: (seen?.count ?? 0) + 1 })
}

/** The multiset of rows: each distinct row with its count, keyed by rawRowKey. */
export const rowMultiset = (rows: ReadonlyArray<RawRow>): ReadonlyMap<string, RowCount> => {
	const out = new Map<string, RowCount>()
	for (const row of rows) {
		counted(out, row)
	}
	return out
}

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
 * Canonical cell keyed-set comparison for the oracle.
 *
 * The oracle compares two runs of one case statement by statement. Each statement's rows are its output-function
 * texts (install/capture.ts), each cell read as its column type's canonical text (canonicalCell), and two runs agree
 * when every statement of each is a set, holding no row twice, and every statement's rows are the same set. A repeated
 * row is a difference of its own (`repeated`), so a lowering that loses a DISTINCT it needed fails the comparison even
 * when the distinct rows agree, and two runs that repeat one row alike do not agree. Rows are values, not spellings, so
 * a value a lowering changes (a quotient's digits, a sum's rounding, a lost NaN, a supplementary-plane character) shows
 * up as a different text, while the spelling PostgreSQL picks for one value (1.0 or 1.00, -0 or 0), which grizzle
 * delivers as one value, does not. Row order is ignored: ordering is a delivery concern the comparison does not
 * judge.
 *
 * Statements are aligned by a structural label, not by position: the main statement, a heading group by its index,
 * an attachment by the label of the statement it hangs off and its name. Two runs whose statements carry different
 * labels, an attachment whose parent key columns differ, or a column both runs type and type differently, are a
 * structural mismatch rather than a row difference. Types matter because a value alone does not show every narrowing:
 * a double rendered as real still spells 0.1 as "0.1".
 *
 * A cell a run does not state (the reference's value of a term the host evaluator declines, which PostgreSQL alone
 * computes) is compared by its column's type alone, and every row stating every column must appear in the other run:
 * the rows are compared as multisets projected onto the columns no row of either run leaves unstated, and then each
 * fully stated row of a run leaving some cell unstated must occur in the other run at least as often. A database run
 * states every column, and holds no NULL (capture.ts refuses one), so a column compared by type is still never NULL.
 *
 * Compares two runs of one case (left is the baseline).
 */
export const compareRuns = (left: Run, right: Run): Comparison =>
	compareRead(readRun(left), readRun(right))

/**
 * A statement's rows read once as values (canonicalCell), every comparison of it reads: each distinct row of the
 * columns it states with its count, and each distinct row of its rows that state every column, the same multiset for a
 * statement that leaves no cell unstated. Reading a run once lets one baseline be compared with any number of runs
 * without reading its rows again.
 */
interface ReadStatement {
	readonly statement: StatementRows
	/** The columns it states in every row, in heading order. */
	readonly stated: ReadonlyArray<string>
	/** Its rows projected onto `stated`, as values, each distinct row with its count. */
	readonly projected: ReadonlyMap<string, RowCount>
	/** Its rows that state every column, as values, each distinct row with its count. */
	readonly complete: ReadonlyMap<string, RowCount>
}

/** A run read once (readRun): its statements' rows as values. */
export interface ReadRun {
	readonly name: string
	readonly statements: ReadonlyArray<ReadStatement>
}

/** One statement read once: each row's cells read as values in one pass over its rows. */
const readStatement = (s: StatementRows): ReadStatement => {
	const unstated = new Set(unstatedColumns(s))
	const texts = Arr.map(s.columns, (_, i) => {
		const type = s.types[i]
		if (type === undefined) {
			throw new Error(`${s.label}: no type for column ${i}`)
		}
		return canonicalCell(type, s.codes)
	})
	const statedAt = Arr.flatMap(s.columns, (c, i) => (unstated.has(c) ? [] : [i]))
	const valueAt = (row: RawRow, i: number): string => {
		const text = texts[i]
		if (text === undefined) {
			throw new Error(`${s.label}: no reader for column ${i}`)
		}
		return text(cellAt(row, i))
	}
	const projected = new Map<string, RowCount>()
	const complete = new Map<string, RowCount>()
	const completeRows = s.unstated.kind === "some" ? new Set(s.unstated.complete) : undefined
	for (const [r, row] of s.rows.entries()) {
		counted(
			projected,
			Arr.map(statedAt, (i) => valueAt(row, i))
		)
		if (completeRows?.has(r) === true) {
			counted(
				complete,
				Arr.map(s.columns, (_, i) => valueAt(row, i))
			)
		}
	}
	return {
		statement: s,
		stated: Arr.map(statedAt, (i) => columnAt(s.columns, i)),
		projected,
		complete: completeRows === undefined ? projected : complete
	}
}

/** The column of a heading at `i`; a missing one is a defect of the run. */
const columnAt = (columns: ReadonlyArray<string>, i: number): string => {
	const column = columns[i]
	if (column === undefined) {
		throw new Error(`a heading holds no column ${i}`)
	}
	return column
}

/** A run read once: each statement's rows as values (ReadStatement). */
export const readRun = (run: Run): ReadRun => ({
	name: run.name,
	statements: Arr.map(run.statements, readStatement)
})

/** A statement's projected rows projected further onto `keep`, a subset of the columns it states, counts summed. */
const projectOnto = (
	read: ReadStatement,
	keep: (column: string) => boolean
): ReadonlyMap<string, RowCount> => {
	if (Arr.every(read.stated, keep)) {
		return read.projected
	}
	const kept = Arr.flatMap(read.stated, (c, i) => (keep(c) ? [i] : []))
	const out = new Map<string, RowCount>()
	for (const entry of read.projected.values()) {
		const row = Arr.map(kept, (i) => cellAt(entry.row, i))
		const key = rawRowKey(row)
		const seen = out.get(key)
		out.set(key, { row, count: (seen?.count ?? 0) + entry.count })
	}
	return out
}

/** The rows a statement repeats as values, among its rows that state every column, in a deterministic order. */
const repeatsIn = (side: RunSide, read: ReadStatement): ReadonlyArray<StatementRepeat> =>
	Arr.flatMap(
		Arr.sort(read.complete.entries(), byKey),
		([, entry]: readonly [string, RowCount]): ReadonlyArray<StatementRepeat> =>
			entry.count > 1
				? [{ side, label: read.statement.label, row: entry.row, count: entry.count - 1 }]
				: []
	)

/**
 * Compares two runs read once (readRun), left the baseline: what compareRuns states, reading no row again, so a
 * baseline read once is compared with each of many runs while only that run's rows are read.
 */
export const compareRead = (left: ReadRun, right: ReadRun): Comparison => {
	const structural: Array<StructuralDifference> = []
	const diffs: Array<StatementDiff> = []
	const rightByLabel = new Map(Arr.map(right.statements, (s) => [s.statement.label, s]))
	const leftLabels = new Set(Arr.map(left.statements, (s) => s.statement.label))
	for (const l of left.statements) {
		const label = l.statement.label
		const r = rightByLabel.get(label)
		if (r === undefined) {
			structural.push({ kind: "missing", side: right.name, label })
			continue
		}
		if (!sameColumns(l.statement.columns, r.statement.columns)) {
			structural.push({
				kind: "heading",
				label,
				left: l.statement.columns,
				right: r.statement.columns
			})
			continue
		}
		appendAll(structural, typeDifferences(l.statement, r.statement))
		const unstated = new Set([...unstatedColumns(l.statement), ...unstatedColumns(r.statement)])
		const stated = (column: string) => !unstated.has(column)
		const lp = projectOnto(l, stated)
		const rp = projectOnto(r, stated)
		/** Each fully stated row of a side leaving some cell unstated, which the other side does not hold as often. */
		const complete = (side: ReadStatement, other: ReadStatement): ReadonlyArray<RowCount> => {
			if (side.statement.unstated.kind === "none") {
				return []
			}
			if (other.statement.unstated.kind === "some") {
				throw new Error(`${label}: both runs leave a cell unstated`)
			}
			return excess(side.complete, other.complete)
		}
		const diff: StatementDiff = {
			label,
			missing: [...excess(lp, rp), ...complete(l, r)],
			extra: [...excess(rp, lp), ...complete(r, l)]
		}
		if (diff.missing.length > 0 || diff.extra.length > 0) {
			diffs.push(diff)
		}
	}
	for (const r of right.statements) {
		if (!leftLabels.has(r.statement.label)) {
			structural.push({ kind: "missing", side: left.name, label: r.statement.label })
		}
	}
	const repeated = [
		...Arr.flatMap(left.statements, (s) => repeatsIn("left", s)),
		...Arr.flatMap(right.statements, (s) => repeatsIn("right", s))
	]
	return {
		equal: structural.length === 0 && diffs.length === 0 && repeated.length === 0,
		structural,
		diffs,
		repeated
	}
}

const printRawRow = (row: RawRow): string =>
	`(${Arr.join(
		Arr.map(row, (v) => Formatter.format(v)),
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
		return `${leftName} and ${rightName} agree`
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
	for (const r of c.repeated) {
		lines.push(
			`  ${r.side === "left" ? leftName : rightName} repeats in ${r.label} ×${r.count}: ${printRawRow(r.row)}`
		)
	}
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
