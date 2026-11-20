/**
 * No statement that writes an installed table plans a constant (physical/ddl/row-functions.ts): every table CHECK and
 * stored generation an installation creates either calls no constant of the installation's data and holds literals of
 * no more bytes together than inlineLiteralMaxBytes, which PostgreSQL would read again in every statement that writes
 * the table, or is the call of a row function, a PL/pgSQL constant each backend plans once.
 *
 * - **Property:** over installations aimed at constants and literals, every CHECK and every stored generation (its
 *   expression, a partial one's selection and expression apart) of every CREATE TABLE and ALTER TABLE an installation's statements hold calls no
 *   zero-parameter SQL constant, a closed relation's, a roster's or a dictionary's, matches no pattern, and its
 *   literals hold no more bytes together than inlineLiteralMaxBytes; and each row function it calls is a PL/pgSQL constant of the installation.
 * - **Oracle:** specification: the work a statement plans for the table's expressions, read off the printed statements'
 *   tree, the constants by their CREATE (a literal pack, or an SQL constant of no parameter) and each literal by its
 *   value's bytes as a stored expression spells them.
 * - **Space:** a relation contained in a closed relation, whose CHECK reads the closed relation's constants; and a relation
 *   whose CHECK and whose key's selection match a pattern of a drawn length across inlineLiteralMaxBytes, with and
 *   without a generated field that holds no literal (row-functions.fixtures.ts).
 * - **Features:** a CHECK and a generation calling a row function; a CHECK and a generation left inline; a row
 *   function hoisted for the constants it calls alone, and one for literals past the bound by at most the bound.
 */

import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { inlineLiteralMaxBytes } from "#compiler/physical/ddl/row-functions.ts"
import type {
	ColumnGeneration,
	Expr,
	LiteralValue,
	SqlStatement,
	TableConstraint
} from "#compiler/sql/ast.ts"
import { identityHooks, transformExpr } from "#compiler/sql/transform.ts"
import { installationOf, rowCaseGen } from "#test/unit/physical/row-functions.fixtures.ts"

type RowFeature =
	| "a CHECK calling a row function"
	| "a generation calling a row function"
	| "a CHECK left inline"
	| "a generation left inline"
	| "a row function for its constants alone"
	| "a row function for literals just past the bound"

/** A literal's data as a stored expression's text spells it, a byte at a time: a text's or a numeric's UTF-8 bytes and
 * a bit string's whole bytes; a NULL, a boolean's or a by-value number's datum is the expression's structure, counted
 * none. */
const spelledBytes = (value: LiteralValue): number => {
	switch (value.kind) {
		case "text":
		case "decimal":
			return utf8Length(value.value)
		case "bits":
			return Math.ceil(value.hex.length / 2)
		case "bool":
		case "int":
		case "float":
		case "floatSpecial":
		case "null":
			return 0
	}
}

/** The functions an installation's statements create, by name: each zero-parameter SQL constant, its data's, and each
 * PL/pgSQL constant, a row function. */
const constantsOf = (
	statements: ReadonlyArray<SqlStatement>
): { readonly data: ReadonlySet<string>; readonly rows: ReadonlySet<string> } => {
	const data = new Set<string>()
	const rows = new Set<string>()
	for (const s of statements) {
		if (s.kind === "packConstant") {
			data.add(s.function.name)
		}
		if (s.kind === "createConstant" && s.language === "sql" && s.params.length === 0) {
			data.add(s.name.name)
		}
		if (s.kind === "createConstant" && s.language === "plpgsql") {
			rows.add(s.name.name)
		}
	}
	return { data, rows }
}

/** An expression's nodes and the qualified functions it calls, each as the walk meets it. */
const walked = (
	expr: Expr
): { readonly nodes: ReadonlyArray<Expr>; readonly called: ReadonlyArray<string> } => {
	const nodes: Array<Expr> = []
	const called: Array<string> = []
	transformExpr(expr, {
		...identityHooks,
		expr: (e) => {
			nodes.push(e)
			return e
		},
		functionRef: (fn) => {
			called.push(fn.name)
			return fn
		}
	})
	return { nodes, called }
}

/** The bytes of literal data an expression's nodes hold together (spelledBytes). */
const literalData = (nodes: ReadonlyArray<Expr>): number =>
	Arr.reduce(nodes, 0, (sum, e) => sum + (e.kind === "literal" ? spelledBytes(e.value) : 0))

/** Whether one of an expression's nodes matches a text against a literal pattern. */
const matchesALiteral = (nodes: ReadonlyArray<Expr>): boolean =>
	Arr.some(nodes, (e) => e.kind === "binary" && e.op === "~" && e.right.kind === "literal")

/** What a write of a table plans of one of its expressions: a CHECK's predicate or a generation's expression. */
interface Planned {
	readonly expr: Expr
	readonly kind: "CHECK" | "generation"
}

/** A generation's expressions, a partial one's selection and expression apart. */
const generationOf = (g: ColumnGeneration | undefined): ReadonlyArray<Planned> => {
	switch (g?.kind) {
		case "stored":
			return [{ expr: g.expr, kind: "generation" }]
		case "partial":
			return [
				{ expr: g.when, kind: "generation" },
				{ expr: g.expr, kind: "generation" }
			]
		case "retirement":
		case undefined:
			return []
	}
}

/** A table constraint's predicate, where it is a CHECK. */
const checkOf = (c: TableConstraint): ReadonlyArray<Planned> =>
	c.kind === "check" ? [{ expr: c.predicate, kind: "CHECK" }] : []

/** The expressions of a table's statement a write of it plans: each CHECK it adds and each generation of a column it
 * adds. */
const plannedOf = (s: SqlStatement): ReadonlyArray<Planned> => {
	if (s.kind === "createTable") {
		return [
			...Arr.flatMap(s.columns, (c) => generationOf(c.generated)),
			...Arr.flatMap(s.secondary, checkOf)
		]
	}
	if (s.kind === "alterTable") {
		return Arr.flatMap(s.actions, (a) =>
			a.kind === "addColumn"
				? generationOf(a.column.generated)
				: a.kind === "addConstraint"
					? checkOf(a.constraint)
					: []
		)
	}
	return []
}

/** No table's CHECK or stored generation plans a constant: each calls a row function or reads nothing past the bound. */
export const noStatementPlansAConstantOfATablesChecksOrGenerations = property.explore(rowCaseGen, {
	needs: {},
	budget: { runs: 40, steered: 40 },
	situations: [
		"a CHECK calling a row function",
		"a generation calling a row function",
		"a CHECK left inline",
		"a generation left inline",
		"a row function for its constants alone",
		"a row function for literals just past the bound"
	] satisfies ReadonlyArray<Reached<RowFeature>>,
	check: (_, c: Case<RowFeature>) => (rowCase) =>
		Effect.sync(() => {
			const statements = installationOf(rowCase).statements
			const { data, rows } = constantsOf(statements)
			for (const s of statements) {
				if (s.kind !== "createConstant" || s.language !== "plpgsql") {
					continue
				}
				const body = walked(s.body)
				const callsData = Arr.some(body.called, (name) => data.has(name))
				const matchesPattern = matchesALiteral(body.nodes)
				const bytes = literalData(body.nodes)
				if (callsData && bytes <= inlineLiteralMaxBytes) {
					c.note("a row function for its constants alone")
				}
				if (
					!callsData &&
					!matchesPattern &&
					bytes > inlineLiteralMaxBytes &&
					bytes <= 2 * inlineLiteralMaxBytes
				) {
					c.note("a row function for literals just past the bound")
				}
			}

			for (const s of statements) {
				for (const { expr, kind } of plannedOf(s)) {
					const read = walked(expr)
					for (const name of read.called) {
						assert.ok(!data.has(name), `a ${kind} calls the constant ${name}`)
					}
					const called = Arr.some(read.called, (name) => rows.has(name))
					const bytes = literalData(read.nodes)
					assert.ok(
						bytes <= inlineLiteralMaxBytes,
						`a ${kind} holds literals of ${bytes} bytes, past ${inlineLiteralMaxBytes}`
					)
					assert.ok(!matchesALiteral(read.nodes), `a ${kind} matches a pattern in place`)
					c.note(
						kind === "CHECK"
							? called
								? "a CHECK calling a row function"
								: "a CHECK left inline"
							: called
								? "a generation calling a row function"
								: "a generation left inline"
					)
				}
			}
		}),
	oracle: {
		kind: "specification",
		name: "the constants and literals a statement writing a table plans, read off its CHECKs and generations"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/physical/ddl/row-functions.ts",
			original: "\tif (!hoists(scope, expr)) {\n",
			replacement: "\tif (expr === expr) {\n",
			why: "No expression is hoisted: every CHECK and stored generation calls its constants and holds its literals in place, so every statement that writes the table evaluates each constant and reads each literal back again."
		},
		{
			file: "packages/engine/src/physical/ddl/row-functions.ts",
			original: "\t\tbytes > inlineLiteralMaxBytes\n",
			replacement: "\t\tbytes > 2 * inlineLiteralMaxBytes\n",
			why: "Literals up to twice the bound stay inline, so a statement writing its table reads back literals whose bytes cost it more than a row's call of the function."
		},
		{
			file: "packages/engine/src/physical/ddl/row-functions.ts",
			original: "\t\tnodes.some((e) => matchedLanguage(scope, e) !== undefined) ||\n",
			replacement: "\t\tnodes.some(() => false) ||\n",
			why: "A pattern whose spelling's ARE is short stays inline, so a statement writing its table reads it back, and two spellings of one language install different objects."
		},
		{
			file: "packages/engine/src/physical/ddl/context.ts",
			original:
				"\t\t\treadsConstant: (fn) => fn.schema === this.schema && this.#readsData(fn.name),\n",
			replacement: "\t\t\treadsConstant: (fn) => fn.schema !== fn.schema,\n",
			why: "A CHECK or a generation calling a constant of the installation's data stays inline unless a literal hoists it, so a statement writing its table evaluates the constant and copies its value."
		}
	]
})
