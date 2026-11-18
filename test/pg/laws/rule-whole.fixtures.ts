/** What the properties of rule-whole.test.ts read: the schemas and their templates, the spaces, and each case's run. */

import { aimed, array, boolean, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option } from "effect"
import { parsePlan, rowsRead, rowsTouched } from "#bench/harness/explain.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { constraintLaw } from "#compiler/ir/products.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	contained,
	derived,
	key,
	mutable,
	on,
	relation,
	schema
} from "#compiler/public/schema.ts"
import type { OperandSelect, PlStatement } from "#compiler/sql/ast.ts"
import { exists } from "#compiler/sql/build.ts"
import { printExpr, printStatement } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { type Installed, migratedTemplate } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { refusalOf } from "#test/support/substrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/** A node of a document: its document, its place, its parent's place, its own place at a root, and its kind. */
const Node = relation(
	"Node",
	{ doc: pg.integer, start: pg.integer, parent: pg.integer, kind: pg.integer },
	["doc", "start"]
)
/** An expression at a node: its document and place, and its type. */
const Expr = relation("Expr", { doc: pg.integer, start: pg.integer, type: pg.integer }, [
	"doc",
	"start"
])

/**
 * The schema the properties judge, by its rules over queries, every one unit-local: each relation keyed by its
 * document first, every rule joining within one document. `probed`: Node and Expr mutable, so no rule is unit-local and
 * each is probed; else immutable, so each is judged whole over the documents a transaction wrote, the unit, and the
 * aggregate's rule beside them, which no probe reads.
 *
 * - Rooted: every expression's parent is an expression: a containment of a join into a table, which a node's insert
 *   breaks and an expression's delete does.
 * - Kinded: a node of kind 1 that is an expression is of type 1: a check over a join.
 * - One type: the expressions below one parent share one type: a key over a projection of the join.
 * - Fanout: a node has at most three children, and one of kind 2 at least two, a root its own child among them: a
 *   check over a count of each node's children, zero by a second rule for a node with none, which a node's insert and
 *   its delete both break.
 * - Reached: every expression's node is reached from a root along parent links, at any depth: a containment into a
 *   recursion, seeded at each root, its own parent, and stepping to each child within the document, which a node's
 *   delete breaks below it and an expression's insert at a node no root reaches does; the parent links may cycle, and
 *   the walk ends at a set.
 * - Leafed: a node of kind 2 has a child that is a leaf, a node no other is a child of: a check over a negation of a
 *   query that negates in turn, which a child's insert under the leaf and the leaf's delete both break.
 */
const judgeSchema = (name: string, probed: boolean) => {
	const Base = schema(name, [Node, Expr], probed ? [mutable(Node), mutable(Expr)] : [])
	const Typed = derived(
		"Typed",
		query(Base).rule((r) => {
			const { doc, start, type } = v(Expr, "e")
			const { parent, kind } = v(Node, "n")
			return r
				.match(Expr, { doc, start, type })
				.match(Node, { doc, start, parent, kind })
				.find({ doc, start, parent, kind, type })
		})
	)
	const Parents = derived(
		"Parents",
		query(Base).rule((r) => {
			const { doc, start, type } = v(Expr, "e")
			const { parent } = v(Node, "n")
			return r
				.match(Expr, { doc, start, type })
				.match(Node, { doc, start, parent })
				.find({ doc, parent, type })
		})
	)
	const spj = [
		contained(on(Typed, "doc", "parent"), on(Expr, "doc", "start")),
		check("Kinded", Typed, (t) => t.or(t.ne(t.kind, 1), t.eq(t.type, 1))),
		key(on(Parents, "doc", "parent"))
	] as const
	if (probed) {
		return schema.extend(Base, `${name}_1`, [Typed, Parents], spj)
	}
	const Fanout = derived(
		"Fanout",
		query(Base)
			.rule((r) => {
				const { doc, start, kind } = v(Node, "p")
				const { start: child } = v(Node, "c")
				return r
					.match(Node, { doc, start, kind })
					.match(Node, { doc, parent: start, start: child })
					.find({ doc, node: start, kind, children: r.count() })
			})
			.rule((r) => {
				const { doc, start, kind } = v(Node, "p")
				return r
					.match(Node, { doc, start, kind })
					.where(r.not(Node, { doc, parent: start }))
					.find({ doc, node: start, kind, children: 0n })
			})
	)
	const reached = query(Base).recursive("Reached", {
		row: { doc: pg.integer, node: pg.integer },
		base: [
			(r) => {
				const { doc, start } = v(Node, "root")
				return r.match(Node, { doc, start, parent: start }).find({ doc, node: start })
			}
		],
		rec: [
			(r, self) => {
				const { doc, node } = v(self, "at")
				const { start } = v(Node, "child")
				return r
					.match(self, { doc, node })
					.match(Node, { doc, parent: node, start })
					.where(r.ne(start, node))
					.find({ doc, node: start })
			}
		]
	})
	const Reach = derived("Reach", reached)
	const LeafChild = derived(
		"LeafChild",
		query(Base).rule((r) => {
			const { doc, start, parent } = v(Node, "c")
			return r
				.match(Node, { doc, start, parent })
				.where(r.and(r.ne(start, parent), r.not(Node, { doc, parent: start })))
				.find({ doc, parent })
		})
	)
	const Leaves = schema.extend(Base, `${name}_0`, [LeafChild], [])
	const Barren = derived(
		"Barren",
		query(Leaves).rule((r) => {
			const { doc, start, kind } = v(Node, "p")
			return r
				.match(Node, { doc, start, kind })
				.where(r.not(LeafChild, { doc, parent: start }))
				.find({ doc, start, kind })
		})
	)
	return schema.extend(
		Leaves,
		`${name}_1`,
		[Typed, Parents, Fanout, Reach, Barren],
		[
			...spj,
			check("Fanout", Fanout, (f) =>
				f.and(f.le(f.children, 3n), f.or(f.ne(f.kind, 2), f.ge(f.children, 2n)))
			),
			contained(on(Expr, "doc", "start"), on(Reach, "doc", "node")),
			check("Leafed", Barren, (b) => b.ne(b.kind, 2))
		]
	)
}

const WholeJudge = judgeSchema("WholeJudge", false)
const ProbedJudge = judgeSchema("ProbedJudge", true)

/** A judge schema installed through its first migration, with no login. */
const templateOf = (schemaValue: ReturnType<typeof judgeSchema>, name: string, label: string) =>
	migratedTemplate({
		declaredIn: import.meta,
		name,
		content: { schema: schemaValue.name, logins: [] },
		versions: [{ schema: schemaValue, logins: [], declarations: noDeclarations }],
		options: { label, extensions: [], compile: compileInstallation, ambient: ordinarySession }
	})

export const wholeTemplate = templateOf(WholeJudge, "whole judge", "whole_judge")
export const probedTemplate = templateOf(ProbedJudge, "probed judge", "probed_judge")

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

const docs = [1, 2] as const
type Doc = (typeof docs)[number]
const starts = [0, 1, 2, 3] as const
type Start = (typeof starts)[number]
const kinds = [0, 1, 2] as const
type Kind = (typeof kinds)[number]
const types = [0, 1] as const
type Type = (typeof types)[number]

/** One write of a transaction over two documents, each a unit, by direct SQL. */
export type Op =
	| {
			readonly kind: "node"
			readonly doc: Doc
			readonly start: Start
			readonly parent: Start
			readonly nodeKind: Kind
	  }
	| { readonly kind: "expr"; readonly doc: Doc; readonly start: Start; readonly type: Type }
	| { readonly kind: "unnode" | "unexpr"; readonly doc: Doc; readonly start: Start }
	| { readonly kind: "unit"; readonly doc: Doc; readonly type: Type }
	| { readonly kind: "drop"; readonly doc: Doc }
	| { readonly kind: "judge" }

/** A case of the equivalence: its transactions, each its writes in order. */
export interface Schedule {
	readonly transactions: ReadonlyArray<ReadonlyArray<Op>>
}

const docGen = element(docs)
const startGen = element(starts)

const opGen: Gen<Op> = weighted<Op>([
	[
		5,
		(s) => ({
			kind: "node",
			doc: s.draw(docGen),
			start: s.draw(startGen),
			parent: s.draw(startGen),
			nodeKind: s.draw(element(kinds))
		})
	],
	[
		4,
		(s) => ({
			kind: "expr",
			doc: s.draw(docGen),
			start: s.draw(startGen),
			type: s.draw(element(types))
		})
	],
	[
		3,
		(s) => ({
			kind: s.draw(element(["unnode", "unexpr"] as const)),
			doc: s.draw(docGen),
			start: s.draw(startGen)
		})
	],
	[2, (s) => ({ kind: "unit", doc: s.draw(docGen), type: s.draw(element(types)) })],
	[1, (s) => ({ kind: "drop", doc: s.draw(docGen) })],
	[1, () => ({ kind: "judge" })]
])

const scheduleGen: Gen<Schedule> = (s) => ({
	transactions: s.draw(array(array(opGen, { min: 1, max: 6 }), { min: 1, max: 4 }))
})

/** The situations the equivalence must reach. */
export type WholeFeature =
	| "committed"
	| "refused by Rooted"
	| "refused by Kinded"
	| "refused by One type"
	| "refused by Fanout"
	| "refused by Reached"
	| "refused by Leafed"
	| "a whole unit inserted"
	| "a unit dropped whole"
	| "an expression removed under its member"
	| "two units written in one transaction"
	| "the judge run inside a transaction that writes on"

export const wholeFeatures: Arr.NonEmptyReadonlyArray<WholeFeature> = [
	"committed",
	"refused by Rooted",
	"refused by Kinded",
	"refused by One type",
	"refused by Fanout",
	"refused by Reached",
	"refused by Leafed",
	"a whole unit inserted",
	"a unit dropped whole",
	"an expression removed under its member",
	"two units written in one transaction",
	"the judge run inside a transaction that writes on"
]

/**
 * A document written whole (`statementsOf` unit): a root of kind 2, its own parent, and its two children, each an
 * expression, the root's and the second child's of `type` and the first's, of kind 1, of type 1. It keeps every rule
 * at type 1; at type 0 its parent's expressions are of two types, which One type alone refuses.
 */
const lawful = (doc: Doc, type: Type): ReadonlyArray<Op> => [{ kind: "unit", doc, type }]

/** The aims: a case constructed to reach each rare situation, its document drawn. */
const aims: ReadonlyArray<readonly [WholeFeature, Gen<Schedule>]> = [
	[
		"refused by One type",
		(s) => {
			const doc = s.draw(docGen)
			return {
				transactions: [
					s.draw(boolean)
						? lawful(doc, 0)
						: [
								...lawful(doc, 1),
								{ kind: "unexpr", doc, start: 2 },
								{ kind: "expr", doc, start: 2, type: 0 }
							]
				]
			}
		}
	],
	[
		"refused by Fanout",
		(s) => {
			const doc = s.draw(docGen)
			const changed: ReadonlyArray<Op> = s.draw(boolean)
				? [{ kind: "node", doc, start: 3, parent: 0, nodeKind: 0 }]
				: [
						{ kind: "unexpr", doc, start: 1 },
						{ kind: "unexpr", doc, start: 2 },
						{ kind: "unnode", doc, start: 1 },
						{ kind: "unnode", doc, start: 2 }
					]
			return { transactions: [lawful(doc, 1), changed] }
		}
	],
	[
		"refused by Reached",
		(s) => {
			const doc = s.draw(docGen)
			const changed: ReadonlyArray<Op> = s.draw(boolean)
				? [
						{ kind: "unexpr", doc, start: 0 },
						{ kind: "unnode", doc, start: 0 }
					]
				: [
						{ kind: "node", doc, start: 3, parent: 3, nodeKind: 0 },
						{ kind: "unnode", doc, start: 3 },
						{ kind: "node", doc, start: 3, parent: 2, nodeKind: 0 },
						{ kind: "unnode", doc, start: 2 },
						{ kind: "expr", doc, start: 3, type: 1 }
					]
			return { transactions: [lawful(doc, 1), changed] }
		}
	],
	[
		"refused by Leafed",
		(s) => {
			const doc = s.draw(docGen)
			const changed: ReadonlyArray<Op> = s.draw(boolean)
				? [
						{ kind: "unexpr", doc, start: 2 },
						{ kind: "unnode", doc, start: 2 },
						{ kind: "node", doc, start: 3, parent: 1, nodeKind: 0 }
					]
				: [
						{ kind: "node", doc, start: 3, parent: 1, nodeKind: 0 },
						{ kind: "unexpr", doc, start: 2 },
						{ kind: "unnode", doc, start: 2 },
						{ kind: "judge" }
					]
			return { transactions: [lawful(doc, 1), changed] }
		}
	],
	[
		"an expression removed under its member",
		(s) => {
			const doc = s.draw(docGen)
			return {
				transactions: [lawful(doc, 1), [{ kind: "unexpr", doc, start: 0 }]]
			}
		}
	],
	[
		"two units written in one transaction",
		(s) => ({
			transactions: [
				[...lawful(1, 1), ...lawful(2, s.draw(element(types)))],
				[{ kind: "drop", doc: s.draw(docGen) }]
			]
		})
	],
	[
		"the judge run inside a transaction that writes on",
		(s) => {
			const doc = s.draw(docGen)
			return {
				transactions: [
					[...lawful(doc, 1), { kind: "judge" }, { kind: "unexpr", doc, start: s.draw(startGen) }]
				]
			}
		}
	]
]

export const wholeSpace = aimed(scheduleGen, aims)

/** The statements of one write, on the installation's names. */
const statementsOf = (
	installed: Installed,
	op: Exclude<Op, { readonly kind: "judge" }>
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const node = names.table(Node)
	const expr = names.table(Expr)
	switch (op.kind) {
		case "node":
			return [
				`INSERT INTO ${node} (doc, start, parent, kind) VALUES (${op.doc}, ${op.start}, ${op.parent}, ${op.nodeKind}) ON CONFLICT DO NOTHING`
			]
		case "expr":
			return [
				`INSERT INTO ${expr} (doc, start, type) VALUES (${op.doc}, ${op.start}, ${op.type}) ON CONFLICT DO NOTHING`
			]
		case "unnode":
			return [`DELETE FROM ${node} WHERE doc = ${op.doc} AND start = ${op.start}`]
		case "unexpr":
			return [`DELETE FROM ${expr} WHERE doc = ${op.doc} AND start = ${op.start}`]
		case "unit":
			return [
				`INSERT INTO ${node} (doc, start, parent, kind) VALUES (${op.doc}, 0, 0, 2), (${op.doc}, 1, 0, 1), (${op.doc}, 2, 0, 0) ON CONFLICT DO NOTHING`,
				`INSERT INTO ${expr} (doc, start, type) VALUES (${op.doc}, 0, ${op.type}), (${op.doc}, 1, 1), (${op.doc}, 2, ${op.type}) ON CONFLICT DO NOTHING`
			]
		case "drop":
			return [
				`DELETE FROM ${expr} WHERE doc = ${op.doc}`,
				`DELETE FROM ${node} WHERE doc = ${op.doc}`
			]
	}
}

/** The law a refusal's trigger reports, through the installation's constraint map. */
const refusedLaw = (
	installation: Installation,
	fields: { readonly table: Option.Option<string>; readonly constraint: string | undefined }
): LawId | undefined => {
	if (Option.isNone(fields.table) || fields.constraint === undefined) {
		return undefined
	}
	const table = fields.table.value
	const owner = Arr.findFirst(
		["Node", "Expr"],
		(r) => installation.names.relation(r).name === table
	)
	return Option.isNone(owner)
		? undefined
		: constraintLaw(
				installation.constraintToLaw,
				{ kind: "table", name: installation.names.relation(owner.value).name },
				fields.constraint
			)
}

/** The six rules the schemas state, by the names their features read. */
type RuleName = "Rooted" | "Kinded" | "One type" | "Fanout" | "Reached" | "Leafed"

/** The rules the whole schema alone states, which no probe reads: an aggregate's, a recursion's and a nested negation's. */
const wholeOnly: ReadonlyArray<RuleName> = ["Fanout", "Reached", "Leafed"]

/** The situation a refusal by each rule reaches. */
const refusedBy: { readonly [R in RuleName]: WholeFeature } = {
	Rooted: "refused by Rooted",
	Kinded: "refused by Kinded",
	"One type": "refused by One type",
	Fanout: "refused by Fanout",
	Reached: "refused by Reached",
	Leafed: "refused by Leafed"
}

/**
 * The name of the rule a rule over a query's law states, whichever strategy judges it: a containment by the relation it
 * is into, Expr's Rooted's and the walk's Reached's.
 */
const nameOfLaw = (
	law:
		| { readonly kind: "contained"; readonly to: { readonly relation: string } }
		| { readonly kind: "key" }
		| { readonly kind: "check"; readonly name: string }
): RuleName => {
	switch (law.kind) {
		case "contained":
			return law.to.relation === "Reach" ? "Reached" : "Rooted"
		case "key":
			return "One type"
		case "check":
			return law.name === "Fanout" ? "Fanout" : law.name === "Leafed" ? "Leafed" : "Kinded"
	}
}

/** The rule law `law` of an installation states, by its name. */
const ruleNameOf = (installation: Installation, law: LawId): RuleName => {
	const rule = defined(
		Arr.findFirst(installation.laws.rules, (r) => r.law.id === law).pipe(Option.getOrUndefined),
		`the rule of law ${law}`
	).rule
	return nameOfLaw(rule.kind === "whole" ? rule.law : rule)
}

/** What one installation's judge made of a state: the laws its whole checks find broken, and the law it refused by. */
interface Verdict {
	readonly broken: ReadonlySet<RuleName>
	readonly refused: RuleName | undefined
}

/**
 * Judges the state `session`'s transaction leaves against every rule's whole check, then runs the judge (SET
 * CONSTRAINTS ALL IMMEDIATE): it must refuse exactly when a whole check finds the state broken, naming a rule it finds
 * broken under that rule's SQLSTATE.
 */
const judged = (installed: Installed, session: RawSession, where: string) =>
	Effect.gen(function* () {
		const installation = installed.installation
		const broken = new Set<RuleName>()
		for (const lawCheck of lawChecks(installation).rules) {
			const found = yield* session.values(`SELECT EXISTS (${printStatement(lawCheck.query)})`, [])
			if (found[0]?.[0] === true) {
				broken.add(ruleNameOf(installation, lawCheck.law))
			}
		}
		const refused = yield* refusalOf(session.query("SET CONSTRAINTS ALL IMMEDIATE", []))
		if (Option.isNone(refused)) {
			if (broken.size > 0) {
				return yield* new Disagreed({
					message: `${installation.names.schema}: the judge accepted a state its whole checks find breaking ${Formatter.format([...broken])}, ${where}`
				})
			}
			return { broken, refused: undefined } satisfies Verdict
		}
		const law = refusedLaw(installation, refused.value)
		const rule = law === undefined ? undefined : ruleNameOf(installation, law)
		if (
			rule === undefined ||
			!broken.has(rule) ||
			!["23503", "23505", "23514"].includes(refused.value.code)
		) {
			return yield* new Disagreed({
				message: `${installation.names.schema}: the judge refused under ${refused.value.code} ${refused.value.constraint ?? "naming no constraint"} where the whole checks find ${Formatter.format([...broken])}, ${where}`
			})
		}
		return { broken, refused: rule } satisfies Verdict
	})

/** The units one transaction's writes reach, by the documents they write. */
const unitsOf = (ops: ReadonlyArray<Op>): ReadonlySet<Doc> =>
	new Set(Arr.flatMap(ops, (op) => (op.kind === "judge" ? [] : [op.doc])))

/**
 * One case of the equivalence on a clone of each installation: each transaction's writes in order on an owner session
 * of each at SERIALIZABLE, the whole judge's and the probed judge's in lockstep. At each judge op and at the
 * transaction's end, each installation's judge is held to its whole checks (`judged`), and the whole judge refuses
 * exactly where the probed judge does, wherever the aggregate's rule, which only the whole schema states, holds. A
 * refusal of either rolls both back, so the two hold one state throughout.
 */
export const runEquivalence = (
	whole: { readonly installed: Installed; readonly session: RawSession },
	probed: { readonly installed: Installed; readonly session: RawSession },
	schedule: Schedule,
	c: Case<WholeFeature>
) =>
	Effect.gen(function* () {
		const sides = [whole, probed] as const
		for (const [at, ops] of schedule.transactions.entries()) {
			const where = `transaction ${at} of ${Formatter.format(schedule)}`
			for (const side of sides) {
				yield* side.session.begin
			}
			if (unitsOf(ops).size > 1) {
				c.note("two units written in one transaction")
			}
			/**
			 * Both judges at this point: the whole judge refuses exactly where the probed one does, wherever the rules
			 * only the whole schema states hold.
			 */
			const both = Effect.gen(function* () {
				const w = yield* judged(whole.installed, whole.session, where)
				const p = yield* judged(probed.installed, probed.session, where)
				if (
					!Arr.some(wholeOnly, (rule) => w.broken.has(rule)) &&
					(w.refused === undefined) !== (p.refused === undefined)
				) {
					return yield* new Disagreed({
						message: `the whole judge ${w.refused === undefined ? "accepted" : `refused by ${w.refused}`} where the probed judge ${p.refused === undefined ? "accepted" : `refused by ${p.refused}`}, ${where}`
					})
				}
				return w.refused
			})
			let ended = false
			let judgedOnce = false
			for (const op of ops) {
				if (op.kind === "judge") {
					const refused = yield* both
					if (refused !== undefined) {
						c.note(refusedBy[refused])
						for (const side of sides) {
							yield* side.session.rollback
						}
						ended = true
						break
					}
					for (const side of sides) {
						yield* side.session.query("SET CONSTRAINTS ALL DEFERRED", [])
					}
					judgedOnce = true
					continue
				}
				for (const side of sides) {
					for (const sql of statementsOf(side.installed, op)) {
						yield* side.session.query(sql, [])
					}
				}
				if (op.kind === "unit") {
					c.note("a whole unit inserted")
				}
				if (op.kind === "drop") {
					c.note("a unit dropped whole")
				}
				if (op.kind === "unexpr") {
					c.note("an expression removed under its member")
				}
				if (judgedOnce) {
					c.note("the judge run inside a transaction that writes on")
				}
			}
			if (ended) {
				continue
			}
			const refused = yield* both
			if (refused === undefined) {
				for (const side of sides) {
					yield* side.session.commit
				}
				c.note("committed")
			} else {
				c.note(refusedBy[refused])
				for (const side of sides) {
					yield* side.session.rollback
				}
			}
		}
	})

/** The PL/pgSQL body of the installation's function named `name`. */
const bodyOf = (installation: Installation, name: string): ReadonlyArray<PlStatement> =>
	Arr.flatMap(installation.statements, (s) =>
		s.kind === "createFunction" && s.language === "plpgsql" && s.name.name === name
			? s.body.body
			: []
	)

/** The queries a judge's body tests by EXISTS at its top to raise: each whole rule's statement. */
const wholeStatementsOf = (installation: Installation): ReadonlyArray<OperandSelect> =>
	Arr.flatMap(bodyOf(installation, identifierOf(identity.ruleJudge())), (s) =>
		s.kind === "if"
			? Arr.flatMap(s.branches, (b) =>
					b.condition.kind === "exists" && b.body[0]?.kind === "raise" ? [b.condition.query] : []
				)
			: []
	)

/** A case of the locality: the documents stored beside the written one, then as many again, and the statistics. */
export interface Locality {
	readonly stored: number
	readonly more: number
	readonly statistics: "none" | "analyzed"
	/** The documents a transaction then writes beside the first, and three times as many again. */
	readonly written: number
}

/** Hundreds of stored documents beside the written one, each a lawful unit of a root and two children. */
export const localityGen: Gen<Locality> = (s) => ({
	stored: s.draw(int(2000, 3000)),
	more: s.draw(int(2000, 3000)),
	statistics: s.draw(element(["none", "analyzed"] as const)),
	written: s.draw(int(30, 60))
})

export type LocalityFeature = "measured with no statistics" | "measured analyzed"

/** The statements loading lawful documents `from` to `to`, the tables' captures off. */
const loaded = (installed: Installed, from: number, to: number): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const node = names.table(Node)
	const expr = names.table(Expr)
	return [
		`ALTER TABLE ${node} DISABLE TRIGGER USER`,
		`ALTER TABLE ${expr} DISABLE TRIGGER USER`,
		`INSERT INTO ${node} (doc, start, parent, kind) SELECT d, s, 0, CASE WHEN s = 0 THEN 2 WHEN s = 1 THEN 1 ELSE 0 END FROM generate_series(${from}, ${to}) AS g(d), generate_series(0, 2) AS h(s)`,
		`INSERT INTO ${expr} (doc, start, type) SELECT d, s, 1 FROM generate_series(${from}, ${to}) AS g(d), generate_series(0, 2) AS h(s)`,
		`ALTER TABLE ${node} ENABLE TRIGGER USER`,
		`ALTER TABLE ${expr} ENABLE TRIGGER USER`
	]
}

/** Each whole rule's statement's plan, as EXPLAIN ANALYZE runs it, on `connection`. */
const plansOf = (installed: Installed, connection: PgConnection) =>
	Effect.forEach(wholeStatementsOf(installed.installation), (statement) =>
		Effect.map(
			connection.queryValues(
				`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) SELECT ${printExpr(exists(statement))}`,
				[]
			),
			(explained) => succeeded(parsePlan(explained[0]?.[0]), "one EXPLAIN plan").plan
		)
	)

/** The rows each whole rule's statement reads of the stored tables, as EXPLAIN ANALYZE counts them, on `connection`. */
const readsOf = (installed: Installed, connection: PgConnection) =>
	Effect.map(plansOf(installed, connection), Arr.map(rowsRead))

/**
 * The rows each whole rule's statement handles at every node of its plan, over all of its loops (rowsTouched), on
 * `connection`: its work, the region's rows and every step's among them.
 */
const workOf = (installed: Installed, connection: PgConnection) =>
	Effect.map(plansOf(installed, connection), Arr.map(rowsTouched))

/** The statements writing lawful documents `from` to `to` through the captures, as a publish writes them whole. */
const writtenWhole = (installed: Installed, from: number, to: number): ReadonlyArray<string> => {
	const names = namesOf(installed)
	return [
		`INSERT INTO ${names.table(Node)} (doc, start, parent, kind) SELECT d, s, 0, CASE WHEN s = 0 THEN 2 WHEN s = 1 THEN 1 ELSE 0 END FROM generate_series(${from}, ${to}) AS g(d), generate_series(0, 2) AS h(s)`,
		`INSERT INTO ${names.table(Expr)} (doc, start, type) SELECT d, s, 1 FROM generate_series(${from}, ${to}) AS g(d), generate_series(0, 2) AS h(s)`,
		"SET CONSTRAINTS ALL IMMEDIATE"
	]
}

/**
 * One locality case in its one transaction, which the case's end rolls back: `stored` lawful documents loaded with the
 * captures off, ANALYZE where the case draws it, one document written whole, which the captures hold, and the judge.
 * Every whole rule's statement is explained; then `more` documents are loaded and each explained again. Each must read
 * fewer rows than there are documents beside the written one, each three rows of each table, both times: the written
 * document's rows, three of each table, read once per unit of the region or once per fact a negation reads them at,
 * whichever plan PostgreSQL chooses, and never a row of another document, a read of which reads past the written unit's
 * key range into all of them.
 *
 * Then `written` more documents are written whole and each statement explained, and three times as many again: each
 * statement's work, every row each node of its plan handles over all of its loops, must grow at most twice as fast as
 * the documents written, under eight times for four times the units. Its steps run once per written unit, each reading
 * that unit alone, so its work grows with the units, four times; a region read again inside a step, once per unit of
 * the region outside, grows with their square, sixteen times.
 */
export const runLocality = (
	installed: Installed,
	connection: PgConnection,
	locality: Locality,
	c: Case<LocalityFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const statistics =
			locality.statistics === "analyzed"
				? [`ANALYZE ${names.table(Node)}`, `ANALYZE ${names.table(Expr)}`]
				: []
		for (const sql of [...loaded(installed, 10, 10 + locality.stored), ...statistics]) {
			yield* connection.query(sql, [])
		}
		const written = 0
		for (const sql of [
			`INSERT INTO ${names.table(Node)} (doc, start, parent, kind) VALUES (${written}, 0, 0, 2), (${written}, 1, 0, 1), (${written}, 2, 0, 0)`,
			`INSERT INTO ${names.table(Expr)} (doc, start, type) VALUES (${written}, 0, 1), (${written}, 1, 1), (${written}, 2, 1)`,
			"SET CONSTRAINTS ALL IMMEDIATE"
		]) {
			yield* connection.query(sql, [])
		}
		const first = yield* readsOf(installed, connection)
		assert.ok(first.length > 0, "the judge holds a whole rule's statement")
		const from = 11 + locality.stored
		for (const sql of [...loaded(installed, from, from + locality.more), ...statistics]) {
			yield* connection.query(sql, [])
		}
		const again = yield* readsOf(installed, connection)
		const beside = locality.stored
		assert.ok(
			Arr.every([...first, ...again], (rows) => rows < beside),
			`${Formatter.format(locality)}: each whole rule's statement reads the written document's rows alone, fewer than the ${beside} documents beside it, ${Formatter.format(first)} and then ${Formatter.format(again)} beside ${locality.more} more`
		)
		for (const sql of writtenWhole(installed, -locality.written, -1)) {
			yield* connection.query(sql, [])
		}
		const some = yield* workOf(installed, connection)
		for (const sql of writtenWhole(installed, -4 * locality.written, -locality.written - 1)) {
			yield* connection.query(sql, [])
		}
		const more = yield* workOf(installed, connection)
		assert.ok(
			Arr.every(Arr.zip(some, more), ([w, m]) => m < 8 * Math.max(w, 1)),
			`${Formatter.format(locality)}: each whole rule's statement's work grows with the units written, under eight times for four times as many documents, ${Formatter.format(some)} for ${locality.written + 1} documents written and then ${Formatter.format(more)} for ${4 * locality.written + 1}`
		)
		c.note(locality.statistics === "none" ? "measured with no statistics" : "measured analyzed")
	})
