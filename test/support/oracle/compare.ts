import { Array as Arr, Formatter, Result } from "effect"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { appendAll, indices } from "#compiler/core/array.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
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

/** The rows at `indexes` of a statement, each keeping the columns `keep` admits, every cell its canonical text. */
const readRows = (
	s: StatementRows,
	indexes: ReadonlyArray<number>,
	keep: (column: string) => boolean
): ReadonlyArray<RawRow> => {
	const kept = Arr.flatMap(s.columns, (c, i) => (keep(c) ? [i] : []))
	const texts = Arr.map(kept, (i) => {
		const type = s.types[i]
		if (type === undefined) {
			throw new Error(`${s.label}: no type for column ${i}`)
		}
		return canonicalCell(type, s.codes)
	})
	return Arr.map(indexes, (r) => {
		const row = s.rows[r]
		if (row === undefined) {
			throw new Error(`${s.label}: no row ${r}`)
		}
		return Arr.map(kept, (i, j) => {
			const text = texts[j]
			if (text === undefined) {
				throw new Error(`${s.label}: no reader for column ${i}`)
			}
			return text(cellAt(row, i))
		})
	})
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

/**
 * The rows a statement repeats as values (canonicalRows), each with how many times past the first, in a deterministic
 * order: none for a set. Only rows that state every column are compared, since an unstated cell holds no value two
 * rows could share.
 */
const repeatsOf = (side: RunSide, s: StatementRows): ReadonlyArray<StatementRepeat> => {
	const rows = canonicalRows(s)
	const stated =
		s.unstated.kind === "some"
			? Arr.flatMap(s.unstated.complete, (i) => {
					const row = rows[i]
					return row === undefined ? [] : [row]
				})
			: rows
	return Arr.flatMap(Arr.sort(rowMultiset(stated).entries(), byKey), ([, entry]) =>
		entry.count > 1 ? [{ side, label: s.label, row: entry.row, count: entry.count - 1 }] : []
	)
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
		appendAll(structural, typeDifferences(l, r))
		const unstated = new Set([...unstatedColumns(l), ...unstatedColumns(r)])
		const all = (s: StatementRows) => Arr.map(indices(s.rows.length), (i) => i)
		const stated = (column: string) => !unstated.has(column)
		const projected = compareMultisets(readRows(l, all(l), stated), readRows(r, all(r), stated))
		/** Each fully stated row of a side leaving some cell unstated, which the other side does not hold as often. */
		const complete = (side: StatementRows, other: StatementRows): ReadonlyArray<RowCount> =>
			side.unstated.kind === "some"
				? compareMultisets(
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
	const repeated = [
		...Arr.flatMap(left.statements, (s) => repeatsOf("left", s)),
		...Arr.flatMap(right.statements, (s) => repeatsOf("right", s))
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
