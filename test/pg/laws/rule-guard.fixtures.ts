/** What the property of rule-guard.test.ts reads: its schema and template, its space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import { baselineRuleChecks } from "#compiler/deploy/snapshot/violation.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, contained, derived, on, relation, schema } from "#compiler/public/schema.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { standUpJudge } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { refusalOf } from "#test/support/substrate.ts"
import { type PgErrorFields, pgErrorFields } from "#test/support/substrate/errors.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, type SubstrateShape } from "#test/support/substrate/substrate.ts"

/**
 * A learner's values beside the content they read, in small (qti's Human within maximum): Node, a package's nodes keyed
 * by the package first; Bound, a package's bound of each kind, keyed by the package first, which only the rule's
 * content side reads; Value, a learner's score at a node of a package, keyed by the learner first. Within holds each
 * value at most the bound of the kind of the node's child, a check over a definition joining Value to the content, so
 * the judge probes a write of Node from the content side, every row of it reading Value at the node's package: the
 * probe's guard (analysis/theory/query.ts probeGuard).
 */
const Node = relation(
	"Node",
	{ pkg: pg.integer, start: pg.integer, parent: pg.integer, kind: pg.integer },
	["pkg", "start"]
)
const Bound = relation("Bound", { pkg: pg.integer, kind: pg.integer, bound: pg.integer }, [
	"pkg",
	"kind"
])
const Value = relation(
	"Value",
	{ child: pg.integer, pkg: pg.integer, start: pg.integer, score: pg.integer },
	["child", "pkg", "start"]
)
const Wire = relation(
	"Wire",
	{ pkg: pg.integer, start: pg.integer, parent: pg.integer, kind: pg.integer },
	["pkg", "start"]
)
const Mark = relation(
	"Mark",
	{ child: pg.integer, pkg: pg.integer, start: pg.integer, score: pg.integer },
	["child", "pkg", "start"]
)
/**
 * qti's Servable in small: Item, a package's item documents; Doc, a document's parts keyed by the package first, a part
 * of kind 1 naming a template by `ref`, one of kind 2 publishing a template under its `ref` from ANY package; Sess, a
 * learner's sessions of an item, keyed by the learner first. An item is Ready unless a part of kind 1 names a template
 * no part of kind 2 publishes; every session is of a Ready item. A write of Doc reaches Ready two ways: its kind-1
 * part under one negation, at the item's own package and document, and its kind-2 part under two, at the template's own
 * package, any package. Adding a part of kind 2 only makes items Ready, so on the added side only the kind-1 way yields
 * a row of the probe and the guard reads Sess at the written part's package and document; removing one can make an item
 * of another package unready, so on the removed side no guard stands.
 */
const Item = relation("Item", { pkg: pg.integer, item: pg.integer }, ["pkg", "item"])
const Doc = relation(
	"Doc",
	{ pkg: pg.integer, item: pg.integer, kind: pg.integer, ref: pg.integer },
	["pkg", "item", "kind"]
)
const Sess = relation("Sess", { child: pg.integer, pkg: pg.integer, item: pg.integer }, [
	"child",
	"pkg",
	"item"
])
const Base = schema("rule_guard", [Node, Bound, Value, Wire, Mark, Item, Doc, Sess], [])

/** Each node of kind 10 with the bound of its child's kind. */
const bounded = query(Base).rule((r) => {
	const { pkg, start } = v(Node, "n")
	const { kind } = v(Node, "child")
	const { bound } = v(Bound, "b")
	return r
		.match(Node, { pkg, start, kind: 10 })
		.match(Node, { pkg, parent: start, kind })
		.match(Bound, { pkg, kind, bound })
		.find({ pkg, start, bound })
})
const Scored = derived(
	"Scored",
	query(Base).rule((r) => {
		const { child, pkg, start, score } = v(Value, "value")
		const { bound } = v(bounded, "node")
		return r
			.match(Value, { child, pkg, start, score })
			.match(bounded, { pkg, start, bound })
			.find({ bound, child, pkg, score, start })
	})
)
/**
 * The same shape read past the unit: Linked joins a learner's Mark of a package to that package's node of kind 10 and
 * to a node of kind 20 of ANY package whose parent is that node's start, so a write of the second node reaches the arm
 * through a match of Wire that binds none of the arm's package: the written row's package is not the Mark's. Capped holds
 * each mark at most the far node's start. No guard may skip its probe: a Mark of another package than the written
 * node's breaks it.
 */
const Linked = derived(
	"Linked",
	query(Base).rule((r) => {
		const { child, pkg, start, score } = v(Mark, "mark")
		const { pkg: other, start: far } = v(Wire, "far")
		return r
			.match(Mark, { child, pkg, start, score })
			.match(Wire, { pkg, start, kind: 10 })
			.match(Wire, { pkg: other, start: far, parent: start, kind: 20 })
			.find({ child, far, pkg, score, start })
	})
)
/** The templates some part of kind 2 publishes, from any package. */
const published = query(Base).rule((r) => {
	const { pkg: source, item: template, ref } = v(Doc, "published")
	return r.match(Doc, { pkg: source, item: template, kind: 2, ref }).find({ ref })
})
/** The items a part of kind 1 of names a template no part of kind 2 publishes. */
const unresolved = query(Base).rule((r) => {
	const { pkg, item, ref } = v(Doc, "part")
	return r
		.match(Doc, { pkg, item, kind: 1, ref })
		.where(r.not(published, { ref }))
		.find({ pkg, item })
})
const Ready = derived(
	"Ready",
	query(Base).rule((r) => {
		const { pkg, item } = v(Item, "item")
		return r.match(Item, { pkg, item }).where(r.not(unresolved, { pkg, item })).find({ pkg, item })
	})
)
const guardSchema = schema.extend(
	[Base],
	"rule_guard_1",
	[Scored, Linked, Ready],
	[
		check("Within", Scored, (s) => s.le(s.score, s.bound)),
		check("Capped", Linked, (l) => l.le(l.score, l.far)),
		contained(on(Sess, "pkg", "item"), on(Ready, "pkg", "item"))
	]
)

export const guardTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "rule guard",
	content: { schema: guardSchema.name, logins: [] },
	versions: [{ schema: guardSchema, logins: [], declarations: noDeclarations }],
	options: {
		label: "rule_guard",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/**
 * A case: the learner's values a transaction writes of package 1's content holds beside it, as Value rows the judge's
 * captures do not see, so only the probe of the written nodes can judge them: none; one of package 2 alone, over its
 * bound; one of package 1 within its bound; one of package 1 over it.
 */
export type Learner =
	| "none"
	| "another package's only"
	| "within its bound"
	| "over its bound"
	| "another package's, read past the unit"
	| "an unresolved part, no session"
	| "an unresolved part beside a session"
	| "another package's template withdrawn beside a session"

export const learnerGen: Gen<Learner> = (s) =>
	s.draw(
		element<Learner>([
			"none",
			"another package's only",
			"within its bound",
			"over its bound",
			"another package's, read past the unit",
			"an unresolved part, no session",
			"an unresolved part beside a session",
			"another package's template withdrawn beside a session"
		])
	)

export type GuardFeature =
	| "skipped where no value of the package stands"
	| "skipped where another package's value stands"
	| "run where a lawful value stands"
	| "refused where a value of the same transaction breaks it"
	| "refused where another package's mark breaks an arm read past the unit"
	| "skipped on the added side where no session of the document stands"
	| "refused on the added side by a session of the document"
	| "refused on the removed side, unguarded, by another package's withdrawn template"

/**
 * One case in its one transaction, which the case's end rolls back: Bound's row of package 1 and the case's Value rows
 * loaded with the captures off, so no delta holds them and no block of the judge reads them as written; then, through
 * the captures, package 1's node of kind 10 and its child, whose rows Node's delta holds; then the judge
 * (SET CONSTRAINTS ALL IMMEDIATE). Of the judge's statements only the probe of the written nodes reads Node, each of
 * its rows looking up the written node's parent or child first, before any Value row, so the scans of Node the judge
 * adds to the transaction's (pg_stat_xact_user_tables, before and after it runs) say whether the probe ran: none where
 * the guard found no Value row at package 1, some where it found one. A value over its bound, written in the same transaction, is refused (23514): the guard reads
 * Value as it stands.
 */
export const runGuard = (
	installed: Installed,
	connection: PgConnection,
	learner: Learner,
	c: Case<GuardFeature>
) =>
	Effect.andThen(
		standUpJudge(connection, installed.installation),
		learner === "another package's, read past the unit"
			? runCross(installed, connection, c)
			: learner === "an unresolved part, no session" ||
				  learner === "an unresolved part beside a session" ||
				  learner === "another package's template withdrawn beside a session"
				? runReady(installed, connection, learner, c)
				: runWithin(installed, connection, learner, c)
	)

/**
 * A case of Ready (`Item`, `Doc`, `Sess`), in its one transaction, every row but the written one loaded with the
 * captures off. On the added side, package 1's part of kind 1 naming template 9, which no part publishes, makes item 1
 * unready: with no session of it the judge accepts, its probe never run (the scans of Doc the judge adds are the
 * probe's lookup of the published templates); with a session of it the judge refuses it, the guard reading Sess at the
 * written part's package and document. On the removed side, package 2's part of kind 2 publishing template 9 is
 * deleted beside package 1's part naming it and a session of item 1: the item turns unready by a row of another
 * package, and the judge refuses it, no guard standing before that probe. Sess ⊆ Ready is a rule over a query, which no
 * foreign key holds, every row the case loads satisfying every other law: the judge raises it as 23503 under the
 * rule's own name, from its block over Doc's rows, which the case reads off the refusal.
 */
const runReady = (
	installed: Installed,
	connection: PgConnection,
	learner:
		| "an unresolved part, no session"
		| "an unresolved part beside a session"
		| "another package's template withdrawn beside a session",
	c: Case<GuardFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const item = names.table(Item)
		const doc = names.table(Doc)
		const sess = names.table(Sess)
		const i = (f: "pkg" | "item") => names.column(Item, f)
		const d = (f: "pkg" | "item" | "kind" | "ref") => names.column(Doc, f)
		const t = (f: "child" | "pkg" | "item") => names.column(Sess, f)
		const withdrawn = learner === "another package's template withdrawn beside a session"
		const loaded = [
			`ALTER TABLE ${item} DISABLE TRIGGER USER`,
			`INSERT INTO ${item} (${i("pkg")}, ${i("item")}) VALUES (1, 1)`,
			`ALTER TABLE ${item} ENABLE TRIGGER USER`,
			...(learner === "an unresolved part, no session"
				? []
				: [
						`ALTER TABLE ${sess} DISABLE TRIGGER USER`,
						`INSERT INTO ${sess} (${t("child")}, ${t("pkg")}, ${t("item")}) VALUES (7, 1, 1)`,
						`ALTER TABLE ${sess} ENABLE TRIGGER USER`
					]),
			...(withdrawn
				? [
						`ALTER TABLE ${doc} DISABLE TRIGGER USER`,
						`INSERT INTO ${doc} (${d("pkg")}, ${d("item")}, ${d("kind")}, ${d("ref")}) VALUES (1, 1, 1, 9), (2, 5, 2, 9)`,
						`ALTER TABLE ${doc} ENABLE TRIGGER USER`
					]
				: []),
			"SET CONSTRAINTS ALL DEFERRED",
			withdrawn
				? `DELETE FROM ${doc} WHERE ${d("pkg")} = 2 AND ${d("item")} = 5 AND ${d("kind")} = 2`
				: `INSERT INTO ${doc} (${d("pkg")}, ${d("item")}, ${d("kind")}, ${d("ref")}) VALUES (1, 1, 1, 9)`
		]
		for (const sql of loaded) {
			yield* connection.query(sql, [])
		}
		const scansOfDoc = `SELECT (coalesce(seq_scan, 0) + coalesce(idx_scan, 0))::text FROM pg_stat_xact_user_tables WHERE relid = '${doc}'::regclass`
		const [before] = yield* connection.queryValues(scansOfDoc, [])
		const [judged] = yield* connection.exchange([
			{ sql: "SET CONSTRAINTS ALL IMMEDIATE", params: [] }
		])
		const refusal = Result.isFailure(judged) ? pgErrorFields(judged.failure) : undefined
		const code = refusal?.code
		if (learner === "an unresolved part, no session") {
			assert.equal(code, undefined, `${Formatter.format(learner)}: the judge accepts it`)
			const [after] = yield* connection.queryValues(scansOfDoc, [])
			assert.equal(
				Number(after?.[0] ?? "0") - Number(before?.[0] ?? "0"),
				0,
				`${Formatter.format(learner)}: the guard skips the probe, the judge's one reader of Doc`
			)
			c.note("skipped on the added side where no session of the document stands")
			return
		}
		assert.equal(
			code,
			"23503",
			`${Formatter.format(learner)}: the judge refuses the unready item's session`
		)
		assert.ok(
			Str.startsWith("__rule_sess_in_ready")(String(refusal?.constraint)) &&
				Option.getOrUndefined(refusal?.table ?? Option.none()) === "doc",
			`${Formatter.format(learner)}: the refusal is the rule's own, raised by its block over Doc's rows, its containment of Sess in Ready (no foreign key holds it): ${String(refusal?.constraint)} on ${String(Option.getOrUndefined(refusal?.table ?? Option.none()))}`
		)
		c.note(
			withdrawn
				? "refused on the removed side, unguarded, by another package's withdrawn template"
				: "refused on the added side by a session of the document"
		)
	})

/**
 * The case read past the unit, in its one transaction: package 1's node of kind 10 and its Mark of 900 loaded with the
 * captures off, then, through the captures, package 2's node of kind 20 whose parent is that node's start, which joins
 * them into a fact of Linked whose mark passes the far node's start, 5. The judge refuses it (23514): Linked's arm
 * reaches the written Wire through a match that binds the Mark's package to nothing of the written row, so no guard
 * stands before its probe.
 */
const runCross = (installed: Installed, connection: PgConnection, c: Case<GuardFeature>) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const wire = names.table(Wire)
		const mark = names.table(Mark)
		const n = (f: "pkg" | "start" | "parent" | "kind") => names.column(Wire, f)
		const m = (f: "child" | "pkg" | "start" | "score") => names.column(Mark, f)
		for (const sql of [
			`ALTER TABLE ${wire} DISABLE TRIGGER USER`,
			`INSERT INTO ${wire} (${n("pkg")}, ${n("start")}, ${n("parent")}, ${n("kind")}) VALUES (1, 1, 0, 10)`,
			`ALTER TABLE ${wire} ENABLE TRIGGER USER`,
			`ALTER TABLE ${mark} DISABLE TRIGGER USER`,
			`INSERT INTO ${mark} (${m("child")}, ${m("pkg")}, ${m("start")}, ${m("score")}) VALUES (7, 1, 1, 900)`,
			`ALTER TABLE ${mark} ENABLE TRIGGER USER`,
			"SET CONSTRAINTS ALL DEFERRED",
			`INSERT INTO ${wire} (${n("pkg")}, ${n("start")}, ${n("parent")}, ${n("kind")}) VALUES (2, 5, 1, 20)`
		]) {
			yield* connection.query(sql, [])
		}
		const [judged] = yield* connection.exchange([
			{ sql: "SET CONSTRAINTS ALL IMMEDIATE", params: [] }
		])
		const code = Result.isFailure(judged) ? pgErrorFields(judged.failure)?.code : undefined
		assert.equal(
			code,
			"23514",
			"another package's mark joined through a node of package 2: the judge refuses the mark over the far node's start"
		)
		c.note("refused where another package's mark breaks an arm read past the unit")
	})

/** A case of the learner's values at package 1's content (`Learner`), the Within rule's. */
const runWithin = (
	installed: Installed,
	connection: PgConnection,
	learner: "none" | "another package's only" | "within its bound" | "over its bound",
	c: Case<GuardFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const node = names.table(Node)
		const bound = names.table(Bound)
		const value = names.table(Value)
		const n = (f: "pkg" | "start" | "parent" | "kind") => names.column(Node, f)
		const b = (f: "pkg" | "kind" | "bound") => names.column(Bound, f)
		const w = (f: "child" | "pkg" | "start" | "score") => names.column(Value, f)
		const values: ReadonlyArray<{
			readonly child: number
			readonly pkg: number
			readonly start: number
			readonly score: number
		}> = {
			none: [],
			"another package's only": [{ child: 7, pkg: 2, start: 1, score: 900 }],
			"within its bound": [{ child: 7, pkg: 1, start: 1, score: 40 }],
			"over its bound": [{ child: 7, pkg: 1, start: 1, score: 900 }]
		}[learner]
		const loaded = [
			`ALTER TABLE ${bound} DISABLE TRIGGER USER`,
			`INSERT INTO ${bound} (${b("pkg")}, ${b("kind")}, ${b("bound")}) VALUES (1, 5, 50)`,
			`ALTER TABLE ${bound} ENABLE TRIGGER USER`,
			`ALTER TABLE ${value} DISABLE TRIGGER USER`,
			...Arr.map(
				values,
				(row) =>
					`INSERT INTO ${value} (${w("child")}, ${w("pkg")}, ${w("start")}, ${w("score")}) VALUES (${row.child}, ${row.pkg}, ${row.start}, ${row.score})`
			),
			`ALTER TABLE ${value} ENABLE TRIGGER USER`,
			"SET CONSTRAINTS ALL DEFERRED",
			`INSERT INTO ${node} (${n("pkg")}, ${n("start")}, ${n("parent")}, ${n("kind")}) VALUES (1, 1, 0, 10), (1, 2, 1, 5)`
		]
		for (const sql of loaded) {
			yield* connection.query(sql, [])
		}
		const scansOfNode = `SELECT (coalesce(seq_scan, 0) + coalesce(idx_scan, 0))::text FROM pg_stat_xact_user_tables WHERE relid = '${node}'::regclass`
		const [before] = yield* connection.queryValues(scansOfNode, [])
		const [judged] = yield* connection.exchange([
			{ sql: "SET CONSTRAINTS ALL IMMEDIATE", params: [] }
		])
		const code = Result.isFailure(judged) ? pgErrorFields(judged.failure)?.code : undefined
		if (learner === "over its bound") {
			assert.equal(
				code,
				"23514",
				`${Formatter.format(learner)}: the judge refuses the value over its bound`
			)
			c.note("refused where a value of the same transaction breaks it")
			return
		}
		assert.equal(
			code,
			undefined,
			`${Formatter.format(learner)}: the judge accepts the lawful state`
		)
		const [after] = yield* connection.queryValues(scansOfNode, [])
		const read = Number(after?.[0] ?? "0") - Number(before?.[0] ?? "0")
		if (learner === "within its bound") {
			assert.ok(
				read > 0,
				`${Formatter.format(learner)}: the probe runs, reading Bound (${read} scans)`
			)
			c.note("run where a lawful value stands")
			return
		}
		assert.equal(
			read,
			0,
			`${Formatter.format(learner)}: the guard skips the probe, which reads Bound`
		)
		c.note(
			learner === "none"
				? "skipped where no value of the package stands"
				: "skipped where another package's value stands"
		)
	})

/**
 * A race at item 2 of package 1, Ready's: the publish, a part of kind 1 of that item naming template 9, which no part
 * publishes, so the item turns unready; the learner's write, a session of that item. `first` commits first; `standing`,
 * a session of the item committed before the race, which the publish's guard finds as it stands; `own`, the publish's
 * own session of the item written in its transaction after its part, which its guard reads as it stands at COMMIT.
 */
export interface Race {
	readonly first: "publish" | "learner"
	readonly standing: boolean
	readonly own: boolean
}

export const raceGen: Gen<Race> = (s) => ({
	first: s.draw(element<Race["first"]>(["publish", "learner"])),
	standing: s.draw(boolean),
	own: s.draw(boolean)
})

export type RaceFeature =
	| "the publish refused beside a standing session"
	| "the publish refused by its own later session"
	| "a race refused by a serialization failure"

/** The SQLSTATE of a serialization failure. */
const serializationFailure = "40001"

/**
 * One race on a fresh database of guardSchema's installation (Substrate.fresh guardTemplate), its tables empty: item 2
 * of package 1, and a standing session where the case has one, committed; then the publish and the learner's write on two sessions at SERIALIZABLE, each taking its
 * snapshot before either writes, each writing, then each committing, `first` first, a writer meeting the other's row lock
 * giving up at once. Whichever PostgreSQL refuses, by the rule at COMMIT (23503) or by a serialization failure (40001),
 * the state committed keeps Sess in Ready: its whole check, read after both end, finds nothing. The publish's guard reads
 * Sess at the written part's package and item as it stands at COMMIT, so a standing session or its own later one runs
 * the probe, which refuses the publish; where the learner's session is the other transaction's, uncommitted at the
 * publish's guard, the guard finds none and skips the probe, and the guard's read of Sess at that unit, which the
 * learner's insert writes into, and the learner's probe's read of Doc at that item, which the publish writes into, are
 * the two read-write dependencies PostgreSQL's SSI refuses one transaction of.
 */
export const runRace = (
	installed: Installed,
	substrate: SubstrateShape,
	race: Race,
	note: (f: RaceFeature) => void
) =>
	Effect.gen(function* () {
		const installation = installed.installation
		const names = namesOf(installed)
		const ready = Arr.filter(baselineRuleChecks(installation), (check) =>
			Arr.some(
				installation.laws.rules,
				(rule) => rule.law.id === check.law && rule.rule.kind === "contained"
			)
		)
		assert.ok(ready.length > 0, "Sess in Ready's whole check")
		const broken = `SELECT ${Arr.join(
			Arr.map(ready, (check) => `EXISTS (${printStatement(check.query)})`),
			" OR "
		)}`
		const item = names.table(Item)
		const doc = names.table(Doc)
		const sess = names.table(Sess)
		const i = (f: "pkg" | "item") => names.column(Item, f)
		const d = (f: "pkg" | "item" | "kind" | "ref") => names.column(Doc, f)
		const t = (f: "child" | "pkg" | "item") => names.column(Sess, f)
		const publisher = yield* substrate.session({
			...ownerSession(),
			label: "rule guard race publish"
		})
		const learner = yield* substrate.session({
			...ownerSession(),
			label: "rule guard race learner"
		})
		yield* standUpJudge(publisher, installation)
		yield* standUpJudge(learner, installation)
		yield* publisher.begin
		yield* publisher.query(`INSERT INTO ${item} (${i("pkg")}, ${i("item")}) VALUES (1, 2)`, [])
		if (race.standing) {
			yield* publisher.query(
				`INSERT INTO ${sess} (${t("child")}, ${t("pkg")}, ${t("item")}) VALUES (6, 1, 2)`,
				[]
			)
		}
		yield* publisher.commit
		const opening = ["SET LOCAL lock_timeout = '200ms'", "SELECT 1"]
		yield* publisher.begin
		yield* learner.begin
		for (const sql of opening) {
			yield* publisher.query(sql, [])
			yield* learner.query(sql, [])
		}
		const run = (session: RawSession, statements: ReadonlyArray<string>) =>
			Effect.gen(function* () {
				for (const sql of statements) {
					const refused = yield* refusalOf(session.query(sql, []))
					if (Option.isSome(refused)) {
						return refused
					}
				}
				return Option.none()
			})
		const published = yield* run(publisher, [
			`INSERT INTO ${doc} (${d("pkg")}, ${d("item")}, ${d("kind")}, ${d("ref")}) VALUES (1, 2, 1, 9)`,
			...(race.own
				? [`INSERT INTO ${sess} (${t("child")}, ${t("pkg")}, ${t("item")}) VALUES (8, 1, 2)`]
				: [])
		])
		const wrote = yield* run(learner, [
			`INSERT INTO ${sess} (${t("child")}, ${t("pkg")}, ${t("item")}) VALUES (7, 1, 2)`
		])
		const end = (session: RawSession, written: Option.Option<PgErrorFields>) =>
			Option.isSome(written) ? Effect.as(session.rollback, written) : refusalOf(session.commit)
		const [endedP, endedL] =
			race.first === "publish"
				? [yield* end(publisher, published), yield* end(learner, wrote)]
				: yield* Effect.map(
						Effect.zip(end(learner, wrote), end(publisher, published)),
						([l, p]) => [p, l] as const
					)
		yield* publisher.begin
		const found = yield* publisher.values(broken, [])
		yield* publisher.rollback
		assert.equal(
			found[0]?.[0],
			false,
			`${Formatter.format(race)}: the publish and the learner's write committed a state Sess in Ready's whole check finds broken`
		)
		const refusals = Arr.getSomes([endedP, endedL])
		assert.ok(
			Arr.every(refusals, (f) => f.code === "23503" || f.code === serializationFailure),
			`${Formatter.format(race)}: each refusal is the rule's or a serialization failure: ${Formatter.format(Arr.map(refusals, (f) => f.code))}`
		)
		if (race.standing && Option.isSome(endedP) && endedP.value.code === "23503") {
			note("the publish refused beside a standing session")
		}
		if (race.own && Option.isSome(endedP) && endedP.value.code === "23503") {
			note("the publish refused by its own later session")
		}
		if (!race.standing && !race.own && Arr.some(refusals, (f) => f.code === serializationFailure)) {
			note("a race refused by a serialization failure")
		}
	})
