import { Array as Arr, Record } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { type ScalarType, typeLabel } from "#compiler/ir/scalar.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import type { SpelledValue } from "#test/support/oracle/gen/domain.ts"
import type { GenFacts, LiteralRow, StoredRow } from "#test/support/oracle/gen/facts.ts"
import { printDag, printLiteral } from "#test/support/oracle/gen/print-dag.ts"
import type { GenParam, GenQuery } from "#test/support/oracle/gen/query.ts"
import { closedHeading, type GenSchema } from "#test/support/oracle/gen/schema.ts"
import { elementAt } from "#test/support/oracle/pick.ts"

const printRow = (row: LiteralRow, columns: ReadonlyArray<{ readonly type: ScalarType }>): string =>
	`(${Arr.join(
		Arr.map(row, (v, i) => printLiteral(v, elementAt(columns, i, "a printed row's columns").type)),
		", "
	)})`

const printSchema = (schema: GenSchema): string => {
	const lines = [`schema ${schema.name}`]
	for (const c of schema.closed) {
		const payload = Arr.join(
			Arr.map(c.payload, (p) => `, ${p.name} ${typeLabel(p.type)}`),
			""
		)
		lines.push(`  closed ${c.name}(id${payload}) handles [${Arr.join(c.handles, ", ")}]`)
		for (const row of c.rows) {
			lines.push(`    ${printRow(row, closedHeading(c))}`)
		}
	}
	for (const r of schema.relations) {
		const cols = Arr.join(
			Arr.map(r.columns, (c) => `${c.name} ${typeLabel(c.type)}`),
			", "
		)
		const keys = Arr.join(
			Arr.map(r.keys, (k) => ` key(${Arr.join(k, ", ")})`),
			""
		)
		lines.push(
			`  relation ${r.name}(${cols}) primary(${Arr.join(r.primaryKey, ", ")})${keys}${r.mutable ? " mutable" : ""}`
		)
	}
	for (const c of schema.containments) {
		lines.push(
			`  contained ${c.from.relation}(${Arr.join(c.from.fields, ", ")}) -> ${c.to.relation}(${Arr.join(c.to.fields, ", ")})`
		)
	}
	return Arr.join(lines, "\n")
}

/** A stored value: its literal, and the twin spelling it is stored in where it is not its canonical one. */
const printStored = (v: SpelledValue, type: ScalarType): string =>
	v.spelling.kind === "canonical"
		? printLiteral(v.literal, type)
		: `${printLiteral(v.literal, type)} stored as ${JSON.stringify(v.spelling.text)}`

const printStoredRow = (
	row: StoredRow,
	columns: ReadonlyArray<{ readonly type: ScalarType }>
): string =>
	`(${Arr.join(
		Arr.map(row, (v, i) => printStored(v, elementAt(columns, i, "a printed row's columns").type)),
		", "
	)})`

const printFacts = (schema: GenSchema, facts: GenFacts): string => {
	const lines = ["facts"]
	for (const r of schema.relations) {
		const rows = facts[r.name] ?? []
		lines.push(`  ${r.name}: ${rows.length === 0 ? "{}" : ""}`)
		for (const row of rows) {
			lines.push(`    ${printStoredRow(row, r.columns)}`)
		}
	}
	return Arr.join(lines, "\n")
}

const printParam = (id: string, p: GenParam): ReadonlyArray<string> => {
	if (p.kind === "scalar") {
		return [`  ${id} = ${printLiteral(p.value, p.type)}`]
	}
	const head = Arr.join(
		Arr.map(p.heading, (c) => `${c.name} ${typeLabel(c.type)}`),
		", "
	)
	return [
		`  ${id}(${head}) = ${p.rows.length === 0 ? "{}" : ""}`,
		...Arr.map(p.rows, (row) => `    ${printRow(row, p.heading)}`)
	]
}

const printQuery = (query: GenQuery): string => {
	const lines = ["params"]
	for (const [id, p] of Record.toEntries(query.params)) {
		appendAll(lines, printParam(id, p))
	}
	if (lines.length === 1) {
		lines.push("  (none)")
	}
	lines.push("query", printDag(query.dag))
	return Arr.join(lines, "\n")
}

/**
 * The printable form of a generated case: every failure shrinks to a printable case.
 *
 * Plain text, deterministic, and complete: the schema with its keys, mutability and containments, the closed facts,
 * the stored facts, the parameter values, and the query DAG in the IR's own rendering (print-dag.ts). A failing
 * property prints this, so a shrunk counterexample can be read and reproduced by hand.
 */
export const printQueryCase = (c: QueryCase): string =>
	Arr.join(
		[
			`spelling ${c.spelling.mode}${c.spelling.edge ? ", edge classes" : ""}`,
			printSchema(c.schema),
			printFacts(c.schema, c.facts),
			printQuery(c.query)
		],
		"\n"
	)
