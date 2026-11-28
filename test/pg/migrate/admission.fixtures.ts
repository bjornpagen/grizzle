/** What the properties of admission.test.ts read: its spaces, models and helpers. */

import { assert, assertVariant, defined } from "@bjornpagen/testing/assert"
import type { Pending } from "@bjornpagen/testing/features"
import { boolean, element, type Steered } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { readLedger } from "#adapter/migrate/apply.ts"
import { statementsFor } from "#adapter/migrate/ledger.ts"
import type { MigrationSession } from "#adapter/migrate/session.ts"
import { identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import type { Expr, ObjectName, SqlStatement } from "#compiler/sql/ast.ts"
import { lit } from "#compiler/sql/build.ts"
import { printObjectName, printStatement } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	draftCodes,
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	noDeclarations,
	type Previous
} from "#test/support/migrate/kit.ts"
import {
	draftActions,
	draftFiles,
	planStatements,
	reviewedStatements
} from "#test/support/migrate/review.ts"
import {
	apply,
	keeping,
	kept,
	noFurther,
	refusal,
	reviewedSource,
	type Reviewer
} from "#test/support/pg/migrate/support.ts"
import { fixtureLogin } from "#test/support/pg/physical/support.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { owning } from "#test/support/policy.ts"

/** The folders of `versions` under `schema`, owned by `owner`, each drafted from the snapshot before and installed with
 * the fixture's worlds. */
export const historyOf = (
	versions: ReadonlyArray<SchemaDesc>,
	schema: string
): ReadonlyArray<GenerateResult> => {
	const out: Array<GenerateResult> = []
	let previous: Previous = fromEmpty
	for (const [i, desc] of versions.entries()) {
		const owned = owning(desc)
		const installation = succeeded(
			compileInstallation(
				owned,
				completeInstallOptions(
					owned,
					[identity.schema(parsedSchemaName(schema))],
					[fixtureLogin(desc)],
					[],
					succeeded(draftCodes(desc, previous, noDeclarations))
				)
			)
		)
		const g = succeeded(
			generate({
				declared: noDeclarations,
				installation,
				timestamp: draftedAt(i + 1),
				previous,
				workload: noWorkload,
				name: `step_${i + 1}`
			})
		)
		out.push(g)
		previous = fromSnapshot(g.snapshot)
	}
	return out
}

/** The hand edits a reviewer may make: those that reach the same state by another route, and those that change it. */
const sameState = [
	"a comment",
	"a statement with no effect",
	"a scratch index built and dropped"
] as const

const drift = [
	"an extra index",
	"a grant narrowed",
	"an EXECUTE grant deleted",
	"an index widened",
	"a CHECK raised",
	"a VALIDATE deleted"
] as const

const raising = ["a statement that raises"] as const

type EditKind = (typeof sameState)[number] | (typeof drift)[number] | (typeof raising)[number]

export const editKinds = [...sameState, ...drift, ...raising] as const

/** What an apply of an edit meets: admitted, refused at drift after its files committed, or stopped at its statement. */
type EditOutcome = "admitted" | "drift" | "statement"

export const outcomeOf = (kind: EditKind): EditOutcome =>
	Arr.some(drift, (k) => k === kind)
		? "drift"
		: Arr.some(raising, (k) => k === kind)
			? "statement"
			: "admitted"

/** A drawn edit: whether the edited folder is the second version's (the CHECK and the VALIDATE a draft adds NOT VALID
 * are), picks into what the folder drafts, and its kind, drawn under the case's steering (kindsFor). */
interface Edit {
	readonly second: boolean
	readonly picks: readonly [number, number, number]
	readonly kind: EditKind
}

export type EditFeature = `${EditKind} ${"admitted" | "refused"}`

/** What an edit of a kind reaches: admitted when it reaches the same state, refused when it changes it or raises. */
export const featureOf = (kind: EditKind): EditFeature =>
	`${kind} ${outcomeOf(kind) === "admitted" ? "admitted" : "refused"}`

/**
 * The kinds the generator draws an edit's kind from: where the case steers, the kinds whose feature the run had not
 * reached when the case's window began, so a kind is drawn while it is pending rather than left to its share of chance;
 * every kind once none is pending, and where the case may not steer, so the rotating stream's edits are plain draws.
 */
const kindsFor = (
	steering: Option.Option<Pending<EditFeature>>
): Arr.NonEmptyReadonlyArray<EditKind> =>
	Option.match(steering, {
		onNone: () => editKinds,
		onSome: (pending) =>
			Arr.match(
				Arr.filter(editKinds, (kind) => pending.has(featureOf(kind))),
				{ onEmpty: () => editKinds, onNonEmpty: (open) => open }
			)
	})

/** An edit, its kind drawn among those its steering leaves pending (kindsFor) and kept in the sketch, so a kept case
 * runs the kind it was drawn with. */
export const editGen: Steered<Edit, EditFeature>["under"] = (steering) => (source) => ({
	second: source.draw(boolean),
	picks: [source.draw(pickGen), source.draw(pickGen), source.draw(pickGen)],
	kind: steering.pipe(kindsFor, element, source.draw)
})

/** The folder an edit is made in: the CHECK and the VALIDATE are only the second version's to draft; the grants and
 * the indexes the edits pick from are the first's. */
export const inSecond = (edit: Edit): boolean => {
	switch (edit.kind) {
		case "a CHECK raised":
		case "a VALIDATE deleted":
		case "a statement that raises":
			return true
		case "a grant narrowed":
		case "an EXECUTE grant deleted":
		case "an index widened":
			return false
		case "a comment":
		case "a statement with no effect":
		case "a scratch index built and dropped":
		case "an extra index":
			return edit.second
	}
}

/** A drafted statement as a file spells it. */
const spelled = (statement: SqlStatement): string => `${printStatement(statement)};`

/** A pick from a nonempty list; an empty one is a defect of the history. */
const picked = <A>(list: ReadonlyArray<A>, pick: number, what: string): A => {
	const [first, ...rest] = list
	if (first === undefined) {
		throw new Error(`the history drafts no ${what}`)
	}
	return pickFrom([first, ...rest], pick)
}

/** The name of the folder's one file drafting `statement`. */
const drafting = (g: GenerateResult, statement: SqlStatement): string => {
	const files = Arr.filter(draftFiles(g), (f) =>
		Arr.some(
			Arr.flatMap(Arr.flatMap(f.drafts, draftActions), reviewedStatements),
			(s) => spelled(s) === spelled(statement)
		)
	)
	const [only, ...more] = files
	if (only === undefined || more.length > 0) {
		throw new Error(`${files.length} files draft ${spelled(statement)}`)
	}
	return only.name
}

/** A reviewer who keeps every candidate, gives every placeholder '0', and then edits the folder's file `file`. */
const editing = (file: string, edit: (text: string) => string): Reviewer => ({
	decisions: () => keeping("'0'"),
	edit: (f) => (f.name === file ? edit(f.text) : f.text)
})

/** A text with the one occurrence of `from` replaced by `to`; any other count is a defect of the test. */
const replaced = (text: string, from: string, to: string): string => {
	assert.equal(Str.split(text, from).length, 2, `the file spells ${from} once`)
	return Str.replace(from, to)(text)
}

/** A drafted statement replaced by its edited copy, or deleted, in the file drafting it. */
const swapped = (g: GenerateResult, from: SqlStatement, to: SqlStatement): Reviewer =>
	editing(drafting(g, from), (text) => replaced(text, spelled(from), spelled(to)))

const deleted = (g: GenerateResult, statement: SqlStatement): Reviewer =>
	editing(drafting(g, statement), (text) => replaced(text, spelled(statement), ""))

/** Statements appended to a drawn file of the folder, from the file that creates `table` on when the folder does. */
const appended = (
	g: GenerateResult,
	pick: number,
	statements: string,
	table: ObjectName | "no table"
): Reviewer => {
	const files = draftFiles(g)
	const from =
		table === "no table"
			? 0
			: Option.getOrElse(
					Arr.findFirstIndex(files, (f) =>
						Arr.some(
							Arr.flatMap(f.drafts, draftActions),
							(a) =>
								a.kind === "statement" &&
								a.statement.kind === "createTable" &&
								a.statement.table.name === table.name
						)
					),
					() => 0
				)
	return editing(picked(files.slice(from), pick, "file").name, (text) => `${text}\n${statements}\n`)
}

/** The name of the folder's first file. */
const headFile = (g: GenerateResult): string => picked(draftFiles(g), 0, "file").name

/** The tables the first version creates, each with its columns. */
const tablesOf = (
	g: GenerateResult
): ReadonlyArray<{ readonly table: ObjectName; readonly columns: ReadonlyArray<string> }> =>
	Arr.flatMap(planStatements(g.plan), (s) =>
		s.kind === "createTable" ? [{ table: s.table, columns: Arr.map(s.columns, (c) => c.name) }] : []
	)

/** A drawn column of a drawn table, for an index the edit builds. */
const columnOf = (g: GenerateResult, picks: readonly [number, number]) => {
	const t = picked(tablesOf(g), picks[0], "table")
	return { table: t.table, column: picked(t.columns, picks[1], `column of ${t.table.name}`) }
}

/** The predicate with its constant raised by `by`: `weight >= 0` becomes `weight >= by`. */
const raised = (predicate: Expr, by: number): Expr => {
	if (
		predicate.kind !== "binary" ||
		predicate.right.kind !== "literal" ||
		predicate.right.value.kind !== "int"
	) {
		throw new Error("a drafted CHECK compares a column with an integer constant")
	}
	return {
		...predicate,
		right: lit.int(predicate.right.value.value + BigInt(by), predicate.right.type)
	}
}

/** The reviewer making the drawn edit in `g`, the folder the history edits; `first` is the first version's folder. */
export const reviewerOf = (edit: Edit, g: GenerateResult, first: GenerateResult): Reviewer => {
	const [p0, p1, p2] = edit.picks
	const statements = planStatements(g.plan)
	switch (edit.kind) {
		case "a comment":
			return appended(g, p0, "-- reviewed", "no table")
		case "a statement with no effect":
			return appended(g, p0, "SELECT 1;", "no table")
		case "a statement that raises":
			return editing(headFile(g), (text) => `SELECT 1 / 0;\n${text}`)
		case "a scratch index built and dropped": {
			const { table, column } = columnOf(first, [p1, p2])
			return appended(
				g,
				p0,
				`CREATE INDEX "scratch" ON ${printObjectName(table)} (${quoteIdent(column)});\nDROP INDEX ${printObjectName({ ...table, name: "scratch" })};`,
				table
			)
		}
		case "an extra index": {
			const { table, column } = columnOf(first, [p1, p2])
			return appended(
				g,
				p0,
				`CREATE INDEX "extra" ON ${printObjectName(table)} (${quoteIdent(column)});`,
				table
			)
		}
		case "a grant narrowed": {
			const grant = picked(
				Arr.flatMap(statements, (s) =>
					s.kind === "grant" && s.on.kind === "TABLE" ? [{ s, names: s.on.names }] : []
				),
				p0,
				"table grant"
			)
			const gone = picked(grant.names, p1, "granted table")
			const kept = Arr.filter(grant.names, (n) => n !== gone)
			return Arr.isReadonlyArrayNonEmpty(kept)
				? swapped(g, grant.s, { ...grant.s, on: { kind: "TABLE", names: kept } })
				: deleted(g, grant.s)
		}
		case "an EXECUTE grant deleted":
			return deleted(
				g,
				picked(
					Arr.filter(statements, (s) => s.kind === "grant" && s.on.kind === "FUNCTION"),
					p0,
					"function grant"
				)
			)
		case "an index widened": {
			const index = picked(
				Arr.flatMap(statements, (s) =>
					s.kind === "createIndex" && Arr.every(s.keys, (k) => k.key.kind === "column") ? [s] : []
				),
				p0,
				"index over columns"
			)
			const keyed = Arr.flatMap(index.keys, (k) => (k.key.kind === "column" ? [k.key.column] : []))
			const table = defined(
				Option.getOrUndefined(
					Arr.findFirst(tablesOf(first), (t) => t.table.name === index.table.name)
				),
				`the table of ${index.name}`
			)
			const extra = picked(
				Arr.filter(table.columns, (c) => !keyed.includes(c)),
				p1,
				`column outside ${index.name}`
			)
			return swapped(g, index, {
				...index,
				keys: [
					...index.keys,
					{
						key: { kind: "column", column: extra },
						collation: undefined,
						opclass: undefined,
						direction: "ASC"
					}
				]
			})
		}
		case "a CHECK raised": {
			const check = picked(
				Arr.flatMap(statements, (s) =>
					s.kind === "alterTable"
						? Arr.flatMap(s.actions, (a) =>
								a.kind === "addConstraint" && a.constraint.kind === "check" ? [{ s, a }] : []
							)
						: []
				),
				p0,
				"CHECK"
			)
			const by = (p1 % 9) + 1
			return swapped(g, check.s, {
				...check.s,
				actions: Arr.map(check.s.actions, (a) =>
					a === check.a && a.constraint.kind === "check"
						? {
								...a,
								constraint: { ...a.constraint, predicate: raised(a.constraint.predicate, by) }
							}
						: a
				)
			})
		}
		case "a VALIDATE deleted":
			return deleted(
				g,
				picked(
					Arr.filter(
						statements,
						(s) =>
							s.kind === "alterTable" && Arr.some(s.actions, (a) => a.kind === "validateConstraint")
					),
					p0,
					"VALIDATE"
				)
			)
	}
}

/** The apply of the history's folders, the last one edited: admitted, or refused at the stage drift after its files
 * committed, the ledger's latest target the last folder's either way; or stopped at the raising statement at the head
 * of the last folder's first file, the ledger's latest target the folder's before it. */
export const applyEdited = (
	m: MigrationSession,
	schema: string,
	folders: ReadonlyArray<GenerateResult>,
	reviewer: Reviewer,
	outcome: EditOutcome
) =>
	Effect.gen(function* () {
		const last = defined(folders.at(-1), "the edited folder")
		const sources = [
			...Arr.map(folders.slice(0, -1), (g) => reviewedSource(g, kept)),
			reviewedSource(last, reviewer)
		]
		const applied = apply(m, { snapshot: last.snapshot, folders: sources }, noFurther)
		const ledgerLatest = Effect.map(
			readLedger(m, schema, succeeded(statementsFor(schema))),
			(ledger) => ledger.latest
		)
		switch (outcome) {
			case "admitted": {
				yield* applied
				const latest = yield* ledgerLatest
				return assert.equal(latest, last.snapshot.fingerprint)
			}
			case "drift": {
				const refusedBy = yield* refusal(applied)
				assert.equal(refusedBy.stage, "drift")
				const latest = yield* ledgerLatest
				return assert.equal(latest, last.snapshot.fingerprint)
			}
			case "statement": {
				const refusedBy = yield* refusal(applied)
				const reason = refusedBy.reason
				assertVariant(reason, "_tag", "StatementFailed", "a raising statement stops its file")
				assert.deepEqual(
					{ folder: reason.folder, file: reason.file, statement: reason.statement },
					{ folder: last.folder.name, file: headFile(last), statement: 1 }
				)
				const before = defined(folders.at(-2), "the folder before the edited one")
				const latest = yield* ledgerLatest
				return assert.equal(latest, before.snapshot.fingerprint)
			}
		}
	})
