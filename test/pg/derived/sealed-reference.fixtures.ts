/**
 * What the properties of sealed-reference.test.ts read: a package's content in a unit sealed at founding and a learner's
 * attempts and notes in a unit of their own, a stored relation of the content and six stored relations over both that
 * read the content by reference, their template,
 * the writes a case draws, the host's model of what each stored relation holds, and each case's run.
 */

import { assert } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { compileInstallation } from "#compiler/program/install.ts"
import { contract, bool, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	derived,
	mutable,
	on,
	relation,
	schema,
	sealed,
	unit
} from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { asDataStep } from "#test/support/data-step.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import {
	committedJudged,
	type JudgePlan,
	judgeRun,
	type JudgeStatement,
	judgeStatementsOf,
	scannedWork,
	standUpJudge
} from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

const childKey = Symbol("Child")
/** A learner, by a number of its own type, so no package's number leads a learner's key. */
const Child = contract<typeof childKey>()("Child", int4)
const packageNoKey = Symbol("PackageNo")
/** A package, by a number of its own type, so no learner's number leads a package's key. */
const PackageNo = contract<typeof packageNoKey>()("PackageNo", int4)

/** A package, the root of its content. */
const Package = relation("Package", { package: PackageNo }, ["package"])
/** An item of a package: whether it is adaptive, and its maximum. */
const Item = relation("Item", { package: PackageNo, item: int4, adaptive: bool, max: int4 }, [
	"package",
	"item"
])
/** A variable of an item an End Attempt binds, and whether it counts an attempt: ledger's uncountingResponses. */
const Hint = relation("Hint", { package: PackageNo, item: int4, variable: int4, counts: bool }, [
	"package",
	"item",
	"variable"
])
/** A learner's attempt at an item of a package, numbered. */
const Attempt = relation("Attempt", { child: Child, package: PackageNo, item: int4, n: int4 }, [
	"child",
	"package",
	"item",
	"n"
])
/** A variable's value at an attempt. */
const Snapshot = relation(
	"Snapshot",
	{
		child: Child,
		package: PackageNo,
		item: int4,
		n: int4,
		variable: int4,
		value: bool
	},
	["child", "package", "item", "n", "variable"]
)

/**
 * A learner's note at an attempt's item, numbered as the attempt is: mutable in the learner's unit, so the stored
 * relation over it and the content (`Noted`) has open holders alone.
 */
const Note = relation("Note", { child: Child, package: PackageNo, item: int4, n: int4 }, [
	"child",
	"package",
	"item",
	"n"
])

/** The content, sealed at founding, and the learner's rows, each attempt naming an item of a founded package. */
const Base = schema(
	"SealedReference",
	[Package, Item, Hint, Attempt, Snapshot, Note],
	[
		unit("Learner", { child: Child }),
		mutable(Note),
		sealed(unit("Package", { package: PackageNo })),
		contained(on(Item, "package"), on(Package, "package")),
		contained(on(Hint, "package", "item"), on(Item, "package", "item")),
		contained(on(Attempt, "package", "item"), on(Item, "package", "item")),
		contained(on(Note, "package", "item"), on(Item, "package", "item")),
		contained(
			on(Snapshot, "child", "package", "item", "n"),
			on(Attempt, "child", "package", "item", "n")
		)
	]
)

/**
 * Each item of a package with a maximum of 0 or more, a definition of the content alone, stored in the package's unit and
 * kept at its founding write (analysis/theory/frozen.ts foundedAt): ledger's MaximumOutcome, MemberControl and ItemMode.
 */
const Graded = derived(
	"Graded",
	query(Base).rule((r) => {
		const { package: p, item: i, max } = v(Item, "i")
		return r
			.match(Item, { package: p, item: i, max })
			.where(r.ge(max, 0))
			.find({ package: p, item: i, max })
	})
)

/** The content's stored relation, a level over the content and the learners' rows. */
const Content = schema.extend([Base], "SealedReference_1", [Graded], [])

/** Each attempt with its item's graded maximum, the content's stored relation read by reference, a level above it. */
const Scored = derived(
	"Scored",
	query(Content).rule((r) => {
		const { child, package: p, item: i, n } = v(Attempt, "a")
		const { max } = v(Graded, "g")
		return r
			.match(Attempt, { child, package: p, item: i, n })
			.match(Graded, { package: p, item: i, max })
			.find({ child, package: p, item: i, n, max })
	})
)

/** Each attempt with its item's maximum: ledger's AttemptCredit over MaximumOutcome. */
const Credit = derived(
	"Credit",
	query(Base).rule((r) => {
		const { child, package: p, item: i, n } = v(Attempt, "a")
		const { max } = v(Item, "i")
		return r
			.match(Attempt, { child, package: p, item: i, n })
			.match(Item, { package: p, item: i, max })
			.find({ child, package: p, item: i, n, max })
	})
)

/** Each attempt at an item that is not adaptive: ledger's ItemSessionOpen, the content negated. */
const Open = derived(
	"Open",
	query(Base).rule((r) => {
		const { child, package: p, item: i, n } = v(Attempt, "a")
		return r
			.match(Attempt, { child, package: p, item: i, n })
			.where(r.not(Item, { package: p, item: i, adaptive: true }))
			.find({ child, package: p, item: i, n })
	})
)

/** Each variable a hint that counts none binds, by its package and item: a query of the content alone. */
const uncounting = query(Base).rule((r) => {
	const { package: p, item: i, variable: x } = v(Hint, "h")
	return r
		.match(Hint, { package: p, item: i, variable: x, counts: false })
		.find({ package: p, item: i, variable: x })
})

/** Each attempt a hint that counts none ended, its variable true. */
const uncounted = query(Base).rule((r) => {
	const { child, package: p, item: i, n } = v(Attempt, "a")
	const { variable: x } = v(uncounting, "u")
	return r
		.match(Attempt, { child, package: p, item: i, n })
		.match(uncounting, { package: p, item: i, variable: x })
		.match(Snapshot, { child, package: p, item: i, n, variable: x, value: true })
		.find({ child, package: p, item: i, n })
})

/** Each attempt counted: ledger's CountedAttempt, every attempt but one a hint that counts none ended. */
const Counted = derived(
	"Counted",
	query(Base).rule((r) => {
		const { child, package: p, item: i, n } = v(Attempt, "a")
		return r
			.match(Attempt, { child, package: p, item: i, n })
			.where(r.not(uncounted, { child, package: p, item: i, n }))
			.find({ child, package: p, item: i, n })
	})
)

/**
 * Each learner's attempts at an item, counted, beside the item's maximum: ledger's numAttempts beside MaximumOutcome, a
 * fold whose groups no delta form reads, so its upkeep is a unit form, re-deriving the groups a write touched.
 */
const Tried = derived(
	"Tried",
	query(Base).rule((r) => {
		const { child, package: p, item: i, n } = v(Attempt, "a")
		const { max } = v(Item, "i")
		return r
			.match(Attempt, { child, package: p, item: i, n })
			.match(Item, { package: p, item: i, max })
			.find({ child, package: p, item: i, max, tries: r.count() })
	})
)

/**
 * Each note with its item's maximum: a stored relation whose one holder, Note, is open, the closed content read by
 * reference alone (ir/unit.ts StoredUnit `references`), so a data step's revision of the content is what makes it its
 * definition's rows again, by its bracket's re-check (physical/ddl/recheck.ts, a stored relation over a closed relation
 * by reference), no judge upkeep reading the content's removed or rewritten rows.
 */
const Noted = derived(
	"Noted",
	query(Base).rule((r) => {
		const { child, package: p, item: i, n } = v(Note, "o")
		const { max } = v(Item, "i")
		return r
			.match(Note, { child, package: p, item: i, n })
			.match(Item, { package: p, item: i, max })
			.find({ child, package: p, item: i, n, max })
	})
)

/** The content, the learner's rows, the content's stored relation, and the six stored relations over them. */
const SealedReference = schema.extend(
	[Content],
	"SealedReference_2",
	[Credit, Open, Counted, Scored, Tried, Noted],
	[]
)

/** SealedReference installed through its first migration, with no login. */
export const sealedReferenceTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "sealed reference",
	content: { schema: "SealedReference", logins: [] },
	versions: [{ schema: SealedReference, declarations: noDeclarations }],
	options: {
		label: "sealed_reference",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** The items of every package, 0 and 1. */
const items = [0, 1] as const

/** Item `item` of package `p` as founded: item 0 adaptive, each its own maximum, each with a hint at variable 0 that
 * counts an attempt at an odd sum of the two. */
const founded = (p: number, item: number) => ({
	adaptive: item === 0,
	max: p * 10 + item,
	counts: (p + item) % 2 === 1
})

/**
 * One transaction of a case:
 *
 * - `publish`: package `p` founded, its items and their hints, where no transaction founded it before; none where one did;
 * - `answer`: an attempt of learner `child` at an item of package `p`, numbered past the learner's last there, with its
 *   hint's variable `value` and a note of the same number, the package founded in the same transaction where none
 *   founded it before;
 * - `revise`: a data step over a founded package's item, its adaptivity flipped and its maximum raised, and its hint
 *   removed, as a migration revises content (test/support/data-step.ts); none where no transaction founded it.
 */
export type Step =
	| { readonly kind: "publish"; readonly package: number }
	| {
			readonly kind: "answer"
			readonly child: number
			readonly package: number
			readonly item: number
			readonly value: boolean
	  }
	| { readonly kind: "revise"; readonly package: number; readonly item: number }

const stepGen: Gen<Step> = (s) => {
	const p = s.draw(int(1, 2))
	switch (s.draw(element(["publish", "answer", "revise"] as const))) {
		case "publish":
			return { kind: "publish", package: p }
		case "answer":
			return {
				kind: "answer",
				child: s.draw(int(1, 2)),
				package: p,
				item: s.draw(element(items)),
				value: s.draw(boolean)
			}
		case "revise":
			return { kind: "revise", package: p, item: s.draw(element(items)) }
	}
}

/** A case: its transactions, each committed before the next. */
export interface ExactCase {
	readonly steps: ReadonlyArray<Step>
}

export const exactCase: Gen<ExactCase> = (s) => ({
	steps: s.draw(array(stepGen, { min: 1, max: 8 }))
})

/** What a case reached: each kind of transaction, and a revision of content an attempt names. */
export type ExactFeature =
	| "published a package"
	| "answered a founded package's item"
	| "answered an item in its package's founding"
	| "revised content in a data step"
	| "revised content an attempt names"

/** The host's model of the installation: each founded package's items, each attempt with its hint's value. */
interface Model {
	readonly items: Map<string, { adaptive: boolean; max: number; counts: boolean | undefined }>
	readonly attempts: Array<{
		readonly child: number
		readonly package: number
		readonly item: number
		readonly n: number
		readonly value: boolean
	}>
}

/** The key of an item in the model. */
const itemKey = (p: number, item: number): string => `${p}/${item}`

/** The SQL of package `p`'s founding, its rows as `founded` states them. */
const publishSql = (installed: Installed, p: number): ReadonlyArray<string> => {
	const names = namesOf(installed)
	return [
		`INSERT INTO ${names.table(Package)} (package) VALUES (${p})`,
		...Arr.flatMap(items, (item) => {
			const f = founded(p, item)
			return [
				`INSERT INTO ${names.table(Item)} (package, item, adaptive, max) VALUES (${p}, ${item}, ${f.adaptive}, ${f.max})`,
				`INSERT INTO ${names.table(Hint)} (package, item, variable, counts) VALUES (${p}, ${item}, 0, ${f.counts})`
			]
		})
	]
}

/** Each stored relation's rows as the model states them, each row its record text, sorted: Credit's, Open's and
 * Counted's, Scored's, Tried's and Noted's definitions read over the model, a note at each attempt. */
const modelRows = (m: Model) => {
	const at = (a: Model["attempts"][number]) => {
		const it = m.items.get(itemKey(a.package, a.item))
		if (it === undefined) {
			throw new Error(`an attempt at ${a.package}/${a.item}, which no founding wrote`)
		}
		return it
	}
	const sorted = (rows: ReadonlyArray<string>) => Arr.sort(rows, Order.String)
	return {
		Credit: sorted(
			Arr.map(m.attempts, (a) => `(${a.child},${a.package},${a.item},${a.n},${at(a).max})`)
		),
		Open: sorted(
			Arr.flatMap(m.attempts, (a) =>
				at(a).adaptive ? [] : [`(${a.child},${a.package},${a.item},${a.n})`]
			)
		),
		Counted: sorted(
			Arr.flatMap(m.attempts, (a) =>
				at(a).counts === false && a.value ? [] : [`(${a.child},${a.package},${a.item},${a.n})`]
			)
		),
		Scored: sorted(
			Arr.flatMap(m.attempts, (a) =>
				at(a).max >= 0 ? [`(${a.child},${a.package},${a.item},${a.n},${at(a).max})`] : []
			)
		),
		Tried: sorted(
			Arr.map(
				Arr.dedupe(Arr.map(m.attempts, (a) => `${a.child}/${a.package}/${a.item}`)),
				(group) => {
					const tried = Arr.filter(m.attempts, (a) => `${a.child}/${a.package}/${a.item}` === group)
					const [first] = tried
					if (first === undefined) {
						throw new Error(`a group ${group} of no attempt`)
					}
					return `(${first.child},${first.package},${first.item},${at(first).max},${tried.length})`
				}
			)
		),
		Noted: sorted(
			Arr.map(m.attempts, (a) => `(${a.child},${a.package},${a.item},${a.n},${at(a).max})`)
		)
	}
}

/** Each stored relation's table's rows, each its record text, sorted. */
const storedRows = (installed: Installed, session: RawSession) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const read = (sql: string) =>
			Effect.map(session.values(sql, []), (rows) =>
				Arr.sort(
					Arr.map(rows, (row) => String(row[0])),
					Order.String
				)
			)
		return {
			Credit: yield* read(
				`SELECT ROW(child, package, item, n, max)::text FROM ${names.table(Credit)}`
			),
			Open: yield* read(`SELECT ROW(child, package, item, n)::text FROM ${names.table(Open)}`),
			Counted: yield* read(
				`SELECT ROW(child, package, item, n)::text FROM ${names.table(Counted)}`
			),
			Scored: yield* read(
				`SELECT ROW(child, package, item, n, max)::text FROM ${names.table(Scored)}`
			),
			Tried: yield* read(
				`SELECT ROW(child, package, item, max, tries)::text FROM ${names.table(Tried)}`
			),
			Noted: yield* read(
				`SELECT ROW(child, package, item, n, max)::text FROM ${names.table(Noted)}`
			)
		}
	})

/**
 * One case on a fresh clone, as the owner's direct SQL: each step committed as one transaction, the rule judge running
 * at its COMMIT, and after each, every stored relation's table holding exactly the rows the model's definitions give.
 * A founding writes every row of its package; an answer at an unfounded package founds it in its own transaction; a
 * revision lifts the content's guards as a migration's data step does and changes the item and removes its hint, which
 * the stored relations read by reference.
 */
export const runExact = (
	installed: Installed,
	session: RawSession,
	c: ExactCase,
	reached: Case<ExactFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		yield* standUpJudge(session, installed.installation)
		const m: Model = { items: new Map(), attempts: [] }
		const isFounded = (p: number) => m.items.has(itemKey(p, 0))
		const found = (p: number) => {
			for (const item of items) {
				const f = founded(p, item)
				m.items.set(itemKey(p, item), { adaptive: f.adaptive, max: f.max, counts: f.counts })
			}
		}
		for (const [at, step] of c.steps.entries()) {
			switch (step.kind) {
				case "publish": {
					if (isFounded(step.package)) {
						continue
					}
					yield* committedJudged(session, publishSql(installed, step.package))
					found(step.package)
					reached.note("published a package")
					break
				}
				case "answer": {
					const n =
						Arr.reduce(m.attempts, 0, (most, a) =>
							a.child === step.child && a.package === step.package && a.item === step.item
								? Math.max(most, a.n)
								: most
						) + 1
					const publish = isFounded(step.package) ? [] : publishSql(installed, step.package)
					yield* committedJudged(session, [
						...publish,
						`INSERT INTO ${names.table(Attempt)} (child, package, item, n) VALUES (${step.child}, ${step.package}, ${step.item}, ${n})`,
						`INSERT INTO ${names.table(Snapshot)} (child, package, item, n, variable, value) VALUES (${step.child}, ${step.package}, ${step.item}, ${n}, 0, ${step.value})`,
						`INSERT INTO ${names.table(Note)} (child, package, item, n) VALUES (${step.child}, ${step.package}, ${step.item}, ${n})`
					])
					if (publish.length > 0) {
						found(step.package)
						reached.note("answered an item in its package's founding")
					} else {
						reached.note("answered a founded package's item")
					}
					m.attempts.push({
						child: step.child,
						package: step.package,
						item: step.item,
						n,
						value: step.value
					})
					break
				}
				case "revise": {
					const it = m.items.get(itemKey(step.package, step.item))
					if (it === undefined) {
						continue
					}
					const where = `package = ${step.package} AND item = ${step.item}`
					yield* committedJudged(
						session,
						asDataStep(installed.installation, [
							`UPDATE ${names.table(Item)} SET adaptive = NOT adaptive, max = max + 1 WHERE ${where}`,
							`DELETE FROM ${names.table(Hint)} WHERE ${where}`
						])
					)
					m.items.set(itemKey(step.package, step.item), {
						adaptive: !it.adaptive,
						max: it.max + 1,
						counts: undefined
					})
					reached.note("revised content in a data step")
					if (Arr.some(m.attempts, (a) => a.package === step.package && a.item === step.item)) {
						reached.note("revised content an attempt names")
					}
					break
				}
			}
			const stored = yield* storedRows(installed, session)
			assert.deepEqual(
				stored,
				modelRows(m),
				`after step ${at} of ${Formatter.format(c.steps)}, each stored relation holds its definition's rows over the model`
			)
		}
	})

/**
 * A bound case: package 1's item 1, whose hint counts no attempt, attempted `few` times by learner 1 before the first
 * measure, beside a background of `background` packages founded and as many other learners' attempts at package 1's
 * item 0, none for tables of a few rows, a page each, 2,048 for tables a dozen pages and more; then `more` packages
 * founded, `more` attempts of learner 1 at another package, and `more` other learners' attempts at package 1's item 1,
 * before the second.
 */
export interface BoundCase {
	readonly background: 0 | 2048
	readonly few: 1 | 4
	readonly more: 16 | 64
}

export const boundGen: Gen<BoundCase> = (s) => ({
	background: s.draw(element([0, 2048] as const)),
	few: s.draw(element([1, 4] as const)),
	more: s.draw(element([16, 64] as const))
})

export type BoundFeature =
	| "Credit's upkeep ran"
	| "Open's upkeep ran"
	| "Counted's upkeep ran"
	| "Tried's upkeep ran"
	| "tables of a page"
	| "tables of many pages"

/** The SQL that founds packages `from` to `to`, each with its two items and their hints, in one statement each; none
 * where `to` is below `from`. */
const packagesSql = (installed: Installed, from: number, to: number): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const series = `FROM generate_series(${from}, ${to}) AS g(p)`
	return [
		`INSERT INTO ${names.table(Package)} (package) SELECT p ${series}`,
		`INSERT INTO ${names.table(Item)} (package, item, adaptive, max) SELECT p, i, i = 0, p * 10 + i ${series}, generate_series(0, 1) AS h(i)`,
		`INSERT INTO ${names.table(Hint)} (package, item, variable, counts) SELECT p, i, 0, (p + i) % 2 = 1 ${series}, generate_series(0, 1) AS h(i)`
	]
}

/** The SQL of the attempts of each learner of `children`, at each package of `p`, numbered `n`, at item `item`, each with
 * its hint's variable false, each range inclusive, none where a range is empty. */
const attemptsSql = (
	installed: Installed,
	children: readonly [number, number],
	p: readonly [number, number],
	item: number,
	n: readonly [number, number]
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const series = `FROM generate_series(${children[0]}, ${children[1]}) AS c(child), generate_series(${p[0]}, ${p[1]}) AS q(p), generate_series(${n[0]}, ${n[1]}) AS k(n)`
	return [
		`INSERT INTO ${names.table(Attempt)} (child, package, item, n) SELECT child, p, ${item}, n ${series}`,
		`INSERT INTO ${names.table(Snapshot)} (child, package, item, n, variable, value) SELECT child, p, ${item}, n, 0, false ${series}`
	]
}

/**
 * The judge's work at COMMIT of one answer, learner 1's attempt `n` at package 1's item 1, measured on `session` in a
 * transaction rolled back, before the judge reads its deltas (test/support/judge.ts judgeRun): each statement it runs
 * over them, each stored relation's upkeep's, as phase A runs them, explained with ANALYZE and BUFFERS.
 */
const answerWork = (installed: Installed, session: RawSession, n: number) =>
	Effect.gen(function* () {
		yield* session.begin
		const work = yield* Effect.onError(
			Effect.gen(function* () {
				for (const sql of attemptsSql(installed, [1, 1], [1, 1], 1, [n, n])) {
					yield* session.query(sql, [])
				}
				return yield* judgeRun(
					(sql) => session.values(sql, []),
					installed.installation,
					judgeStatementsOf(installed.installation)
				)
			}),
			() => Effect.ignore(session.rollback)
		)
		yield* session.rollback
		return work
	})

/** A statement of the judge, named: an upkeep's write by its relation, a rule's test by its kind. */
const named = (statement: JudgeStatement): string => {
	switch (statement.kind) {
		case "upkeep":
			return `the ${statement.statement.kind} of ${statement.relation}'s upkeep`
		case "rule":
			return "a rule's test"
	}
}

/** Each statement measured, named, with its work (test/support/judge.ts scannedWork). */
const measured = (plans: ReadonlyArray<JudgePlan<JudgeStatement>>) =>
	Arr.map(plans, (p) => ({
		statement: named(p.statement),
		rows: scannedWork(p.plan)
	}))

/**
 * One bound case on a fresh clone, in one session: the background and learner 1's `few` attempts committed, the judge's
 * work at a fresh answer's COMMIT measured (`answerWork`); then `more` packages, `more` attempts of learner 1 at another
 * package and `more` other learners' attempts at package 1 committed, and the work measured again, each statement under
 * its routine's own advice (test/support/judge.ts judgeRun). Its work is the same both times: each upkeep re-derives the one attempt the answer wrote, reading it, its item and its hint by their keys, never
 * another package's content, another attempt of the learner, or another learner's, and its DELETE reads its table's
 * rows at that attempt by a lookup of their own.
 */
export const runBound = (
	installed: Installed,
	session: RawSession,
	d: BoundCase,
	c: Case<BoundFeature>
) =>
	Effect.gen(function* () {
		yield* standUpJudge(session, installed.installation)
		const first = d.background + 1
		yield* committedJudged(session, [
			...packagesSql(installed, 1, first),
			...(d.background > 0 ? attemptsSql(installed, [2, first], [1, 1], 0, [1, 1]) : []),
			...attemptsSql(installed, [1, 1], [1, 1], 1, [1, d.few])
		])
		const fewPlans = yield* answerWork(installed, session, d.few + 1)
		const few = measured(fewPlans)
		yield* committedJudged(session, [
			...packagesSql(installed, first + 1, first + d.more),
			...attemptsSql(installed, [1, 1], [2, 2], 1, [1, d.more]),
			...attemptsSql(installed, [first + 1, first + d.more], [1, 1], 1, [1, 1])
		])
		const manyPlans = yield* answerWork(installed, session, d.few + 1)
		const many = measured(manyPlans)
		assert.deepEqual(
			many,
			few,
			`${Formatter.format(d)}: each statement the judge runs at an answer's COMMIT does the same work beside ${first} packages and learner 1's ${d.few} attempts and beside ${first + d.more} and ${d.few + d.more}`
		)
		c.note(d.background === 0 ? "tables of a page" : "tables of many pages")
		for (const [relation, feature] of [
			["Credit", "Credit's upkeep ran"],
			["Open", "Open's upkeep ran"],
			["Counted", "Counted's upkeep ran"],
			["Tried", "Tried's upkeep ran"]
		] as const) {
			if (Arr.some(few, (m) => m.statement === `the insert of ${relation}'s upkeep`)) {
				c.note(feature)
			}
		}
	})
