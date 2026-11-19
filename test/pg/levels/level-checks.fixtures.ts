/** What the properties of level-checks.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import {
	array,
	element,
	type Gen,
	int,
	map,
	oneOf,
	weighted,
	type Steered
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import type { MigrationPlace } from "#adapter/migrate/errors.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import {
	ChangeSet,
	type Law,
	type RefusedLaw,
	type RefusingObject,
	type Witness
} from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import {
	check,
	login,
	relation,
	role,
	schema,
	type Statement,
	wholeEntriesOf,
	writableNamesOf
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"
import type { Predicate } from "#compiler/types/core/phantom.ts"
import type { RowScalars } from "#compiler/types/schema/statements.ts"
import { levelNameAt } from "#test/support/compile.ts"
import type { Names } from "#test/support/kernel/naming.ts"
import { jsMatcher } from "#test/support/regex.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { admittedPatternOver, families, stringsOver } from "#test/unit/text/generators.ts"

/** Text of no byte bound: a query matches no pattern over it, and a row check matches any. */
const Wild = str.regex("^.*$", "su")

export const Attribute = relation("Attribute", { id: pg.integer, value: Wild, n: pg.integer }, [
	"id"
])

/** Media's own relation, which no check reads. */
const Note = relation("Note", { id: pg.integer }, ["id"])

type AttributeRow = RowScalars<typeof Attribute>

/** A leaf of a check's predicate: a match of the row's unbounded text, or its integer compared with a literal. */
type Leaf =
	| { readonly kind: "matches"; readonly pattern: string }
	| { readonly kind: "compare"; readonly op: "le" | "ge"; readonly n: number }

/** A check's predicate: a leaf, or NOT, AND and OR over predicates. */
type Pred =
	| Leaf
	| { readonly kind: "not"; readonly arg: Pred }
	| { readonly kind: "and" | "or"; readonly left: Pred; readonly right: Pred }

/** A row a case inserts: its text and its integer, its key the case's own. */
export interface Row {
	readonly value: string
	readonly n: number
}

/** The patterns a case's matches draw from: admitted ones over its family's alphabet, by construction. */
const patternGen = (alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<string> =>
	admittedPatternOver(alphabet)

const small = int(-3, 3)

/** A predicate nested at most `depth` levels over the alphabet's patterns: a leaf three times in five at each level. */
const predGen = (alphabet: Arr.NonEmptyReadonlyArray<number>, depth: number): Gen<Pred> => {
	const leaf = weighted<Pred>([
		[3, map(patternGen(alphabet), (pattern): Pred => ({ kind: "matches", pattern }))],
		[
			2,
			(source) => ({
				kind: "compare",
				op: source.draw(element<"le" | "ge">(["le", "ge"])),
				n: source.draw(small)
			})
		]
	])
	if (depth === 0) {
		return leaf
	}
	const inner = predGen(alphabet, depth - 1)
	return weighted<Pred>([
		[3, leaf],
		[1, (source) => ({ kind: "not", arg: source.draw(inner) })],
		[
			1,
			(source) => ({
				kind: source.draw(element<"and" | "or">(["and", "or"])),
				left: source.draw(inner),
				right: source.draw(inner)
			})
		]
	])
}

/** How deep a check's predicate nests. */
const predDepth = 2

/** A family's alphabet, by its index among the text generators' families. */
const alphabetOf = (family: number): Arr.NonEmptyReadonlyArray<number> =>
	defined(families[family], `the text family ${family}`).alphabet

const familyGen = int(0, families.length - 1)

const rowGen =
	(alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<Row> =>
	(source) => ({ value: source.draw(stringsOver(element(alphabet), 6)), n: source.draw(small) })

/** The predicate as a row check's callback writes it. */
const build = (p: Pred, a: AttributeRow): Predicate => {
	switch (p.kind) {
		case "matches":
			return Compute.matches(a.value, Compute.pattern(p.pattern))
		case "compare":
			return a[p.op](a.n, p.n)
		case "not":
			return a.not(build(p.arg, a))
		case "and":
		case "or":
			return a[p.kind](build(p.left, a), build(p.right, a))
	}
}

/** The predicate on a row, in two-valued logic over its NOT NULL fields, each match by ECMAScript's own test. */
export const holds = (p: Pred, row: Row): boolean => {
	switch (p.kind) {
		case "matches":
			return jsMatcher(p.pattern, "u")(row.value)
		case "compare":
			return p.op === "le" ? row.n <= p.n : row.n >= p.n
		case "not":
			return !holds(p.arg, row)
		case "and":
			return holds(p.left, row) && holds(p.right, row)
		case "or":
			return holds(p.left, row) || holds(p.right, row)
	}
}

/** Whether a predicate matches the unbounded text. */
export const readsMatch = (p: Pred): boolean => {
	switch (p.kind) {
		case "matches":
			return true
		case "compare":
			return false
		case "not":
			return readsMatch(p.arg)
		case "and":
		case "or":
			return readsMatch(p.left) || readsMatch(p.right)
	}
}

/** A check a case states: its declared name and its predicate. */
interface Stated {
	readonly name: string
	readonly pred: Pred
}

/**
 * The initial a check's name starts with, which orders its installed name among the table's others: PostgreSQL tries a
 * table's CHECKs in the order of their names, so Base's and Media's interleave as the draws fall.
 */
const initials = ["A", "M", "Z"] as const

/** A check as a case draws it: the initial of its name and its predicate. */
interface Drawn {
	readonly initial: (typeof initials)[number]
	readonly pred: Pred
}

const drawnGen =
	(pred: Gen<Pred>): Gen<Drawn> =>
	(source) => ({ initial: source.draw(element(initials)), pred: source.draw(pred) })

/** Checks named by their initial, `stem` and their position, one per drawn predicate. */
export const named = (stem: string, drawn: ReadonlyArray<Drawn>): ReadonlyArray<Stated> =>
	Arr.map(drawn, (d, i) => ({ name: `${d.initial}${stem}${i}`, pred: d.pred }))

const statementsOf = (checks: ReadonlyArray<Stated>): Array<Statement> =>
	Arr.map(checks, (c) => check(c.name, Attribute, (a) => build(c.pred, a)))

/** A check of Attribute as an outcome names it. */
export const checkLaw = (name: string): Extract<Law, { readonly kind: "check" }> => ({
	kind: "check",
	relation: "Attribute",
	name
})

/**
 * The two levels under `name`, the upper one under its allocated name (levelNameAt): Base with Attribute and its own
 * checks, Media over it with Note and its checks over Attribute; the author over Base and the editor over Media, each
 * inserting Attribute.
 */
export const levelsAt = (
	name: string,
	own: ReadonlyArray<Stated>,
	level: ReadonlyArray<Stated>
) => {
	const base = schema(name, [Attribute], statementsOf(own))
	const media = schema.extend(base, levelNameAt(name, 1), [Note], statementsOf(level))
	const author = role(base, "author", wholeEntriesOf(base), { write: writableNamesOf(base) })
	const editor = role(media, "editor", wholeEntriesOf(media), { write: ["Attribute"] })
	return {
		base,
		media,
		author,
		editor,
		authorApp: login(base, "author_app", [author], {
			workload: [workload(author, { add: ChangeSet.empty(base).insert(Attribute, []) })]
		}),
		editorApp: login(media, "editor_app", [editor], {
			workload: [workload(editor, { add: ChangeSet.empty(media).insert(Attribute, []) })]
		})
	}
}

/** Every CHECK constraint on Attribute's table, by name, as the owner reads the catalog. */
export const checksOn = (names: Names) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const rows = yield* s.admin.queryValues(
			"SELECT conname::text FROM pg_catalog.pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'",
			[names.table(Attribute)]
		)
		return Arr.map(rows, (r) => String(r[0]))
	})

/** Whether a refusal's object is the CHECK `name` on the table `table`. */
export const byCheck = (by: RefusingObject, table: string, name: string): boolean =>
	by.kind === "constraint" && by.table === table && by.name === name

/** The laws a refusal names, each as an outcome describes it. */
export const lawsNamed = (laws: ReadonlyArray<RefusedLaw<Law>>): ReadonlyArray<Law> =>
	Arr.map(laws, (l) => l.law)

/** A key witness of Attribute's row `id`. */
export const keyOf = (id: number): Witness => ({
	kind: "key",
	relation: "Attribute",
	values: { id }
})

/** A case of the logins' property: Base's own checks, Media's, and the rows inserted through both logins. */
interface LoginsCase {
	readonly family: number
	readonly own: ReadonlyArray<Drawn>
	readonly level: Arr.NonEmptyReadonlyArray<Drawn>
	readonly rows: Arr.NonEmptyReadonlyArray<Row>
}

const loginsCase: Gen<LoginsCase> = (source) => {
	const family = source.draw(familyGen)
	const alphabet = alphabetOf(family)
	const pred = drawnGen(predGen(alphabet, predDepth))
	const row = rowGen(alphabet)
	return {
		family,
		own: source.draw(array(pred, { min: 0, max: 2 })),
		level: [source.draw(pred), ...source.draw(array(pred, { min: 0, max: 2 }))],
		rows: [source.draw(row), ...source.draw(array(row, { min: 0, max: 7 }))]
	}
}

export type LoginsFeature =
	| "an unbounded text matched by a pattern"
	| "a row a level's match refuses"
	| "a row stored through both logins"
	| "refused through the editor"
	| "two checks broken at once"
	| "the author refused by its own check, a level's broken too"
	| "the author refused by a level's check, its own broken too"
	| "the author refused by a level's check alone"

/**
 * A case whose first row breaks an own check PostgreSQL tries before every check of Media's: the drawn case with one more
 * own check, named by the first initial, that the row breaks, and Media's checks, the drawn ones and one more the row
 * breaks, each named by the last initial.
 */
const ownFirst = (k: LoginsCase): LoginsCase => {
	const { n } = Arr.headNonEmpty(k.rows)
	const ownBroken: Drawn = {
		initial: Arr.headNonEmpty(initials),
		pred: { kind: "compare", op: "ge", n: n + 1 }
	}
	const levelBroken: Drawn = {
		initial: Arr.lastNonEmpty(initials),
		pred: { kind: "compare", op: "le", n: n - 1 }
	}
	return {
		...k,
		own: [...k.own, ownBroken],
		level: Arr.append(
			Arr.map(k.level, (d) => ({ ...d, initial: Arr.lastNonEmpty(initials) })),
			levelBroken
		)
	}
}

/**
 * The cases a witness checks: drawn ones (loginsCase), or, while the author's refusal by its own check with a level's
 * broken too is pending (Pending `names`), in half of them the drawn one with its first row breaking an own check named
 * first (ownFirst), which a drawn case meets too rarely for the floor and the steered phase. Unsteered (the rotating
 * stream), a plain draw.
 */
export const steeredLogins: Steered<LoginsCase, LoginsFeature>["under"] = (steering) =>
	Option.exists(steering, (pending) =>
		pending.names("the author refused by its own check, a level's broken too")
	)
		? oneOf([loginsCase, map(loginsCase, ownFirst)])
		: loginsCase

/** Media's checks over every row a migration case stores and probes. */
interface MigrationCase {
	readonly family: number
	readonly level: Arr.NonEmptyReadonlyArray<Drawn>
	readonly seeds: ReadonlyArray<Row>
	readonly probes: Arr.NonEmptyReadonlyArray<Row>
}

export const migrationCase: Gen<MigrationCase> = (source) => {
	const family = source.draw(familyGen)
	const alphabet = alphabetOf(family)
	const pred = drawnGen(predGen(alphabet, predDepth))
	const row = rowGen(alphabet)
	return {
		family,
		level: [source.draw(pred), ...source.draw(array(pred, { min: 0, max: 2 }))],
		seeds: source.draw(array(row, { min: 0, max: 4 })),
		probes: [source.draw(row), ...source.draw(array(row, { min: 0, max: 3 }))]
	}
}

export type MigrationFeature =
	| "a migration refused by a stored row"
	| "a migration applied over stored rows"
	| "a probe refused"
	| "a probe stored"

/** The first key a migration case's probes take, past every seed's. */
export const probeKeys = 1000

/** Whether a migration's refusal stands in a drafted file of the Validate phase. */
export const inValidate = (place: MigrationPlace): boolean =>
	(place.kind === "file" || place.kind === "statement") && Str.endsWith("-validate.sql")(place.file)

/** A level's record as the snapshot holds it, laws as their identities, for a comparison as a value. */
export const levelRecord = (snapshot: DeploySnapshot, at: number) => {
	const level = defined(snapshot.levels[at], `the snapshot's level ${at}`)
	return {
		name: level.name,
		schema: level.schema,
		fingerprint: level.fingerprint,
		laws: Arr.map(level.laws, (l) => l.law)
	}
}
