import { Array as Arr, Effect, Option, Predicate, Record as Rec } from "effect"
import { findNodes } from "#bench/harness/explain.ts"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"

import {
	compareVariants,
	measureVariant,
	type TextRow,
	type VariantOptions
} from "#bench/harness/variant.ts"

import {
	autocommit,
	type Compiled,
	compile,
	conditions,
	deliveredAgree,
	fill,
	GateSetupError,
	handwritten,
	installFixture,
	judged,
	type MeasureOptions,
	measureQuery,
	optimizedStatement,
	plainExplain,
	queryPhases,
	rawSession,
	textRowsOf,
	runtimeSession,
	serializedExplain,
	settle
} from "#bench/query/support/kit.ts"

import {
	joinTypes,
	outline,
	planFigures,
	planOf,
	plansOf,
	rowsReadFrom,
	serializedKb
} from "#bench/query/support/plans.ts"
import { attachFuseMaxFields } from "#compiler/core/policy.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import type { OptimizedStatement } from "#compiler/lower/shapes/index.ts"
import { transportLimits } from "#compiler/lower/shapes/relparam/index.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { featureCount, has, shapeOf } from "#test/support/kernel/shape.ts"
import { labeledStatements } from "#test/support/oracle/compare.ts"
import { fusedForm } from "#test/support/oracle/verify/channels.ts"

/**
 * R36 and R37: fused and pipelined attachments, and recursive attachments seeded from their parents' rows.
 *
 * - R36 (:410): "both lowerings deliver identical nested results; the fused form is selected only where measured
 *   serialization and planning cost beat the extra statement." A region's accounts carry three attachments: one field
 *   (fused as ARRAY(SELECT ...)), two fields (fused as to_jsonb objects) and five fields, above attachFuseMaxFields
 *   (pipelined: a statement of its own, which computes its parents' rows itself in the same flight). The generated
 *   delivery is compared with the conservative one, which pipelines every attachment, as nested results; the fused
 *   statement's output volume and planning and the extra statement's round trip are recorded for the calibration. No
 *   plan joins outer.
 * - R37 (:418): "total rows read is proportional to the closures, not to the parents times the relation." A binary
 *   tree of follows edges and a recursive relation whose state carries its origin; a range of people with their
 *   reachable set attached is one recursive statement seeded from its parents' rows, and the edges it reads are
 *   bounded by the delivered closures.
 * The handwritten baselines are what an expert writes for the same nested answers: the region's
 * accounts in one statement with each attachment a correlated to_jsonb(ARRAY(SELECT jsonb_build_object(...))) over the
 * account's tasks, and the range of people in one statement whose recursive CTE is seeded from the range and carries
 * the origin, each parent's reachable set aggregated the same way. They deliver nested JSON rather than the runtime's
 * rows, so they are compared with the generated delivery as nested results, every scalar by its text.
 */
const Account = relation("Account", { id: pg.bigint, region: pg.integer }, ["id"])
const Task = relation(
	"Task",
	{
		id: pg.bigint,
		account: pg.bigint,
		title: str.regex("^.{1,80}$", "su"),
		priority: pg.integer,
		due: pg.integer,
		points: pg.integer
	},
	["id"]
)
const Person = relation("Person", { id: pg.bigint, team: pg.integer }, ["id"])
const Follows = relation("Follows", { from: pg.bigint, to: pg.bigint }, ["from", "to"])
const Attach = schema("Attach", { Account, Task, Person, Follows }, [
	contained(on(Task, "account"), on(Account, "id")),
	contained(on(Follows, "from"), on(Person, "id")),
	contained(on(Follows, "to"), on(Person, "id"))
])

/** R36. */
const regionCards = query(Attach)
	.rule((r) => {
		const { id, region } = v(Account, "account")
		return r
			.match(Account, { id, region })
			.where(r.eq(region, r.param("region", pg.integer)))
			.find({ id })
	})
	.attach(
		"ids",
		(a) =>
			query(Attach).rule((r) => {
				const { id } = v(Task, "task")
				return r.match(Task, { id, account: a.id }).find({ id })
			}),
		"array"
	)
	.attach(
		"priorities",
		(a) =>
			query(Attach).rule((r) => {
				const { id, priority } = v(Task, "task")
				return r.match(Task, { id, account: a.id, priority }).find({ id, priority })
			}),
		"array"
	)
	.attach(
		"sheet",
		(a) =>
			query(Attach).rule((r) => {
				const { id, title, priority, due, points } = v(Task, "task")
				return r
					.match(Task, { id, account: a.id, title, priority, due, points })
					.find({ id, title, priority, due, points })
			}),
		"array"
	)

/**
 * A one-field child that drops the task key, so its values need deduplication: not among the fusion rule's exclusions
 * (recursive, approximate, paged, nested-attachment, heterogeneous children).
 */
const regionTitles = query(Attach)
	.rule((r) => {
		const { id, region } = v(Account, "account")
		return r
			.match(Account, { id, region })
			.where(r.eq(region, r.param("region", pg.integer)))
			.find({ id })
	})
	.attach(
		"titles",
		(a) =>
			query(Attach).rule((r) => {
				const { title } = v(Task, "task")
				return r.match(Task, { account: a.id, title }).find({ title })
			}),
		"array"
	)

/**
 * R37: the people each person reaches. The attached recursion's base reads the parent's id, which the checker carries
 * in the state as its origin (check/recursion/origin.ts).
 */
const reachCards = query(Attach)
	.rule((r) => {
		const { id } = v(Person, "person")
		return r
			.match(Person, { id })
			.where(r.ge(id, r.param("lo", pg.bigint)), r.le(id, r.param("hi", pg.bigint)))
			.find({ id })
	})
	.attach(
		"reach",
		(p) =>
			query(Attach).recursive("Reach", {
				row: { person: pg.bigint },
				base: [
					(r) => {
						const { to } = v(Follows, "follows")
						return r.match(Follows, { from: p.id, to }).find({ person: to })
					}
				],
				rec: [
					(r, self) => {
						const { person } = v(self, "self")
						const { to } = v(Follows, "follows")
						return r
							.match(self, { person })
							.match(Follows, { from: person, to })
							.find({ person: to })
					}
				]
			}),
		"array"
	)

const programs = { regionCards, regionTitles, reachCards } as const

interface Options extends Readonly<Record<string, unknown>> {
	readonly accounts: number
	readonly tasksPerAccount: number
	readonly people: number
	readonly samples: number
}

/** The total length of every delivered parent's array under `name`. */
const arrayTotal = (rows: ReadonlyArray<unknown>, name: string): number =>
	Arr.reduce(rows, 0, (n, row) => {
		if (!Predicate.hasProperty(row, name)) {
			return n
		}
		const items: unknown = row[name]
		return n + (Arr.isArray(items) ? items.length : 0)
	})

/**
 * A delivered value with every bigint and number as its decimal text, records and arrays rebuilt: the form in which a
 * handwritten statement's JSON, whose scalars are all text, compares with the runtime's decoded rows.
 */
const asText = (value: unknown): unknown => {
	if (typeof value === "bigint" || typeof value === "number") {
		return String(value)
	}
	if (Arr.isArray(value)) {
		return Arr.map(value, (x: unknown) => asText(x))
	}
	if (Predicate.isObject(value)) {
		return Rec.fromEntries(Arr.map(Rec.toEntries(value), ([k, x]) => [k, asText(x)]))
	}
	return value
}

/**
 * A handwritten nested row: its first column the parent key's text, each later one a JSON array of records of text.
 * Every handwritten column is cast to text and never NULL, so a NULL cell is a defect of the statement.
 */
const childrenOf = (text: string): ReadonlyArray<Readonly<Record<string, string>>> =>
	trustedJson<ReadonlyArray<Readonly<Record<string, string>>>>(text)

const cellText = (row: TextRow, at: number, what: string): string => {
	const cell = row[at]
	if (cell === null || cell === undefined) {
		throw new GateSetupError({ what: `a handwritten nested row without ${what}` })
	}
	return cell
}

const nestedRows = (
	rows: ReadonlyArray<TextRow>,
	names: ReadonlyArray<string>
): ReadonlyArray<Readonly<Record<string, unknown>>> =>
	Arr.map(rows, (row) =>
		Rec.fromEntries([
			["id", cellText(row, 0, "its parent key")],
			...Arr.map(names, (name, i) => [name, childrenOf(cellText(row, i + 1, name))] as const)
		])
	)

/** The parent keys of delivered rows: each delivered parent's bigint id. */
const parentIds = (rows: ReadonlyArray<unknown>): ReadonlyArray<bigint> =>
	Arr.map(rows, (row) => {
		if (!Predicate.hasProperty(row, "id") || typeof row.id !== "bigint") {
			throw new GateSetupError({ what: "a delivered parent without its bigint id" })
		}
		return row.id
	})

const distinctParents = (rows: ReadonlyArray<unknown>): boolean => {
	const ids = parentIds(rows)
	return new Set(ids).size === ids.length
}

/** The fused attachment `name` of a statement. */
const fusedAs = (statement: OptimizedStatement, name: string) =>
	Arr.findFirst(statement.fused, (f) => f.name === name)

/** Whether the statement fuses the attachment `name`, written as `form`. */
const fusedAsForm = (
	statement: OptimizedStatement,
	name: string,
	form: ReturnType<typeof fusedForm>
): boolean => Option.exists(fusedAs(statement, name), (f) => fusedForm(f.layout) === form)

/**
 * The pipelined attachment statements `name` of a compiled read, with their positions in the optimized artifact, which
 * are their positions among the statements a delivery sends.
 */
const attachmentsOf = (
	compiled: Compiled,
	name: string
): ReadonlyArray<{ readonly index: number; readonly statement: OptimizedStatement }> =>
	Arr.flatMap(
		labeledStatements(compiled.compiled.template.programs.optimized.roots),
		({ statement, attach }, index) => (attach?.name === name ? [{ index, statement }] : [])
	)

/** The join types an outer join plans as: none of grizzle's statements has one. */
const outerJoins: ReadonlyArray<string> = ["Left", "Right", "Full"]

type Gates = "R36" | "R37"

/** @internal */
export default defineGate({
	name: "query-attach",
	gates: ["R36", "R37"],
	title:
		"Fused and pipelined attachments, and recursive attachments seeded from their parents' rows",
	scope:
		"A parent with one-field, two-field and five-field attachments, generated against the all-pipelined conservative " +
		"delivery (R36); a range of tree nodes with their reachable sets through a recursive relation carrying its origin " +
		"(R37).",
	phases: queryPhases,
	options: {
		full: { accounts: 4000, tasksPerAccount: 20, people: 200000, samples: 15 },
		quick: { accounts: 600, tasksPerAccount: 20, people: 20000, samples: 2 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const fx = yield* installFixture(Attach, programs, "benchattach", [])
			const tasks = options.accounts * options.tasksPerAccount
			yield* fill(fx, "Account", options.accounts, { id: "g::int8", region: "(g % 40)::int4" })
			yield* fill(fx, "Task", tasks, {
				id: "g::int8",
				account: `(1 + (g - 1) / ${options.tasksPerAccount})::int8`,
				title: "'task ' || (g % 7)",
				priority: "(g % 10)::int4",
				due: "(g % 365)::int4",
				points: "(g % 13)::int4"
			})
			yield* fill(fx, "Person", options.people, { id: "g::int8", team: "(g % 10)::int4" })
			yield* fill(fx, "Follows", options.people - 1, {
				from: "((g + 1) / 2)::int8",
				to: "(g + 1)::int8"
			})
			yield* settle(fx)
			const runtime = yield* runtimeSession(fx, fx.world.app, "m15b attach runtime")
			const raw = yield* rawSession(fx, fx.world.app, "m15b attach raw")
			const follows = fx.relationName("Follows")
			const reading = { role: fx.world.app, context: "snapshot", warm: 3, read: "rows" } as const
			const installed =
				"fresh install of Attach with its workload's access paths; facts loaded, then VACUUM (ANALYZE) of every table"
			const warm = "warm: each variant runs once before its timed samples"
			const cases: Array<CaseRecord<Gates>> = []
			const measure: MeasureOptions = {
				samples: options.samples,
				explainSamples: 1,
				serverPlans: [],
				explain: serializedExplain,
				limits: transportLimits,
				conservativeSamples: options.samples
			}
			const handOptions: VariantOptions = {
				samples: options.samples,
				warmup: 1,
				explainSamples: 1,
				explain: plainExplain,
				serverPlans: []
			}

			/** R36. */
			const region = 9
			const cards = compile(fx, regionCards, reading)
			const cardsM = yield* measureQuery(runtime, raw, cards, { region }, measure)
			const sent = cardsM.delivered.generated.statements
			const cardsParent = optimizedStatement(cards, 0)
			const parentShape = shapeOf(cardsParent.ast)
			const sheets = attachmentsOf(cards, "sheet")
			const titles = compile(fx, regionTitles, reading)
			const titlesM = yield* measureQuery(runtime, raw, titles, { region }, measure)
			const titlesSent = titlesM.delivered.generated.statements
			const titlesParent = optimizedStatement(titles, 0)
			const A = fx.table("Account")
			const T = fx.table("Task")
			const ac = (f: string) => fx.column("Account", f)
			const tc = (f: string) => fx.column("Task", f)
			const children = (fields: ReadonlyArray<string>, distinct: boolean): string =>
				`to_jsonb(ARRAY(SELECT ${distinct ? "DISTINCT " : ""}jsonb_build_object(${Arr.join(
					Arr.map(fields, (f) => `'${f}', t.${tc(f)}::text`),
					", "
				)}) FROM ${T} AS t WHERE t.${tc("account")} = a.${ac("id")}))::text`
			const regionSql = (columns: ReadonlyArray<string>): string =>
				`SELECT a.${ac("id")}::text, ${Arr.join(columns, ", ")} FROM ${A} AS a WHERE a.${ac("region")} = $1::integer`
			const cardsHandSpec = handwritten(
				"handwritten: one statement, each attachment a correlated array",
				[
					{
						sql: regionSql([
							children(["id"], false),
							children(["id", "priority"], false),
							children(["id", "title", "priority", "due", "points"], false)
						]),
						params: [String(region)]
					}
				],
				autocommit
			)
			const cardsHand = yield* measureVariant(raw, cardsHandSpec, {
				...handOptions,
				explain: serializedExplain
			})
			const cardsHandTexts = yield* textRowsOf(raw, cardsHandSpec.statements)
			const cardsHandRows = nestedRows(cardsHandTexts, ["ids", "priorities", "sheet"])
			const titlesHandSpec = handwritten(
				"handwritten: one statement, the distinct titles a correlated array",
				[{ sql: regionSql([children(["title"], true)]), params: [String(region)] }],
				autocommit
			)
			const titlesHand = yield* measureVariant(raw, titlesHandSpec, handOptions)
			const titlesHandTexts = yield* textRowsOf(raw, titlesHandSpec.statements)
			const titlesHandRows = nestedRows(titlesHandTexts, ["titles"])
			const cardsPlans = [...plansOf(cardsM.generated), ...plansOf(cardsM.conservative)]
			cases.push({
				name: "a region's accounts with one-, two- and five-field attachments",
				gates: ["R36"],
				conditions: conditions({
					workload: "Account by region with three attachments over its tasks",
					schemaState: installed,
					data: `${options.accounts} accounts in 40 regions, ${options.tasksPerAccount} tasks each, titles repeating per account`,
					parameters: { region, attachFuseMaxFields },
					semantics:
						"each account of the region with its set of titles, its (id, priority) pairs and its task sheets",
					cache: warm
				}),
				phases: {},
				variants: [
					cardsM.generated,
					cardsM.conservative,
					cardsHand,
					titlesM.generated,
					titlesM.conservative,
					titlesHand
				],
				comparisons: [
					compareVariants(cardsM.generated, cardsHand),
					compareVariants(titlesM.generated, titlesHand)
				],
				transactions: {},
				loads: {},
				measures: {
					generatedStatements: sent.length,
					titlesStatements: titlesSent.length,
					conservativeStatements: cardsM.delivered.conservative.statements.length,
					...Rec.fromEntries(
						Arr.map(Rec.toEntries(planFigures(cardsM.generated)), ([k, x]) => [`generated.${k}`, x])
					),
					...Rec.fromEntries(
						Arr.map(Rec.toEntries(planFigures(cardsM.conservative)), ([k, x]) => [
							`conservative.${k}`,
							x
						])
					),
					fusedSerializedKb: serializedKb(cardsM.generated, 0),
					handwrittenSerializedKb: serializedKb(cardsHand, 0),
					pipelinedSerializedKb: Arr.map(sheets, (sheet) =>
						serializedKb(cardsM.generated, sheet.index)
					)
				}
			})
			const r36: VerdictInput = {
				checks: [
					mechanism(
						"a one-field attachment is fused as ARRAY(SELECT ...) of its text",
						fusedAsForm(cardsParent, "ids", "array") && has(parentShape, "array subquery"),
						`fused: ${Arr.join(
							Arr.map(cardsParent.fused, (f) => `${f.name} as ${fusedForm(f.layout)}`),
							", "
						)}`
					),
					mechanism(
						"a one-field attachment whose values need deduplication is fused as well",
						titlesSent.length === 1 &&
							fusedAsForm(titlesParent, "titles", "array") &&
							has(shapeOf(titlesParent.ast), "array subquery"),
						`${titlesSent.length} statements sent; fused: ${Arr.join(
							Arr.map(titlesParent.fused, (f) => f.name),
							", "
						)}`
					),
					mechanism(
						"a two-field attachment is fused as to_jsonb objects",
						fusedAsForm(cardsParent, "priorities", "jsonb") && has(parentShape, "call to_jsonb"),
						`fused: ${Arr.join(
							Arr.map(cardsParent.fused, (f) => `${f.name} as ${fusedForm(f.layout)}`),
							", "
						)}`
					),
					mechanism(
						"a wide attachment is pipelined",
						sheets.length === 1 && Option.isNone(fusedAs(cardsParent, "sheet")),
						`${sent.length} statements sent; the sheet is statement ${Arr.join(
							Arr.map(sheets, (sheet) => String(sheet.index)),
							", "
						)}`
					),
					mechanism(
						"no plan joins outer",
						Arr.every(cardsPlans, (plan) =>
							Arr.every(joinTypes(plan), (j) => !outerJoins.includes(j))
						),
						Arr.join(
							Arr.map(cardsPlans, (plan) => Arr.join(joinTypes(plan), ", ")),
							" | "
						)
					),
					judged(
						"fused and pipelined lowerings deliver identical nested results",
						deliveredAgree("multiset"),
						cardsM.delivered.generated.rows,
						cardsM.delivered.conservative.rows
					),
					judged(
						"the deduplicating one-field attachment delivers the conservative nested result",
						deliveredAgree("multiset"),
						titlesM.delivered.generated.rows,
						titlesM.delivered.conservative.rows
					),
					judged(
						"the generated nested result agrees with the handwritten statement",
						deliveredAgree("multiset"),
						Arr.map(cardsM.delivered.generated.rows, asText),
						cardsHandRows
					),
					judged(
						"the deduplicating attachment agrees with the handwritten statement",
						deliveredAgree("multiset"),
						Arr.map(titlesM.delivered.generated.rows, asText),
						titlesHandRows
					),
					equivalence(
						"no delivered parent repeats",
						distinctParents(cardsM.delivered.generated.rows) &&
							distinctParents(titlesM.delivered.generated.rows),
						`${cardsM.delivered.generated.rows.length} and ${titlesM.delivered.generated.rows.length} parents`
					)
				]
			}

			/** R37. */
			const lo = BigInt(Math.floor(options.people / 8))
			const span = 32n
			const reach = compile(fx, reachCards, reading)
			const reachM = yield* measureQuery(
				runtime,
				raw,
				reach,
				{ lo, hi: lo + span - 1n },
				{ ...measure, explain: plainExplain, conservativeSamples: 1 }
			)
			const reachSent = reachM.delivered.generated.statements
			const reachAttachments = attachmentsOf(reach, "reach")
			const [reachAttachment] = reachAttachments
			if (reachAttachment === undefined) {
				throw new GateSetupError({ what: "the reachable sets pipeline no attachment" })
			}
			const reachChild = planOf(reachM.generated, reachAttachment.index)
			const closures = arrayTotal(reachM.delivered.generated.rows, "reach")
			const parents = reachM.delivered.generated.rows.length
			if (closures <= parents) {
				throw new GateSetupError({
					what: `${closures} reachable people for ${parents} parents, no subtree each`
				})
			}
			const edgesRead = rowsReadFrom(reachChild, follows)
			const conservativeEdges = planOf(reachM.conservative, 1)
			const edges = options.people - 1
			const P = fx.table("Person")
			const F = fx.table("Follows")
			const pc = (f: string) => fx.column("Person", f)
			const fc = (f: string) => fx.column("Follows", f)
			const reachHandSpec = handwritten(
				"handwritten: one recursive statement seeded from the range",
				[
					{
						sql:
							`WITH RECURSIVE reach(origin, person) AS (` +
							`SELECT f.${fc("from")}, f.${fc("to")} FROM ${F} AS f WHERE f.${fc("from")} BETWEEN $1::bigint AND $2::bigint ` +
							`UNION SELECT r.origin, f.${fc("to")} FROM reach AS r JOIN ${F} AS f ON f.${fc("from")} = r.person) ` +
							`SELECT p.${pc("id")}::text, to_jsonb(ARRAY(SELECT jsonb_build_object('person', r.person::text) ` +
							`FROM reach AS r WHERE r.origin = p.${pc("id")}))::text ` +
							`FROM ${P} AS p WHERE p.${pc("id")} BETWEEN $1::bigint AND $2::bigint`,
						params: [String(lo), String(lo + span - 1n)]
					}
				],
				autocommit
			)
			const reachHand = yield* measureVariant(raw, reachHandSpec, handOptions)
			const reachHandTexts = yield* textRowsOf(raw, reachHandSpec.statements)
			const reachHandRows = nestedRows(reachHandTexts, ["reach"])
			const recursionStates = Arr.reduce(
				findNodes(reachChild, "Recursive Union"),
				0,
				(n, u) => n + u.actualRows * u.actualLoops
			)
			const conservativeStates = Arr.reduce(
				findNodes(conservativeEdges, "Recursive Union"),
				0,
				(n, u) => n + u.actualRows * u.actualLoops
			)
			cases.push({
				name: "a range of tree nodes with the people each reaches",
				gates: ["R37"],
				conditions: conditions({
					workload:
						"a recursive relation of (origin, person) over follows, attached by origin to a range of people",
					schemaState: installed,
					data: `${options.people} people in a binary follows tree (i follows 2i and 2i + 1)`,
					parameters: { lo: String(lo), hi: String(lo + span - 1n) },
					semantics: "each person of the range with the set of people reachable from it",
					cache: warm
				}),
				phases: {},
				variants: [reachM.generated, reachM.conservative, reachHand],
				comparisons: [compareVariants(reachM.generated, reachHand)],
				transactions: {},
				loads: {},
				measures: {
					parents,
					closures,
					edgesRead,
					conservativeEdgesRead: rowsReadFrom(conservativeEdges, follows),
					handwrittenEdgesRead: rowsReadFrom(planOf(reachHand, 0), follows),
					recursionStates,
					conservativeStates,
					edges,
					statementsSent: reachSent.length
				}
			})
			const r37: VerdictInput = {
				checks: [
					mechanism(
						"the recursive attachment is one seeded statement",
						reachAttachments.length === 1 &&
							featureCount(shapeOf(reachAttachment.statement.ast), "with recursive") === 1,
						`${reachAttachments.length} attachment statements; ${reachSent.length} statements sent`
					),
					mechanism(
						"the recursion computes the delivered closures only",
						recursionStates === closures,
						`${recursionStates} states for ${closures} delivered`
					),
					mechanism(
						"edges read are bounded by the closures, not by the parents times the relation",
						edgesRead <= 4 * (closures + parents),
						`${edgesRead} edges read for ${parents} parents with ${closures} reachable in all, of ${edges} edges\n${outline(reachChild, 0)}`
					),
					judged(
						"the seeded statement delivers the pipelined nested result",
						deliveredAgree("multiset"),
						reachM.delivered.generated.rows,
						reachM.delivered.conservative.rows
					),
					judged(
						"the seeded statement agrees with the handwritten recursive statement",
						deliveredAgree("multiset"),
						Arr.map(reachM.delivered.generated.rows, asText),
						reachHandRows
					)
				]
			}
			return { cases, verdicts: { R36: r36, R37: r37 } }
		})
})
