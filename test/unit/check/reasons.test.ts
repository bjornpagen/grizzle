import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { codePoint, element, type Gen, int, oneOf, string } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint as bigintGen, double } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { BudgetMeter } from "#compiler/core/budget.ts"
import type { CompileError, CompileReasonTag } from "#compiler/core/errors.ts"
import { childLoc, formatLoc, type SourceLoc } from "#compiler/core/loc.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import type * as Result from "#compiler/core/result.ts"
import { assert, defined, refusalLoc, refused, succeeded } from "#test/support/assert.ts"
import {
	type AuthoredExprDesc,
	decodedMember,
	decodedQuery,
	type MemberDesc,
	type QueryDesc
} from "#test/support/fixtures/ir/desc.ts"
import { WorkDesc } from "#test/support/fixtures/ir/work.ts"
import { checking, checkMemberOf, checkOptions } from "#test/support/policy.ts"
import {
	attach,
	cast,
	eq,
	imported,
	lit,
	match,
	param,
	parent,
	queryDesc,
	ref,
	relationSource,
	rule,
	sum,
	typedLit,
	vars
} from "#test/unit/check/dsl.ts"
import { Lab, Qty } from "#test/unit/check/schemas.ts"
import { accountCards, automaticTasksFor, taskCards } from "#test/unit/check/work-queries.ts"

import { regex } from "arkregex"
/**
 * What a check must answer: a refusal for a reason at exactly the decoded location of the offending declaration, a
 * refusal for a reason below every declaration, located, or the checked result.
 */
type Expected =
	| { readonly kind: "refused at"; readonly reason: CompileReasonTag; readonly at: SourceLoc }
	| { readonly kind: "refused"; readonly reason: CompileReasonTag }
	| { readonly kind: "admitted" }

const admitted: Expected = { kind: "admitted" }
const refusedFor = (reason: CompileReasonTag): Expected => ({ kind: "refused", reason })
const refusedAt = (reason: CompileReasonTag, at: SourceLoc): Expected => ({
	kind: "refused at",
	reason,
	at
})

const answers = (
	result: Result.Result<unknown, CompileError>,
	expected: Expected,
	why: string
): void => {
	switch (expected.kind) {
		case "admitted":
			succeeded(result, why)
			return
		case "refused": {
			const e = refused(result, expected.reason, why)
			assert.ok(formatLoc(refusalLoc(e)).length > 0, `${why}: located`)
			return
		}
		case "refused at":
			assert.equal(
				formatLoc(refusalLoc(refused(result, expected.reason, why))),
				formatLoc(expected.at),
				why
			)
			return
	}
}

/** The decoded location of match `m` of arm `arm` of a decoded rules stage. */
const matchLoc = (
	stage: ReturnType<typeof decodedQuery>["stage"],
	arm: number,
	m: number
): SourceLoc => {
	assert.ok(stage.kind === "rules", "the planted stage is a rules stage")
	return defined(defined(stage.arms[arm]).matches[m]).loc
}

const tasks = (head: Parameters<typeof rule>[0]["head"]): QueryDesc =>
	queryDesc(
		rule({
			vars: vars("Task", "id", "account", "kind"),
			matches: [
				match(relationSource("Task"), { id: ref("Task", "id"), account: ref("Task", "account") })
			],
			head,
			where: [],
			interiors: [],
			attach: []
		})
	)

/** Item ids whose qty is the parameter q: Qty is a contract over integer (test/unit/check/schemas.ts). */
const itemsOfQty = queryDesc(
	rule({
		vars: vars("Item", "id"),
		matches: [match(relationSource("Item"), { id: ref("Item", "id"), qty: param("q", Qty) })],
		head: { id: ref("Item", "id") },
		where: [],
		interiors: [],
		attach: []
	})
)

/** An import of itemsOfQty, its parameter bound to `q`. */
const qtyImport = (q: AuthoredExprDesc): QueryDesc =>
	queryDesc(
		rule({
			vars: vars("X", "id"),
			matches: [match(imported(itemsOfQty, { q }), { id: ref("X", "id") })],
			head: { id: ref("X", "id") },
			where: [],
			interiors: [],
			attach: []
		})
	)

const budgetIs = (budget: Parameters<typeof lit>[0]): QueryDesc =>
	queryDesc(
		rule({
			vars: vars("AutomaticTask", "task"),
			matches: [
				match(relationSource("AutomaticTask"), {
					task: ref("AutomaticTask", "task"),
					budget: lit(budget)
				})
			],
			head: { task: ref("AutomaticTask", "task") },
			where: [],
			interiors: [],
			attach: []
		})
	)

const qtyBound = (qty: Parameters<typeof lit>[0]): QueryDesc =>
	queryDesc(
		rule({
			vars: vars("Item", "id"),
			matches: [match(relationSource("Item"), { id: ref("Item", "id"), qty: lit(qty) })],
			head: { id: ref("Item", "id") },
			where: [],
			interiors: [],
			attach: []
		})
	)

const qtyIs = (qty: Parameters<typeof lit>[0]): QueryDesc =>
	queryDesc(
		rule({
			vars: vars("Item", "id", "qty"),
			matches: [match(relationSource("Item"), { id: ref("Item", "id"), qty: ref("Item", "qty") })],
			where: [eq(ref("Item", "qty"), lit(qty))],
			head: { id: ref("Item", "id") },
			interiors: [],
			attach: []
		})
	)

const labelIs = (label: Parameters<typeof lit>[0]): QueryDesc =>
	queryDesc(
		rule({
			vars: vars("Item", "id", "label"),
			matches: [
				match(relationSource("Item"), { id: ref("Item", "id"), label: ref("Item", "label") })
			],
			where: [eq(ref("Item", "label"), lit(label))],
			head: { id: ref("Item", "id") },
			interiors: [],
			attach: []
		})
	)

const labelBound = (label: Parameters<typeof lit>[0]): QueryDesc =>
	queryDesc(
		rule({
			vars: vars("Item", "id"),
			matches: [match(relationSource("Item"), { id: ref("Item", "id"), label: lit(label) })],
			head: { id: ref("Item", "id") },
			where: [],
			interiors: [],
			attach: []
		})
	)

const int4 = { min: -(2 ** 31), max: 2 ** 31 - 1 }

/**
 * A literal at a typed slot: AutomaticTask.budget, Cents over bigint, at least 0 (Work); Item.qty, Qty over integer, at
 * least 0, bound by a match, compared by a where, or bound by an import's bind map (Lab); and Item.label, the lower-case
 * language (Lab).
 */
type Slot =
	| "Cents bound"
	| "Qty bound"
	| "Qty compared"
	| "Qty an import binds"
	| "lower-case label compared"
	| "lower-case label bound"

interface SlotLiteral {
	readonly slot: Slot
	readonly value: Parameters<typeof lit>[0]
}

const slotGen: Gen<SlotLiteral> = oneOf<SlotLiteral>([
	(source) => ({
		slot: "Cents bound",
		value: source.draw(
			oneOf<bigint | number | string>([
				bigintGen(-(2n ** 40n), 2n ** 40n),
				int(int4.min, int4.max),
				string(codePoint(0x20, 0x7e), { min: 0, max: 3 })
			])
		)
	}),
	(source) => ({
		slot: source.draw(element<Slot>(["Qty bound", "Qty compared", "Qty an import binds"])),
		value: source.draw(
			oneOf([
				int(int4.min, int4.max),
				int(2 ** 31, 2 ** 40),
				double(-Number.MAX_VALUE, Number.MAX_VALUE)
			])
		)
	}),
	(source) => ({
		slot: source.draw(element<Slot>(["lower-case label compared", "lower-case label bound"])),
		value: source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 6 }))
	})
])

/**
 * The answer the literal's type gives it: a value of another host kind or outside the base's range is no literal of
 * the base (MalformedDescription), one outside the contract or the language is ContractLiteral, else admitted. The
 * language is judged here by RegExp; the checker decides it by its own NFA.
 */
const expectedOf = (
	slot: Slot,
	value: Parameters<typeof lit>[0],
	located: (reason: CompileReasonTag) => Expected
): Expected => {
	switch (slot) {
		case "Cents bound":
			return typeof value !== "bigint"
				? located("MalformedDescription")
				: value < 0n
					? located("ContractLiteral")
					: admitted
		case "lower-case label compared":
		case "lower-case label bound":
			return typeof value === "string" && regex("^[a-z]+$", "u").test(value)
				? admitted
				: located("ContractLiteral")
		case "Qty an import binds":
		case "Qty bound":
		case "Qty compared":
			return typeof value !== "number" ||
				!Number.isInteger(value) ||
				value < int4.min ||
				value > int4.max
				? located("MalformedDescription")
				: value < 0
					? located("ContractLiteral")
					: admitted
	}
}

/**
 * The query holding the literal at its slot, and where it is refused: at the import's bind entry, a declaration, or
 * below every declaration.
 */
const literalAt = (
	slot: Slot,
	value: Parameters<typeof lit>[0]
): { readonly query: QueryDesc; readonly located: (reason: CompileReasonTag) => Expected } => {
	switch (slot) {
		case "Cents bound":
			return { query: budgetIs(value), located: refusedFor }
		case "Qty bound":
			return { query: qtyBound(value), located: refusedFor }
		case "Qty compared":
			return { query: qtyIs(value), located: refusedFor }
		case "Qty an import binds": {
			const q = qtyImport(lit(value))
			const at = childLoc(childLoc(matchLoc(decodedQuery(q.stage).stage, 0, 0), "bind"), "q")
			return { query: q, located: (reason) => refusedAt(reason, at) }
		}
		case "lower-case label compared":
			return { query: labelIs(value), located: refusedFor }
		case "lower-case label bound":
			return { query: labelBound(value), located: refusedFor }
	}
}

type LiteralFeature = Slot | "admitted" | "ContractLiteral" | "MalformedDescription"

describe("a literal at a typed slot", () => {
	it.effect(
		"is no literal of another host kind or range, refused outside its contract or language, and admitted within",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/check/reasons-literal",
						draw: drawn(slotGen),
						literal: Formatter.format,
						coverage: required<LiteralFeature>(
							[
								"Cents bound",
								"Qty bound",
								"Qty compared",
								"Qty an import binds",
								"lower-case label compared",
								"lower-case label bound",
								"admitted",
								"ContractLiteral",
								"MalformedDescription"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					({ slot, value }, c) =>
						Effect.sync(() => {
							const { query: q, located } = literalAt(slot, value)
							const expected = expectedOf(slot, value, located)
							answers(
								checkQuery(
									checking(slot === "Cents bound" ? WorkDesc : Lab),
									q,
									checkOptions("query")
								),
								expected,
								`${slot} ${Formatter.format(value)}`
							)
							c.note(slot)
							c.note(
								expected.kind === "admitted"
									? "admitted"
									: expected.reason === "ContractLiteral"
										? "ContractLiteral"
										: "MalformedDescription"
							)
						})
				)
			)
	)
})

/** A ChangeSet insert of TaskNote whose member query over Task delivers `head`. */
const noteMember = (head: Parameters<typeof rule>[0]["head"]): MemberDesc => ({
	op: "insert",
	relation: "TaskNote",
	member: {
		kind: "query",
		query: queryDesc(
			rule({
				vars: vars("Task", "id"),
				matches: [match(relationSource("Task"), { id: ref("Task", "id") })],
				head,
				where: [],
				interiors: [],
				attach: []
			})
		)
	}
})

/** The manual task's operator, attached to a task. */
const operatorChild = queryDesc(
	rule({
		vars: vars("ManualTask", "operator"),
		matches: [
			match(relationSource("ManualTask"), {
				task: parent("task"),
				operator: ref("ManualTask", "operator")
			})
		],
		head: { operator: ref("ManualTask", "operator") },
		where: [],
		interiors: [],
		attach: []
	})
)

/** Notes of tasks with `attachments` on the arm. */
const notes = (attachments: ReadonlyArray<{ readonly name: string; readonly child: QueryDesc }>) =>
	queryDesc(
		rule({
			vars: vars("Task", "id"),
			matches: [match(relationSource("Task"), { id: ref("Task", "id") })],
			head: { task: ref("Task", "id"), note: lit("n") },
			attach: attachments,
			where: [],
			interiors: []
		})
	)

const insertNote = (q: QueryDesc): MemberDesc => ({
	op: "insert",
	relation: "TaskNote",
	member: { kind: "query", query: q }
})

const integer = { kind: "pg", type: "integer" } as const
const bigint = { kind: "pg", type: "bigint" } as const

/** A check of a planted description (the generator emits only well-formed programs), with what it must answer. */
interface Planted {
	readonly what: string
	readonly check: () => Result.Result<unknown, CompileError>
	readonly expected: () => Expected
}

const arm = (extra: boolean) =>
	rule({
		vars: vars("Task", "id", "account"),
		matches: [
			match(relationSource("Task"), {
				id: ref("Task", "id"),
				account: ref("Task", "account"),
				kind: lit("Manual")
			})
		],
		head: extra
			? { id: ref("Task", "id"), kind: lit("Manual"), account: ref("Task", "account") }
			: { id: ref("Task", "id"), kind: lit("Manual") },
		where: [],
		interiors: [],
		attach: []
	})

const planted: Arr.NonEmptyReadonlyArray<Planted> = [
	{
		what: "MissingDiscriminant: arms of different headings whose literals coincide",
		check: () =>
			checkQuery(checking(WorkDesc), queryDesc(arm(false), arm(true)), checkOptions("query")),
		expected: () => refusedFor("MissingDiscriminant")
	},
	...(() => {
		const q = attach(
			tasks({ id: ref("Task", "id") }),
			"notes",
			queryDesc(
				rule({
					vars: vars("TaskNote", "task", "note"),
					matches: [
						match(relationSource("TaskNote"), {
							task: ref("TaskNote", "task"),
							note: ref("TaskNote", "note")
						})
					],
					head: { note: ref("TaskNote", "note") },
					where: [],
					interiors: [],
					attach: []
				})
			)
		)
		return [
			{
				what: "AttachedParentUnbound: a child that binds no parent variable, at the attachment",
				check: () => checkQuery(checking(WorkDesc), q, checkOptions("query")),
				expected: () => {
					const decoded = decodedQuery(q.stage).stage
					assert.ok(decoded.kind === "attach", "the planted stage is an attachment")
					return refusedAt("AttachedParentUnbound", decoded.attach.loc)
				}
			}
		]
	})(),
	...Arr.map(
		[
			noteMember({ task: ref("Task", "id") }),
			noteMember({ task: ref("Task", "id"), note: lit("n"), extra: lit(1) })
		],
		(member, i) => ({
			what: `DescribedHeadingMismatch: a member head ${i === 0 ? "narrower" : "wider"} than its relation's heading, at the member`,
			check: () => checkMemberOf(checking(WorkDesc), member, {}),
			expected: () => refusedAt("DescribedHeadingMismatch", decodedMember(member).loc)
		})
	),
	{
		what: "a member head of its relation's heading",
		check: () =>
			checkMemberOf(
				checking(WorkDesc),
				noteMember({ task: ref("Task", "id"), note: lit("n") }),
				{}
			),
		expected: () => admitted
	},
	(() => {
		/** A sum is numeric: re-entering the Cents contract of AutomaticTask.budget needs Compute.cast. */
		const budgets: MemberDesc = {
			op: "put",
			relation: "AutomaticTask",
			member: {
				kind: "query",
				query: queryDesc(
					rule({
						vars: vars("AutomaticTask", "task", "budget"),
						matches: [
							match(relationSource("AutomaticTask"), {
								task: ref("AutomaticTask", "task"),
								budget: ref("AutomaticTask", "budget")
							})
						],
						head: {
							task: ref("AutomaticTask", "task"),
							budget: sum(ref("AutomaticTask", "budget"))
						},
						where: [],
						interiors: [],
						attach: []
					})
				)
			}
		}
		return {
			what: "DescribedHeadingMismatch: a sum into a contract field, at the member",
			check: () => checkMemberOf(checking(WorkDesc), budgets, {}),
			expected: () => refusedAt("DescribedHeadingMismatch", decodedMember(budgets).loc)
		}
	})(),
	(() => {
		/** An attachment adds a field to the result: refused where it is attached, a stage of the member query. */
		const staged = insertNote(attach(notes([]), "extra", operatorChild))
		return {
			what: "DescribedHeadingMismatch: a member query's attach stage, at the attachment",
			check: () => checkMemberOf(checking(WorkDesc), staged, {}),
			expected: () => {
				const m = decodedMember(staged).member
				assert.ok(
					m.kind === "query" && m.query.stage.kind === "attach",
					"the planted member reads an attachment"
				)
				return refusedAt("DescribedHeadingMismatch", m.query.stage.attach.loc)
			}
		}
	})(),
	(() => {
		const armed = insertNote(notes([{ name: "extra", child: operatorChild }]))
		return {
			what: "DescribedHeadingMismatch: a member arm's attachment, at the attachment",
			check: () => checkMemberOf(checking(WorkDesc), armed, {}),
			expected: () => {
				const m = decodedMember(armed).member
				assert.ok(
					m.kind === "query" && m.query.stage.kind === "rules",
					"the planted member reads a rules stage"
				)
				return refusedAt(
					"DescribedHeadingMismatch",
					defined(defined(m.query.stage.arms[0]).attach[0]).loc
				)
			}
		}
	})(),
	{
		what: "the same attachment read on its own",
		check: () =>
			checkQuery(
				checking(WorkDesc),
				attach(notes([]), "extra", operatorChild),
				checkOptions("query")
			),
		expected: () => admitted
	},
	(() => {
		/**
		 * A variable no rule declares, read by a match binding: the structural pass refuses it before the checker runs,
		 * at the location the checker reports for its own refusal of the same entry.
		 */
		const binding = queryDesc(
			rule({
				vars: vars("Item", "id"),
				matches: [
					match(relationSource("Item"), { id: ref("Item", "id"), qty: ref("Other", "qty") })
				],
				head: { id: ref("Item", "id") },
				where: [],
				interiors: [],
				attach: []
			})
		)
		return {
			what: "an undeclared variable in a match binding, at the binding",
			check: () => checkQuery(checking(Lab), binding, checkOptions("query")),
			expected: () =>
				refusedAt(
					"MalformedDescription",
					childLoc(childLoc(matchLoc(decodedQuery(binding.stage).stage, 0, 0), "bindings"), "qty")
				)
		}
	})(),
	(() => {
		const stray = qtyImport(ref("Other", "id"))
		return {
			what: "an undeclared variable in an import's bind map, at the bind entry",
			check: () => checkQuery(checking(Lab), stray, checkOptions("query")),
			expected: () =>
				refusedAt(
					"MalformedDescription",
					childLoc(childLoc(matchLoc(decodedQuery(stray.stage).stage, 0, 0), "bind"), "q")
				)
		}
	})(),
	{
		what: "DuplicateIdentity: a query declaring the schema's contract name with another descriptor",
		check: () =>
			checkQuery(
				checking(WorkDesc),
				tasks({
					id: ref("Task", "id"),
					n: cast(typedLit(1, integer), {
						kind: "contract",
						name: "Cents",
						base: integer,
						predicate: undefined,
						facts: []
					})
				}),
				checkOptions("query")
			),
		expected: () => refusedFor("DuplicateIdentity")
	},
	{
		what: "DuplicateIdentity: one contract name declared with two descriptors",
		check: () =>
			checkQuery(
				checking(WorkDesc),
				tasks({
					a: cast(typedLit(1, integer), {
						kind: "contract",
						name: "Fresh",
						base: integer,
						predicate: undefined,
						facts: []
					}),
					b: cast(typedLit(1n, bigint), {
						kind: "contract",
						name: "Fresh",
						base: bigint,
						predicate: undefined,
						facts: []
					})
				}),
				checkOptions("query")
			),
		expected: () => refusedFor("DuplicateIdentity")
	},
	{
		/** The schema's own descriptor of Cents is the contract, not a second declaration of it. */
		what: "the schema's own contract descriptor",
		check: () =>
			checkQuery(
				checking(WorkDesc),
				tasks({
					n: cast(typedLit(1n, bigint), {
						kind: "contract",
						name: "Cents",
						base: bigint,
						predicate: {
							kind: "compare",
							op: "ge",
							left: { kind: "value" },
							right: { kind: "literal", value: 0n, type: undefined }
						},
						facts: []
					})
				}),
				checkOptions("query")
			),
		expected: () => admitted
	}
]

describe("checker diagnostics", () => {
	it.effect(
		"refuse each planted description with its reason, a declaration at its decoded location, and admit its counterpart",
		(ctx) => {
			type Answer = Expected["kind"]
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/check/reasons-planted",
						generator: element(planted),
						literal: Formatter.format,
						limit: planted.length,
						coverage: requiredInSpace<Answer>(["refused at", "refused", "admitted"]),
						caseHang: Duration.minutes(2)
					},
					(p, c) =>
						Effect.sync(() => {
							const expected = p.expected()
							answers(p.check(), expected, p.what)
							c.note(expected.kind)
						})
				)
			)
		}
	)

	it.effect(
		"refuse a check that crosses a budget with ResourceBound, and admit it at exactly what it charges",
		(ctx) => {
			type Bound = "below what it charges" | "exactly what it charges"
			const budgetKinds = ["nodes"] as const
			const programs = [
				{ name: "taskCards", query: taskCards },
				{ name: "automaticTasksFor", query: automaticTasksFor },
				{ name: "accountCards", query: accountCards }
			] as const
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/check/reasons-budget",
						generator: (source) =>
							[
								source.draw(element<(typeof programs)[number]>(programs)),
								source.draw(element(budgetKinds)),
								source.draw(element<Bound>(["below what it charges", "exactly what it charges"]))
							] as const,
						literal: Formatter.format,
						limit: programs.length * budgetKinds.length * 2,
						coverage: requiredInSpace<Bound>(["below what it charges", "exactly what it charges"]),
						caseHang: Duration.minutes(2)
					},
					([p, kind, bound], c) =>
						Effect.sync(() => {
							const ample = new BudgetMeter(compileBudgets)
							succeeded(
								checkQuery(checking(WorkDesc), p.query, { ...checkOptions("query"), meter: ample }),
								p.name
							)
							const charged = ample.used(kind)
							if (bound === "below what it charges" && charged === 0) {
								return
							}
							const limit = bound === "exactly what it charges" ? charged : charged - 1
							const meter = new BudgetMeter({ ...compileBudgets, [kind]: limit })
							answers(
								checkQuery(checking(WorkDesc), p.query, { ...checkOptions("query"), meter }),
								bound === "exactly what it charges" ? admitted : refusedFor("ResourceBound"),
								`${p.name} ${kind} ${bound}`
							)
							c.note(bound)
						})
				)
			)
		}
	)
})
