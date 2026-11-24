/** What the property of union-chain.test.ts reads: its templates, its space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int, subset } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { baselineRuleChecks, lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { foundQueryOf, judgedStatementsOf, raisedRule, standUpJudge } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { refusalOf } from "#test/support/substrate.ts"
import { Node, type Unions, unionSchemaOf } from "#test/unit/physical/judge-size.fixtures.ts"

/** The chains installed: one to four levels of unions of two rules, each rule reading the level below once or twice. */
const chains = {
	"once 1": { form: "chain", reads: 1, depth: 1 },
	"once 2": { form: "chain", reads: 1, depth: 2 },
	"once 3": { form: "chain", reads: 1, depth: 3 },
	"once 4": { form: "chain", reads: 1, depth: 4 },
	"twice 1": { form: "chain", reads: 2, depth: 1 },
	"twice 2": { form: "chain", reads: 2, depth: 2 },
	"twice 3": { form: "chain", reads: 2, depth: 3 },
	"twice 4": { form: "chain", reads: 2, depth: 4 }
} as const satisfies Readonly<Record<string, Unions>>

export type ChainKey = keyof typeof chains

const chainKeys = [
	"once 1",
	"once 2",
	"once 3",
	"once 4",
	"twice 1",
	"twice 2",
	"twice 3",
	"twice 4"
] as const satisfies ReadonlyArray<ChainKey>

const templateOf = (key: ChainKey) => {
	const chain = chains[key]
	const value = unionSchemaOf(chain)
	const label = `${chain.reads === 1 ? "once" : "twice"}_${chain.depth}`
	return migratedTemplate({
		declaredIn: import.meta,
		name: `union chain ${key}`,
		content: { schema: value.name, logins: [] },
		versions: [{ schema: value, logins: [], declarations: noDeclarations }],
		options: {
			label: `union_chain_${label}`,
			extensions: [],
			compile: compileInstallation,
			ambient: ordinarySession,
			review: noPlaceholders
		}
	})
}

/** Each chain installed by its migration, its judge among it. */
export const chainTemplates = Rec.map(chains, (_, key) => templateOf(key))

/** A node: its document, its start, its parent's start and its kind. */
interface NodeRow {
	readonly doc: number
	readonly start: number
	readonly parent: number
	readonly kind: number
}

/** A case: its chain, and the nodes of two documents written in two parts, the judge run after each. */
export interface ChainCase {
	readonly chain: ChainKey
	readonly first: ReadonlyArray<NodeRow>
	readonly second: ReadonlyArray<NodeRow>
}

const keys = Arr.flatMap([1, 2], (doc) => Arr.map([1, 2, 3, 4], (start) => ({ doc, start })))

/**
 * A drawn state: up to six of two documents' eight (doc, start) places, each node's parent one of its document's
 * starts or 0, none, and its kind 0, 1 or 101, the one kind the check refuses, each node written in the first part or
 * the second.
 */
export const chainCaseGen: Gen<ChainCase> = (s) => {
	const nodes = Arr.map(s.draw(subset(keys, { min: 0, max: 6 })), (key) => ({
		...key,
		parent: s.draw(int(0, 4)),
		kind: s.draw(element([0, 1, 101] as const)),
		first: s.draw(int(0, 1)) === 1
	}))
	const row = (n: (typeof nodes)[number]): NodeRow => ({
		doc: n.doc,
		start: n.start,
		parent: n.parent,
		kind: n.kind
	})
	return {
		chain: s.draw(element(chainKeys)),
		first: Arr.flatMap(nodes, (n) => (n.first ? [row(n)] : [])),
		second: Arr.flatMap(nodes, (n) => (n.first ? [] : [row(n)]))
	}
}

export type ChainFeature =
	| "a chain one deep"
	| "a chain two deep"
	| "a chain three deep"
	| "a chain four deep"
	| "each rule reading the level below twice"
	| "refused by the judge"
	| "accepted by the judge"
	| "refused over the units of a second part"

export const chainFeatures: readonly [ChainFeature, ...Array<ChainFeature>] = [
	"a chain one deep",
	"a chain two deep",
	"a chain three deep",
	"a chain four deep",
	"each rule reading the level below twice",
	"refused by the judge",
	"accepted by the judge",
	"refused over the units of a second part"
]

const depthFeature = {
	1: "a chain one deep",
	2: "a chain two deep",
	3: "a chain three deep",
	4: "a chain four deep"
} as const satisfies Readonly<Record<1 | 2 | 3 | 4, ChainFeature>>

/** The INSERT of `rows` into Node, none where there are none. */
const written = (installed: Installed, rows: ReadonlyArray<NodeRow>): ReadonlyArray<string> => {
	if (rows.length === 0) {
		return []
	}
	const names = namesOf(installed)
	const fields = ["doc", "start", "parent", "kind"] as const
	const columns = Arr.join(
		Arr.map(fields, (f) => quoteIdent(names.columnIdent(Node, f))),
		", "
	)
	const values = Arr.join(
		Arr.map(
			rows,
			(row) =>
				`(${Arr.join(
					Arr.map(fields, (f) => String(row[f])),
					", "
				)})`
		),
		", "
	)
	return [`INSERT INTO ${names.table(Node)} (${columns}) VALUES ${values}`]
}

/**
 * The state the case's transaction holds, judged: whether the check's violation query, lowered by the oracle baseline,
 * finds a row; its check over every row, the one a migration runs, must find one exactly then, and the judge, run over
 * the units the transaction wrote since it last ran (SET CONSTRAINTS ALL IMMEDIATE), must refuse exactly then, under
 * the check's name and an integrity SQLSTATE.
 */
const verdict = (installed: Installed, connection: PgConnection, where: string) =>
	Effect.gen(function* () {
		const installation = installed.installation
		const [baseline, ...more] = baselineRuleChecks(installation)
		assert.ok(baseline !== undefined && more.length === 0, "the schema states one rule, the check")
		const broken =
			(yield* connection.queryValues(
				`SELECT EXISTS (${printStatement(baseline.query)})`,
				[]
			))[0]?.[0] === true
		for (const check of lawChecks(installation).rules) {
			const found = (yield* connection.queryValues(foundQueryOf(check.query), []))[0]?.[0] === true
			assert.equal(
				found,
				broken,
				`the check over every row agrees with the violation query, ${where}`
			)
		}
		const refused = yield* refusalOf(connection.query("SET CONSTRAINTS ALL IMMEDIATE", []))
		assert.equal(
			Option.isSome(refused),
			broken,
			`the judge ${Option.isSome(refused) ? "refused" : "accepted"} a state the violation query finds ${broken ? "broken" : "lawful"}, ${where}`
		)
		if (Option.isSome(refused)) {
			const raised = Arr.getSomes(Arr.map(judgedStatementsOf(installation), raisedRule))
			assert.ok(
				refused.value.constraint !== undefined && Arr.contains(raised, refused.value.constraint),
				`the judge refused under ${refused.value.constraint ?? "no constraint"}, the check's, ${where}`
			)
			assert.ok(
				Arr.contains(["23503", "23505", "23514"], refused.value.code),
				`the judge refused under ${refused.value.code}, an integrity SQLSTATE, ${where}`
			)
		}
		return broken
	})

/**
 * The constraints deferred again: SET CONSTRAINTS ALL IMMEDIATE holds to the transaction's end, so the judge would run
 * at each statement of the second part, where it runs once the part is written.
 */
const deferred = "SET CONSTRAINTS ALL DEFERRED"

/**
 * One case in its one transaction, which the case's end rolls back: the first part written and judged; where the judge
 * accepts it, the constraints deferred again, and the second part written and judged over the units it wrote.
 */
export const runChain = (
	installed: Installed,
	connection: PgConnection,
	drawn: ChainCase,
	c: Case<ChainFeature>
) =>
	Effect.gen(function* () {
		yield* standUpJudge(connection, installed.installation)
		const chain = chains[drawn.chain]
		c.note(depthFeature[chain.depth])
		if (chain.reads === 2) {
			c.note("each rule reading the level below twice")
		}
		for (const sql of written(installed, drawn.first)) {
			yield* connection.query(sql, [])
		}
		if (yield* verdict(installed, connection, `${Formatter.format(drawn)}, after its first part`)) {
			c.note("refused by the judge")
			return
		}
		yield* connection.query(deferred, [])
		for (const sql of written(installed, drawn.second)) {
			yield* connection.query(sql, [])
		}
		if (
			yield* verdict(installed, connection, `${Formatter.format(drawn)}, after its second part`)
		) {
			c.note("refused by the judge")
			c.note("refused over the units of a second part")
			return
		}
		c.note("accepted by the judge")
	})
