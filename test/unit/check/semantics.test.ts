import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { codePoint, element, int, oneOf, string } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { double } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { BudgetMeter } from "#compiler/core/budget.ts"
import type { CompileError, CompileReasonTag } from "#compiler/core/errors.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import type * as Result from "#compiler/core/result.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { exprClosure } from "#compiler/ir/expr.ts"
import { type LogicalQuery, paramColumns } from "#compiler/ir/products.ts"
import { exprsOf } from "#compiler/ir/rel.ts"
import { typeLabel } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput } from "#compiler/lower/conservative/types.ts"
import { assert, defined, refused, succeeded } from "#test/support/assert.ts"
import {
	f,
	type MemberDesc,
	type QueryDesc,
	type RuleDesc
} from "#test/support/fixtures/ir/desc.ts"
import { WorkDesc } from "#test/support/fixtures/ir/work.ts"
import { localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
import { checking, checkMemberOf, checkOptions, checkReadBackOf } from "#test/support/policy.ts"
import {
	compute,
	count,
	delta,
	eq,
	gt,
	imported,
	lit,
	match,
	not,
	orderBy,
	param,
	parent,
	plainVar,
	queryDesc,
	ref,
	relationSource,
	rule,
	take,
	typedLit,
	varRef,
	vars
} from "#test/unit/check/dsl.ts"
import { Code, Lab, Lower, Qty } from "#test/unit/check/schemas.ts"
import { taskPayloads } from "#test/unit/check/work-queries.ts"

/** The conservative program of a checked query, which must lower. */
const lowers = (q: LogicalQuery): void => {
	succeeded(
		lowerConservative(conservativeInput(q), {
			names: productionNames("lab", { kind: "declared" }, localVectorSchema),
			params: q.params,
			subject: { kind: "query" },
			meter: new BudgetMeter(compileBudgets)
		}),
		"the admitted query lowers"
	)
}

/** Lab's items, with `parts` of the rule beside its Item match. */
const items = (parts: Pick<RuleDesc, "where" | "head">): QueryDesc =>
	queryDesc(
		rule({
			vars: vars("Item", "id", "label", "qty", "price", "during", "color"),
			matches: [
				match(relationSource("Item"), {
					id: ref("Item", "id"),
					label: ref("Item", "label"),
					qty: ref("Item", "qty")
				})
			],
			where: parts.where,
			head: parts.head,
			interiors: [],
			attach: []
		})
	)

/** A parameter of the checked result: its name, its type's label, and the regex of a text type. */
interface Param {
	readonly name: string
	readonly type: string
}

const paramsOf = (q: LogicalQuery): ReadonlyArray<Param> =>
	Arr.map(q.params, (p) => ({
		name: p.name,
		type: typeLabel(defined(paramColumns(p)[0], `the type of ${p.name}`).type)
	}))

/** What a planted check must answer: a refusal for a reason, or the checked result with exactly these parameters. */
type Expected =
	| { readonly kind: "refused"; readonly reason: CompileReasonTag }
	| {
			readonly kind: "admitted"
			readonly params: ReadonlyArray<Param>
			readonly also: ReadonlyArray<(q: LogicalQuery) => void>
	  }
	| { readonly kind: "a read-back admitted" }

const refusedFor = (reason: CompileReasonTag): Expected => ({ kind: "refused", reason })
const admittedWith = (
	params: ReadonlyArray<Param>,
	...also: ReadonlyArray<(q: LogicalQuery) => void>
): Expected => ({
	kind: "admitted",
	params,
	also
})

const lab = (q: QueryDesc) => () => checkQuery(checking(Lab), q, checkOptions("query"))
const work = (q: QueryDesc) => () => checkQuery(checking(WorkDesc), q, checkOptions("query"))

const byColor = queryDesc(
	rule({
		vars: vars("Item", "id"),
		matches: [
			match(relationSource("Item"), {
				id: ref("Item", "id"),
				color: param("c", f.closedId("Color"))
			})
		],
		where: [],
		head: { id: ref("Item", "id") },
		interiors: [],
		attach: []
	})
)

/** Both arms carry k = "z": the discriminant is (k, tag), and tag alone tells the arms apart. */
const tagged = queryDesc(
	rule({
		vars: vars("Task", "id", "account"),
		matches: [
			match(relationSource("Task"), {
				id: ref("Task", "id"),
				account: ref("Task", "account"),
				kind: lit("Automatic")
			})
		],
		where: [],
		head: { id: ref("Task", "id"), tag: lit("a"), k: lit("z"), account: ref("Task", "account") },
		interiors: [],
		attach: []
	}),
	rule({
		vars: [...vars("Task", "id"), ...vars("ManualTask", "operator")],
		matches: [
			match(relationSource("Task"), { id: ref("Task", "id"), kind: lit("Manual") }),
			match(relationSource("ManualTask"), {
				task: ref("Task", "id"),
				operator: ref("ManualTask", "operator")
			})
		],
		where: [],
		head: {
			id: ref("Task", "id"),
			tag: lit("b"),
			k: lit("z"),
			operator: ref("ManualTask", "operator")
		},
		interiors: [],
		attach: []
	})
)

/** A match of `tagged` binding `bindings` and finding `head`. */
const pick = (bindings: Parameters<typeof match>[1], head: RuleDesc["head"]) =>
	queryDesc(
		rule({
			vars: [plainVar("i"), plainVar("x")],
			matches: [match(imported(tagged, {}), bindings)],
			where: [],
			head,
			interiors: [],
			attach: []
		})
	)

/** A Task arm of kind `kind`, delivering account when `extra`, with the notes attached when `attached`. */
const taskArm = (kind: string, extra: boolean, attached: boolean) =>
	rule({
		vars: vars("Task", "id", "account"),
		matches: [
			match(relationSource("Task"), {
				id: ref("Task", "id"),
				account: ref("Task", "account"),
				kind: lit(kind)
			})
		],
		where: [],
		head: extra
			? { id: ref("Task", "id"), kind: lit(kind), account: ref("Task", "account") }
			: { id: ref("Task", "id"), kind: lit(kind) },
		interiors: [],
		attach: attached
			? [
					{
						name: "notes",
						child: queryDesc(
							rule({
								vars: vars("TaskNote", "note"),
								matches: [
									match(relationSource("TaskNote"), {
										task: parent("id"),
										note: ref("TaskNote", "note")
									})
								],
								where: [],
								head: { note: ref("TaskNote", "note") },
								interiors: [],
								attach: []
							})
						)
					}
				]
			: []
	})

/**
 * Items not in `source` whose column is fixed to the parameter p (Wide's numeric typmod price, or Tag's regex label).
 */
const negatedFixed = (source: "Wide" | "Tag", column: "price" | "label") =>
	items({
		where: [
			not(relationSource(source), {
				[source === "Wide" ? "id" : "item"]: ref("Item", "id"),
				[column]: param("p", source === "Wide" ? f.unconstrainedNumeric : Code)
			})
		],
		head: { id: ref("Item", "id") }
	})

/** Items not counted under a computed amount: the bigint 1 plus p, which an import binds. */
const computedNegation = queryDesc(
	rule({
		vars: vars("Item", "id"),
		matches: [match(relationSource("Item"), { id: ref("Item", "id") })],
		where: [
			not(relationSource("Entry"), {
				amount: compute("add", typedLit(1n, f.bigint), param("p", f.bigint))
			})
		],
		head: { id: ref("Item", "id") },
		interiors: [],
		attach: []
	})
)

/** The noted tasks of an account, and the tasks of a rule not among them, the import bound by `acct`. */
const notedOf = queryDesc(
	rule({
		vars: vars("Task", "id"),
		matches: [
			match(relationSource("Task"), { id: ref("Task", "id"), account: param("acct", f.uuid) }),
			match(relationSource("TaskNote"), { task: ref("Task", "id") })
		],
		where: [],
		head: { task: ref("Task", "id") },
		interiors: [],
		attach: []
	})
)

const unnoted = (acct: Parameters<typeof imported>[1]) =>
	queryDesc(
		rule({
			vars: vars("Task", "id", "account"),
			matches: [
				match(relationSource("Task"), { id: ref("Task", "id"), account: ref("Task", "account") })
			],
			where: [not(imported(notedOf, acct), { task: ref("Task", "id") })],
			head: { id: ref("Task", "id") },
			interiors: [],
			attach: []
		})
	)

/** An insert of Entry rows from Lab's items, each arm an amount literal. */
const entryArm = (amount: bigint): RuleDesc =>
	rule({
		vars: vars("Item", "id"),
		matches: [match(relationSource("Item"), { id: ref("Item", "id") })],
		where: [],
		head: { item: ref("Item", "id"), amount: lit(amount) },
		interiors: [],
		attach: []
	})

const entryMember = (q: QueryDesc, op: MemberDesc["op"]): MemberDesc => ({
	op,
	relation: "Entry",
	member: { kind: "query", query: q }
})

const addedEntries = queryDesc(
	rule({
		vars: vars("Entry", "entry"),
		matches: [match(delta("added", "Entry"), { entry: ref("Entry", "entry") })],
		where: [],
		head: { entry: ref("Entry", "entry") },
		interiors: [],
		attach: []
	})
)

interface Planted {
	readonly what: string
	readonly check: () => Result.Result<LogicalQuery | undefined, CompileError>
	readonly expected: Expected
}

const planted: Arr.NonEmptyReadonlyArray<Planted> = [
	{
		/**
		 * A parameter bound to regex text is filtered as plain text; the program's parameter keeps the column's language.
		 */
		what: "a parameter bound to regex text keeps its column's language",
		check: lab(
			queryDesc(
				rule({
					vars: vars("Item", "id"),
					matches: [
						match(relationSource("Item"), { id: ref("Item", "id"), label: param("label", Lower) })
					],
					where: [],
					head: { id: ref("Item", "id") },
					interiors: [],
					attach: []
				})
			)
		),
		expected: admittedWith([{ name: "label", type: "text ~ /^[a-z]+$/u" }])
	},
	{
		what: "one parameter used twice is one parameter",
		check: lab(
			items({
				where: [eq(ref("Item", "qty"), param("n", Qty)), gt(ref("Item", "qty"), param("n", Qty))],
				head: { id: ref("Item", "id") }
			})
		),
		expected: admittedWith([{ name: "n", type: "contract Qty over integer" }])
	},
	{
		what: "one parameter declared at incompatible types",
		check: lab(
			items({
				where: [eq(ref("Item", "qty"), param("x", Qty)), eq(ref("Item", "id"), param("x", f.uuid))],
				head: { id: ref("Item", "id") }
			})
		),
		expected: refusedFor("MalformedDescription")
	},
	{
		what: "take's parameter joins as integer",
		check: lab(
			take(
				orderBy(items({ where: [], head: { id: ref("Item", "id"), qty: ref("Item", "qty") } }), [
					"qty",
					"desc"
				]),
				"k"
			)
		),
		expected: admittedWith([{ name: "k", type: "integer" }])
	},
	{
		what: "a head parameter of its declared type, in arms that also bind it",
		check: lab(
			queryDesc(
				rule({
					vars: vars("Item", "id"),
					matches: [match(relationSource("Item"), { id: ref("Item", "id") })],
					where: [],
					head: { asked: param("who", f.uuid) },
					interiors: [],
					attach: []
				}),
				rule({
					vars: vars("Item", "id"),
					matches: [match(relationSource("Item"), { id: param("who", f.uuid) })],
					where: [],
					head: { asked: param("who", f.uuid) },
					interiors: [],
					attach: []
				})
			)
		),
		expected: admittedWith([{ name: "who", type: "uuid" }])
	},
	{
		what: "a head parameter no other use types, of its declared type",
		check: lab(items({ where: [], head: { asked: param("who", f.uuid) } })),
		expected: admittedWith([{ name: "who", type: "uuid" }])
	},
	{
		what: "two imports binding one parameter name differently, hygienically",
		check: lab(
			queryDesc(
				rule({
					vars: [plainVar("a"), plainVar("b")],
					matches: [
						match(imported(byColor, { c: lit("red") }), { id: varRef("a") }),
						match(imported(byColor, { c: param("other", f.closedId("Color")) }), {
							id: varRef("b")
						})
					],
					where: [],
					head: { a: varRef("a"), b: varRef("b") },
					interiors: [],
					attach: []
				})
			)
		),
		expected: admittedWith([{ name: "other", type: "enum Color" }])
	},
	{
		what: "a match of a union of different headings binding an arm's field without its discriminant",
		check: work(
			queryDesc(
				rule({
					vars: [plainVar("o")],
					matches: [match(imported(taskPayloads, {}), { operator: varRef("o") })],
					where: [],
					head: { operator: varRef("o") },
					interiors: [],
					attach: []
				})
			)
		),
		expected: refusedFor("MalformedDescription")
	},
	{
		what: "bound discriminant literals selecting an arm that lacks the field",
		check: work(
			pick(
				{ id: varRef("i"), tag: lit("b"), account: varRef("x") },
				{ id: varRef("i"), account: varRef("x") }
			)
		),
		expected: refusedFor("MalformedDescription")
	},
	{
		what: "bound discriminant literals selecting no arm",
		check: work(
			pick(
				{ id: varRef("i"), k: lit("y"), account: varRef("x") },
				{ id: varRef("i"), account: varRef("x") }
			)
		),
		expected: refusedFor("MalformedDescription")
	},
	{
		what: "a shared literal column alone, selecting both arms, which do not all deliver the field",
		check: work(
			pick(
				{ id: varRef("i"), k: lit("z"), account: varRef("x") },
				{ id: varRef("i"), account: varRef("x") }
			)
		),
		expected: refusedFor("MalformedDescription")
	},
	{
		what: "the arm a bound discriminant selects, its own fields read",
		check: work(
			pick(
				{ id: varRef("i"), tag: lit("a"), account: varRef("x") },
				{ id: varRef("i"), account: varRef("x") }
			)
		),
		expected: admittedWith([])
	},
	{
		what: "arms of one heading whose column types are incompatible",
		check: lab(
			queryDesc(
				rule({
					vars: vars("Item", "id"),
					matches: [match(relationSource("Item"), { id: ref("Item", "id") })],
					where: [],
					head: { x: ref("Item", "id") },
					interiors: [],
					attach: []
				}),
				rule({
					vars: vars("Item", "qty"),
					matches: [match(relationSource("Item"), { qty: ref("Item", "qty") })],
					where: [],
					head: { x: ref("Item", "qty") },
					interiors: [],
					attach: []
				})
			)
		),
		expected: refusedFor("MalformedDescription")
	},
	{
		what: "an arm attaching before it joins a union of different headings",
		check: work(queryDesc(taskArm("Automatic", false, true), taskArm("Manual", true, false))),
		expected: admittedWith([])
	},
	{
		/** Two arms of one heading: a fact could come from either, so which attachment it carries is undetermined. */
		what: "an attachment on one of several arms of one heading",
		check: work(queryDesc(taskArm("Automatic", false, true), taskArm("Manual", false, false))),
		expected: refusedFor("UnsupportedOperation")
	},
	{
		/** A parameter at a typmod would round the value it is compared with: it binds unconstrained. */
		what: "a negated source's numeric typmod column fixed to a parameter, unconstrained",
		check: lab(negatedFixed("Wide", "price")),
		expected: admittedWith([{ name: "p", type: "numeric" }])
	},
	{
		what: "a negated source's regex column fixed to a parameter, which keeps the column's language",
		check: lab(negatedFixed("Tag", "label")),
		expected: admittedWith([{ name: "p", type: "text ~ /^[a-z0-9]{1,32}$/u" }])
	},
	{
		what: "a computed negation binding over a parameter an import binds to an outer variable",
		check: lab(
			queryDesc(
				rule({
					vars: [...vars("Entry", "amount"), plainVar("x")],
					matches: [
						match(relationSource("Entry"), { amount: ref("Entry", "amount") }),
						match(imported(computedNegation, { p: ref("Entry", "amount") }), { id: varRef("x") })
					],
					where: [],
					head: { id: varRef("x") },
					interiors: [],
					attach: []
				})
			)
		),
		expected: refusedFor("UnsupportedOperation")
	},
	{
		/** Bound to the importer's own parameter, the same computed binding is a constant of the negation. */
		what: "the computed negation binding over the importer's own parameter",
		check: lab(
			queryDesc(
				rule({
					vars: [plainVar("x")],
					matches: [
						match(imported(computedNegation, { p: param("outer", f.bigint) }), { id: varRef("x") })
					],
					where: [],
					head: { id: varRef("x") },
					interiors: [],
					attach: []
				})
			)
		),
		expected: admittedWith([{ name: "outer", type: "bigint" }])
	},
	{
		what: "a negated import bound to the rule's account, which the head projects away",
		check: work(unnoted({ acct: ref("Task", "account") })),
		expected: admittedWith([])
	},
	{
		what: "a negated import bound to a parameter",
		check: work(unnoted({ acct: param("a", f.uuid) })),
		expected: admittedWith([{ name: "a", type: "uuid" }])
	},
	{
		what: "a negated import bound to a literal",
		check: work(unnoted({ acct: lit("6f1c3a52-0c4e-4b1e-9a51-1c2f3e4d5a6b") })),
		expected: admittedWith([])
	},
	{
		what: "a negated import bound to a parameter an enclosing import binds to an outer variable",
		check: work(
			queryDesc(
				rule({
					vars: [...vars("Account", "id"), plainVar("t")],
					matches: [
						match(relationSource("Account"), { id: ref("Account", "id") }),
						match(imported(unnoted({ acct: param("a", f.uuid) }), { a: ref("Account", "id") }), {
							id: varRef("t")
						})
					],
					where: [],
					head: { account: ref("Account", "id"), task: varRef("t") },
					interiors: [],
					attach: []
				})
			)
		),
		expected: admittedWith([])
	},
	{
		what: "one variable bound to columns of different numeric typmods",
		check: lab(
			queryDesc(
				rule({
					vars: [...vars("Item", "id", "price"), ...vars("Wide", "id")],
					matches: [
						match(relationSource("Item"), { id: ref("Item", "id"), price: ref("Item", "price") }),
						match(relationSource("Wide"), { id: ref("Wide", "id"), price: ref("Item", "price") })
					],
					where: [],
					head: { id: ref("Item", "id"), wide: ref("Wide", "id") },
					interiors: [],
					attach: []
				})
			)
		),
		expected: admittedWith([])
	},
	{
		what: "an aggregate-only head with a constant beside it",
		check: lab(items({ where: [], head: { n: count(), kind: lit("all") } })),
		expected: admittedWith([])
	},
	{
		what: "an insert member of one arm of its relation's heading",
		check: () => checkMemberOf(checking(Lab), entryMember(queryDesc(entryArm(1n)), "insert"), {}),
		expected: admittedWith([])
	},
	{
		what: "an insert member of two arms of its relation's heading",
		check: () =>
			checkMemberOf(
				checking(Lab),
				entryMember(queryDesc(entryArm(1n), entryArm(2n)), "insert"),
				{}
			),
		expected: admittedWith([])
	},
	{
		/**
		 * The arms' amounts discriminate them, so the checker admits the union, and the member refuses its two headings.
		 */
		what: "an insert member of two headings",
		check: () => {
			const second = entryArm(2n)
			return checkMemberOf(
				checking(Lab),
				entryMember(
					queryDesc(entryArm(1n), { ...second, head: { ...second.head, entry: lit(7n) } }),
					"insert"
				),
				{}
			)
		},
		expected: refusedFor("DescribedHeadingMismatch")
	},
	{
		what: "an insert member's parameter, of its declared type and written as the domain",
		check: () =>
			checkMemberOf(
				checking(Lab),
				entryMember(
					queryDesc(
						rule({
							vars: vars("Item", "id"),
							matches: [match(relationSource("Item"), { id: ref("Item", "id") })],
							where: [],
							head: { item: ref("Item", "id"), amount: param("amount", f.bigint) },
							interiors: [],
							attach: []
						})
					),
					"insert"
				),
				{}
			),
		expected: admittedWith([{ name: "amount", type: "bigint" }], (q) =>
			assert.ok(
				Arr.some(
					exprClosure(Arr.flatMap(topoOrder(q.dag), (n) => exprsOf(n))),
					(e) => e.kind === "param" && e.role === "write"
				),
				"a write parameter"
			)
		)
	},
	{
		/** A put names every field: the serial field the insert omits is missing. */
		what: "a put omitting its relation's serial field",
		check: () =>
			checkMemberOf(
				checking(Lab),
				entryMember(
					queryDesc(
						rule({
							vars: vars("Item", "id"),
							matches: [match(relationSource("Item"), { id: ref("Item", "id") })],
							where: [],
							head: { item: ref("Item", "id"), amount: param("amount", f.bigint) },
							interiors: [],
							attach: []
						})
					),
					"put"
				),
				{}
			),
		expected: refusedFor("DescribedHeadingMismatch")
	},
	{
		/**
		 * The check does not depend on what the ChangeSet writes: over a relation it does not write, the delta is empty.
		 */
		what: "a read-back of an ordinary relation's delta",
		check: () => checkReadBackOf(checking(Lab), { name: "added", query: addedEntries }, {}),
		expected: { kind: "a read-back admitted" }
	},
	{
		what: "a query reading a delta outside a read-back",
		check: lab(addedEntries),
		expected: refusedFor("MalformedDescription")
	},
	{
		/** A closed relation is never written, so it has no delta. */
		what: "a read-back of a closed relation's delta",
		check: () =>
			checkReadBackOf(
				checking(Lab),
				{
					name: "colors",
					query: queryDesc(
						rule({
							vars: vars("Color", "id"),
							matches: [match(delta("removed", "Color"), { id: ref("Color", "id") })],
							where: [],
							head: { id: ref("Color", "id") },
							interiors: [],
							attach: []
						})
					)
				},
				{}
			),
		expected: refusedFor("MalformedDescription")
	}
]

describe("the checker's binding, typing and scope rules", () => {
	it.effect(
		"refuse each planted description with its reason, and type and lower each admitted one",
		(ctx) => {
			type Answer = Expected["kind"]
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/check/semantics-planted",
						generator: element(planted),
						literal: Formatter.format,
						limit: planted.length,
						coverage: requiredInSpace<Answer>(["refused", "admitted", "a read-back admitted"]),
						caseHang: Duration.minutes(2)
					},
					(p, c) =>
						Effect.sync(() => {
							const r = p.check()
							switch (p.expected.kind) {
								case "refused":
									refused(r, p.expected.reason, p.what)
									break
								case "a read-back admitted":
									defined(succeeded(r, p.what), `${p.what}: a checked read-back`)
									break
								case "admitted": {
									const q = defined(succeeded(r, p.what), `${p.what}: a checked query`)
									assert.deepEqual(paramsOf(q), p.expected.params, p.what)
									for (const also of p.expected.also) {
										also(q)
									}
									lowers(q)
									break
								}
							}
							c.note(p.expected.kind)
						})
				)
			)
		}
	)

	it.effect(
		"bound take's parameter, which an import binds to a literal, by int4's positive range",
		(ctx) => {
			const top = take(
				orderBy(items({ where: [], head: { id: ref("Item", "id"), qty: ref("Item", "qty") } }), [
					"qty",
					"desc"
				]),
				"k"
			)
			type Bound = "within" | "outside"
			return searched(
				ctx,
				explore(
					{
						suite: "unit/check/semantics-take-bound",
						draw: drawn(
							oneOf<number | string>([
								element([0, 1, 2 ** 31 - 1, 2 ** 31, -1, 1.5, "3"]),
								int(1, 2 ** 31 - 1),
								int(-(2 ** 40), 0),
								int(2 ** 31, 2 ** 40),
								double(-Number.MAX_VALUE, Number.MAX_VALUE),
								string(codePoint(0x20, 0x7e), { min: 0, max: 3 })
							])
						),
						literal: Formatter.format,
						coverage: required<Bound>(["within", "outside"], { cases: 60, sense: notesOnly }),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					(bound, c) =>
						Effect.sync(() => {
							const importer = queryDesc(
								rule({
									vars: [plainVar("i")],
									matches: [match(imported(top, { k: lit(bound) }), { id: varRef("i") })],
									where: [],
									head: { id: varRef("i") },
									interiors: [],
									attach: []
								})
							)
							const r = checkQuery(checking(Lab), importer, checkOptions("query"))
							const within =
								typeof bound === "number" &&
								Number.isInteger(bound) &&
								bound >= 1 &&
								bound <= 2 ** 31 - 1
							if (within) {
								lowers(defined(succeeded(r, String(bound)), "a checked query"))
							} else {
								refused(r, "MalformedDescription", String(bound))
							}
							c.note(within ? "within" : "outside")
						})
				)
			)
		}
	)
})
