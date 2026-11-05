import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { statementsFor } from "#adapter/migrate/ledger.ts"
import type { MigrationSession } from "#adapter/migrate/session.ts"
import { identity } from "#compiler/core/identity.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import type { Expr, ObjectName, SqlStatement } from "#compiler/sql/ast.ts"
import { lit } from "#compiler/sql/build.ts"
import { printObjectName, printStatement, quoteIdent } from "#compiler/sql/print.ts"
import {
	apply,
	keeping,
	kept,
	noFurther,
	openMigrator,
	type Reviewer,
	refusal,
	reviewedSource
} from "#test/pg/migrate/support.ts"
import { fixtureLogin } from "#test/pg/physical/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	fromEmpty,
	fromSnapshot,
	generate,
	type Previous,
	draftedAt
} from "#test/support/migrate/kit.ts"
import { readLedger } from "#test/support/migrate/ledger.ts"
import { draftActions, draftFiles, planStatements } from "#test/support/migrate/review.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { owning } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { shopV1, shopV2 } from "#test/unit/deploy/schemas.ts"

/** The folders of `versions` under `schema`, owned by `owner`, each drafted from the snapshot before and installed with
 * the fixture's worlds.
 *
 * The drift check after `grizzle migrate`: the catalog is compared with the target
 * snapshot and drift is refused: edits are allowed, drift is not, and a hand edit that diverges from the schema is
 * caught at deploy time rather than at the first failing query.
 *
 * The property, over drawn hand edits of a drawn folder's reviewed files: an edit that reaches the same state by
 * another route (a reviewer's comment, a statement with no effect, a scratch index built and dropped again on a drawn
 * column) is admitted; one that changes the state is refused at the stage drift after its files committed, and the
 * ledger records the folder, its latest target the folder's. The state-changing edits are drawn over every statement
 * of their kind the draft holds: an extra index on a drawn column, a drawn table taken from a drawn grant (or the grant
 * deleted), the EXECUTE grant of a drawn function deleted, a drawn index rebuilt over one more drawn column under its
 * drafted name, a CHECK predicate's constant raised by a drawn amount, a drawn VALIDATE CONSTRAINT deleted from a
 * Validate file (which leaves the constraint NOT VALID). Each edit of a drafted statement is its own printed text
 * replaced by its edited copy's, both printed from the typed plan. The history is the shop's first version, or its
 * first and second, the edit made in the second folder; a VALIDATE and a CHECK the draft adds NOT VALID are the
 * second's. Each version is installed with the fixture's worlds (`fixtureLogin`), whose roles
 * hold the grants the grant edits pick from. Drift made outside a migration is the admission suite's. */
const historyOf = (
	versions: ReadonlyArray<SchemaDesc>,
	schema: string,
	owner: string
): ReadonlyArray<GenerateResult> => {
	const out: Array<GenerateResult> = []
	let previous: Previous = fromEmpty
	for (const [i, desc] of versions.entries()) {
		const owned = owning(desc)
		const installation = succeeded(
			compileInstallation(owned, {
				...completeInstallOptions(
					owned,
					identity.schema(parsedSchemaName(schema)),
					[fixtureLogin(desc)],
					[]
				),
				owner
			})
		)
		const g = succeeded(
			generate({
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
type EditKind = (typeof sameState)[number] | (typeof drift)[number]
const editKinds = [...sameState, ...drift] as const
const changesState = (kind: EditKind): boolean => Arr.some(drift, (k) => k === kind)

/** A drawn edit's sketch: whether the edited folder is the second version's (the CHECK and the VALIDATE a draft adds
 * NOT VALID are), and picks into what the folder drafts. */
interface EditSketch {
	readonly second: boolean
	readonly picks: readonly [number, number, number]
}

/** A drawn edit: its sketch, and its kind, which the case draws (kindsFor). */
interface Edit extends EditSketch {
	readonly kind: EditKind
}

const editGen: Gen<EditSketch> = (source) => ({
	second: source.draw(boolean),
	picks: [source.draw(pickGen), source.draw(pickGen), source.draw(pickGen)]
})

type EditFeature = `${EditKind} ${"admitted" | "refused"}`

/** What an edit of a kind reaches: admitted when it reaches the same state, refused when it changes it. */
const featureOf = (kind: EditKind): EditFeature =>
	`${kind} ${changesState(kind) ? "refused" : "admitted"}`

/**
 * The kinds a case draws its edit from: where the case steers, the kinds whose feature the run had not reached when the
 * case's window began, so a kind is drawn while it is pending rather than left to its share of chance; every kind once
 * none is pending, and where the case may not steer, so the rotating stream's edits are plain draws.
 */
const kindsFor = (steering: Case<EditFeature>["steering"]): Arr.NonEmptyReadonlyArray<EditKind> =>
	Option.match(steering, {
		onNone: () => editKinds,
		onSome: (pending) =>
			Arr.match(
				Arr.filter(editKinds, (kind) => pending.has(featureOf(kind))),
				{ onEmpty: () => editKinds, onNonEmpty: (open) => open }
			)
	})

/** The folder an edit is made in: the CHECK and the VALIDATE are only the second version's to draft; the grants and
 * the indexes the edits pick from are the first's. */
const inSecond = (edit: Edit): boolean => {
	switch (edit.kind) {
		case "a CHECK raised":
		case "a VALIDATE deleted":
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
			Arr.flatMap(f.drafts, draftActions),
			(a) => a.kind === "statement" && spelled(a.statement) === spelled(statement)
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
const reviewerOf = (edit: Edit, g: GenerateResult, first: GenerateResult): Reviewer => {
	const [p0, p1, p2] = edit.picks
	const statements = planStatements(g.plan)
	switch (edit.kind) {
		case "a comment":
			return appended(g, p0, "-- reviewed", "no table")
		case "a statement with no effect":
			return appended(g, p0, "SELECT 1;", "no table")
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
 * committed, the ledger's latest target the last folder's either way. */
const applyEdited = (
	m: MigrationSession,
	schema: string,
	folders: ReadonlyArray<GenerateResult>,
	reviewer: Reviewer,
	refused: boolean
) =>
	Effect.gen(function* () {
		const last = defined(folders.at(-1), "the edited folder")
		const sources = [
			...Arr.map(folders.slice(0, -1), (g) => reviewedSource(g, kept)),
			reviewedSource(last, reviewer)
		]
		const applied = apply(m, { snapshot: last.snapshot, folders: sources }, noFurther)
		if (refused) {
			const refusedBy = yield* refusal(applied)
			assert.equal(refusedBy.stage, "drift")
		} else {
			yield* applied
		}
		const ledger = yield* readLedger(m, schema, succeeded(statementsFor(schema)))
		assert.equal(ledger.latest, last.snapshot.fingerprint)
	})

layer(Substrate.layer)("post-apply admission refuses drift", (it) => {
	it.effect("a hand edit may change how the state is reached, never the state", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const substrate = yield* Substrate
				const owner = substrate.owner.role
				const m = yield* openMigrator(substrate, substrate.owner)
				return yield* explore(
					{
						suite: "migrate/hand-edits",
						draw: drawn(editGen),
						literal: Formatter.format,
						kept: [],
						runs: 6,
						shrink: { kind: "bounded", candidates: 40 },
						concurrency: 1,
						steerEvery: 16,
						coverage: required<EditFeature>(Arr.map(editKinds, featureOf), {
							cases: 120,
							sense: notesOnly
						}),
						caseHang
					},
					(sketch, c) =>
						Effect.scoped(
							Effect.gen(function* () {
								const edit: Edit = { ...sketch, kind: c.steering.pipe(kindsFor, element, c.draw) }
								const schema = yield* substrate.schema({ create: false, label: "hand_edit" })
								const folders = historyOf(
									inSecond(edit) ? [shopV1, shopV2] : [shopV1],
									schema,
									owner
								)
								const reviewer = reviewerOf(
									edit,
									defined(folders[folders.length - 1]),
									defined(folders[0])
								)
								const refused = changesState(edit.kind)
								c.note(featureOf(edit.kind))
								yield* applyEdited(m, schema, folders, reviewer, refused)
							})
						)
				)
			})
		)
	)
})
