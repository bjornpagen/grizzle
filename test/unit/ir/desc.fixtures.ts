/** What the properties of desc.test.ts read: its spaces, models and helpers. */

import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	codePoint,
	element,
	type Gen,
	int,
	map,
	oneOf,
	option,
	string
} from "@bjornpagen/testing/gen"
import {
	type Corrupted,
	corrupted,
	type CorruptedFeature,
	type Corruption
} from "@bjornpagen/testing/lsw"
import { bigint, float } from "@bjornpagen/testing/values"
import { regex } from "arkregex"
import { Array as Arr, Option, pipe, Record as Rec, String as Str } from "effect"
import { type Canonicalizable, canonicalTag, type Json } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isRecord } from "#compiler/core/record.ts"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { MoneyText, VectorText } from "#compiler/ir/carriers.ts"
import { DecimalText } from "#compiler/ir/decimal.ts"
import {
	type ComputeFn,
	computeFns,
	declaredNaming,
	decodeDesc,
	type DescKind,
	descText,
	descToJson,
	everyFact,
	type FieldDecl,
	type FieldDesc,
	type LiteralDesc
} from "#compiler/ir/desc.ts"
import { numericMaxPrecision } from "#compiler/scalar/values/fault.ts"
import { binary32LeastExponent } from "#compiler/scalar/values/float.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { admitSchemaDesc } from "#compiler/schema/admit.ts"
import { succeeded } from "#test/support/assert.ts"
import { descFromJson } from "#test/support/describe.ts"
import {
	type ChangeSetDesc,
	type AuthoredExprDesc as ExprDesc,
	type QueryDesc,
	type QueryStageDesc,
	type AuthoredRelationDesc as RelationDesc,
	type RuleDesc,
	type SchemaDesc,
	type AuthoredStatementDesc as StatementDesc,
	textDesc,
	type WorkloadDesc
} from "#test/support/fixtures/ir/desc.ts"
import {
	defaultSchemaLimits,
	fullDataSwarm,
	resolveSchema,
	schemaDesc,
	schemaSketchGen
} from "#test/support/oracle/gen/schema.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { fail } from "#test/support/unit/ir/fixture.ts"
import { declaredGen } from "#test/support/unit/ir/types.ts"

/** A decimal of its canonical text. */
const dec = (text: string) => defined(DecimalText.parse(text))

/** Budget: a contract over numeric(12, 2). */
const budget: FieldDesc = {
	kind: "domain",
	name: "Budget",
	base: { kind: "numeric", precision: 12, scale: 2 },
	predicate: {
		kind: "between",
		arg: { kind: "value" },
		low: { kind: "literal", value: 0n },
		high: { kind: "literal", value: dec("1000000") }
	},
	facts: []
}

/** A field its caller writes. */
const caller = (type: FieldDesc): FieldDecl<object> => ({ type, writing: { kind: "caller" } })

/** Task's fields: one of each type, and one of each way a field is written. */
const fields: Readonly<Record<string, FieldDecl<object>>> = {
	id: caller({ kind: "uuid" }),
	account: caller({ kind: "uuid" }),
	kind: caller({ kind: "closedId", roster: "Kind", only: undefined }),
	kinds: caller({ kind: "bits", roster: "Kind" }),
	budget: caller(budget),
	title: caller(textDesc("^[A-Za-z ]{1,80}$", "u")),
	priority: caller({ kind: "pg", type: "int4" }),
	twice: {
		type: { kind: "pg", type: "int8" },
		writing: {
			kind: "generated",
			expr: {
				kind: "compute",
				fn: "mul",
				args: [
					{ kind: "field", field: "priority" },
					{ kind: "literal", value: 2n }
				]
			}
		}
	},
	at: { type: { kind: "pg", type: "int4" }, writing: { kind: "drawn" } },
	running: { type: { kind: "pg", type: "int8" }, writing: { kind: "accumulated", start: 0n } },
	window: caller({ kind: "span", endpoint: { kind: "pg", type: "int8" }, width: 86_400n }),
	embedding: caller({ kind: "vector", dimensions: 3 }),
	cost: caller({ kind: "pg", type: "money" })
}

/** A rules stage of its arms. */
export const rules = (...arms: Arr.NonEmptyReadonlyArray<RuleDesc>): QueryStageDesc => ({
	kind: "rules",
	arms
})

/** A query of one stage. */
export const versioned = (stage: QueryStageDesc): QueryDesc => ({ stage })

/** A rule over the owners: one variable, matched and kept. */
const ownerRule: RuleDesc = {
	vars: [{ id: "v7", origin: undefined }],
	matches: [
		{
			source: { kind: "relation", name: "Account" },
			bindings: {
				id: { kind: "var", var: "v7" },
				owner: { kind: "param", name: "owner", type: { kind: "uuid" } }
			}
		}
	],
	where: [],
	head: { id: { kind: "var", var: "v7" } },
	interiors: [],
	attach: []
}

/** A rule reading tasks, their kinds and their budgets: every expression kind a rule reaches. */
export const rule: RuleDesc = {
	vars: [
		{ id: "v1", origin: { relation: "Task", field: "id" } },
		{ id: "v2", origin: { relation: "Task", field: "account" } },
		{ id: "v3", origin: undefined }
	],
	matches: [
		{
			source: { kind: "relation", name: "Task" },
			bindings: {
				id: { kind: "var", var: "v1" },
				account: { kind: "var", var: "v2" },
				budget: { kind: "var", var: "v3" }
			}
		},
		{
			source: { kind: "param", name: "ids", heading: { id: { kind: "uuid" } } },
			bindings: { id: { kind: "var", var: "v1" } }
		},
		{ source: { kind: "interior", id: "i1" }, bindings: { account: { kind: "var", var: "v2" } } },
		{
			source: { kind: "paramOf", name: "accounts", relation: "Account" },
			bindings: { id: { kind: "var", var: "v2" } }
		},
		{
			source: {
				kind: "query",
				query: versioned(rules(ownerRule)),
				bind: { owner: { kind: "param", name: "outer", type: { kind: "uuid" } } }
			},
			bindings: { id: { kind: "var", var: "v2" } }
		}
	],
	where: [
		{
			kind: "compare",
			op: "eq",
			left: { kind: "var", var: "v2" },
			right: { kind: "param", name: "account", type: { kind: "uuid" } }
		},
		{ kind: "in", arg: { kind: "var", var: "v3" }, values: [dec("1.5"), 2n, "~escaped"] },
		{
			kind: "not",
			arg: {
				kind: "absent",
				source: { kind: "relation", name: "ManualTask" },
				bindings: { task: { kind: "var", var: "v1" } }
			}
		},
		{
			kind: "allen",
			left: { kind: "literal", value: { span: { start: 1n, end: 5n } } },
			mask: 0b1_1111_1111,
			right: { kind: "literal", value: { span: { start: 3, end: 9 } } }
		}
	],
	head: {
		account: { kind: "var", var: "v2" },
		total: { kind: "aggregate", fn: "sum", arg: { kind: "var", var: "v3" } },
		n: { kind: "aggregate", fn: "count" },
		doubled: {
			kind: "compute",
			fn: "mul",
			args: [
				{ kind: "var", var: "v3" },
				{ kind: "literal", value: 2n }
			]
		},
		rounded: { kind: "compute", fn: "round", args: [{ kind: "var", var: "v3" }], scale: 1 },
		flag: {
			kind: "cond",
			pred: { kind: "var", var: "v1" },
			onTrue: { kind: "literal", value: 1 },
			onFalse: { kind: "literal", value: 0 }
		},
		nan: {
			kind: "literal",
			value: { float: "NaN" },
			type: { kind: "pg", type: "float8" }
		},
		price: {
			kind: "literal",
			value: defined(MoneyText.parse("1999")),
			type: { kind: "pg", type: "money" }
		},
		probe: {
			kind: "literal",
			value: succeeded(VectorText.of(Float32Array.of(0.5, 1, 0.25)))
		},
		spans: {
			kind: "producer",
			fn: "intersection",
			args: [
				{ kind: "var", var: "v1" },
				{ kind: "var", var: "v2" }
			]
		}
	},
	interiors: [
		{
			id: "i1",
			arms: [
				{
					vars: [{ id: "v4", origin: undefined }],
					matches: [
						{
							source: { kind: "relation", name: "Account" },
							bindings: { id: { kind: "var", var: "v4" } }
						}
					],
					where: [],
					head: { account: { kind: "var", var: "v4" } },
					interiors: [],
					attach: []
				}
			]
		}
	],
	attach: []
}

/** A rule reading budgets by a variable. */
export const budgetRule: RuleDesc = {
	vars: [{ id: "v9", origin: undefined }],
	matches: [
		{
			source: { kind: "relation", name: "AutomaticTask" },
			bindings: { task: { kind: "parent", column: "id" }, budget: { kind: "var", var: "v9" } }
		}
	],
	where: [],
	head: { budget: { kind: "var", var: "v9" } },
	interiors: [],
	attach: []
}

/** orderBy(...).take(1): an Ordered made a set again. */
const child: QueryDesc = versioned({
	kind: "take",
	input: { kind: "order", input: rules(budgetRule), order: [{ column: "budget", dir: "desc" }] },
	take: { kind: "literal", k: 1 }
})

/** query.rule(rule).attach("automatic", child).orderBy(total desc, account asc).take("batch").named(...) */
const attached: QueryStageDesc = {
	kind: "attach",
	input: rules(rule),
	attach: { name: "automatic", child }
}

/** A query naming a stage over an ordered, taken union of the rules. */
const query: QueryDesc = versioned({
	kind: "named",
	input: {
		kind: "take",
		input: {
			kind: "order",
			input: attached,
			order: [
				{ column: "total", dir: "desc" },
				{ column: "account", dir: "asc" }
			]
		},
		take: { kind: "param", name: "batch" }
	},
	name: "budgetsByAccount"
})

/** A recursive stage: the rows a recursion reaches. */
export const reach: QueryStageDesc = {
	kind: "recursive",
	recursive: {
		name: "reach",
		row: { a: { kind: "uuid" }, b: { kind: "uuid" } },
		base: [
			{
				vars: [
					{ id: "v1", origin: undefined },
					{ id: "v2", origin: undefined }
				],
				matches: [
					{
						source: { kind: "relation", name: "Edge" },
						bindings: { a: { kind: "var", var: "v1" }, b: { kind: "var", var: "v2" } }
					}
				],
				where: [],
				head: { a: { kind: "var", var: "v1" }, b: { kind: "var", var: "v2" } },
				interiors: [],
				attach: []
			}
		],
		rec: [
			{
				vars: [
					{ id: "v1", origin: undefined },
					{ id: "v2", origin: undefined },
					{ id: "v3", origin: undefined }
				],
				matches: [
					{
						source: { kind: "self" },
						bindings: { a: { kind: "var", var: "v1" }, b: { kind: "var", var: "v2" } }
					},
					{
						source: { kind: "relation", name: "Edge" },
						bindings: { a: { kind: "var", var: "v2" }, b: { kind: "var", var: "v3" } }
					}
				],
				where: [],
				head: { a: { kind: "var", var: "v1" }, b: { kind: "var", var: "v3" } },
				interiors: [],
				attach: []
			}
		]
	}
}

/** An approximate search over the recursion. */
const recursive: QueryDesc = versioned({ kind: "approx", input: reach, by: "distance", take: 20 })

/** One statement of every kind. */
const statements: ReadonlyArray<StatementDesc> = [
	{
		kind: "key",
		side: {
			relation: "Account",
			terms: [{ kind: "field", field: "name" }],
			selection: everyFact
		}
	},
	{ kind: "mutable", relation: "Account" },
	{
		kind: "check",
		name: "positive",
		relation: "Task",
		predicate: {
			kind: "compare",
			op: "gt",
			left: { kind: "field", field: "priority" },
			right: { kind: "literal", value: 0 }
		}
	},
	{
		kind: "contained",
		left: {
			relation: "Task",
			terms: [
				{ kind: "field", field: "id" },
				{ kind: "pred", field: "priority" }
			],
			selection: everyFact
		},
		right: {
			relation: "Task",
			terms: [
				{ kind: "field", field: "id" },
				{ kind: "field", field: "priority" }
			],
			selection: everyFact
		}
	},
	{
		kind: "family",
		order: "counted",
		member: {
			relation: "Claim",
			terms: [{ kind: "field", field: "resource" }],
			selection: everyFact
		},
		slots: { owner: "Resource", count: "claims" }
	},
	{
		kind: "fold",
		family: { owner: "Resource", count: "claims" },
		monoid: "sum",
		step: { relation: "Claim", terms: [{ kind: "field", field: "amount" }], selection: everyFact },
		end: { relation: "Resource", terms: [{ kind: "field", field: "total" }], selection: everyFact }
	},
	{
		kind: "family",
		order: "ordered",
		member: {
			relation: "Line",
			terms: [
				{ kind: "field", field: "order" },
				{ kind: "field", field: "at" }
			],
			selection: everyFact
		},
		slots: { owner: "Order", count: "lines" }
	},
	{
		kind: "tree",
		member: {
			relation: "Node",
			terms: [
				{ kind: "field", field: "parent" },
				{ kind: "field", field: "at" }
			],
			selection: everyFact
		},
		slots: { owner: "Node", count: "children" },
		root: ["document"]
	}
]

/** A derived definition reads no parameter and has no bound. */
const unbounded: QueryDesc = versioned(attached)

/** Each tier's plan: a closed relation keyed by a closed id of the roster Tier. */
const plan: RelationDesc = {
	kind: "closedRelation",
	name: "Plan",
	fields: {
		tier: { kind: "closedId", roster: "Tier", only: undefined },
		seats: { kind: "pg", type: "int4" },
		price: { kind: "numeric", precision: 10, scale: 2 }
	},
	key: ["tier"],
	slots: [],
	rows: [
		{ tier: "Free", seats: 1, price: dec("0") },
		{ tier: "Pro", seats: 10, price: dec("49") }
	]
}

/** One relation of every kind. */
const relations: ReadonlyArray<RelationDesc> = [
	{ kind: "relation", name: "Task", naming: declaredNaming, fields, primaryKey: ["id"] },
	{ kind: "closed", name: "Kind", naming: declaredNaming, handles: ["Automatic", "Manual"] },
	{ kind: "closed", name: "Tier", naming: declaredNaming, handles: ["Free", "Pro"] },
	plan,
	{
		kind: "closedRelation",
		name: "Fee",
		fields: {
			tier: { kind: "closedId", roster: "Tier", only: undefined },
			amount: { kind: "pg", type: "money" }
		},
		key: ["tier"],
		slots: [],
		rows: [{ tier: "Pro", amount: defined(MoneyText.parse("1999")) }]
	},
	{
		kind: "derived",
		name: "Totals",
		query: unbounded,
		level: 1
	}
]

/** The schema's first version: its first five relations. */
const base: SchemaDesc = {
	name: "Work",
	relations: relations.slice(0, 5),
	statements: statements.slice(0, 4),
	bases: []
}

/** The schema: every relation of the samples. */
const schema: SchemaDesc = {
	name: "Work",
	relations: relations.slice(5),
	statements: statements.slice(4),
	bases: [base]
}

/** The tasks whose window holds the parameter now: a member query reading the parameter the ChangeSet binds. */
const current: QueryDesc = versioned(
	rules({
		vars: [
			{ id: "v1", origin: undefined },
			{ id: "v2", origin: undefined }
		],
		matches: [
			{
				source: { kind: "relation", name: "Task" },
				bindings: { id: { kind: "var", var: "v1" }, window: { kind: "var", var: "v2" } }
			}
		],
		where: [
			{
				kind: "pointIn",
				point: { kind: "param", name: "now", type: { kind: "pg", type: "int8" } },
				span: { kind: "var", var: "v2" }
			}
		],
		head: { id: { kind: "var", var: "v1" } },
		interiors: [],
		attach: []
	})
)

/** A ChangeSet of every member and read kind. */
const changeSet: ChangeSetDesc = {
	strata: [
		{
			members: [
				{ op: "insert", relation: "Task", member: { kind: "array", slot: "m1" } },
				{ op: "put", relation: "Account", member: { kind: "stream", slot: "m2" } }
			]
		},
		{
			members: [
				{ op: "delete", relation: "Task", member: { kind: "query", query: child } },
				{ op: "delete", relation: "Task", member: { kind: "query", query: current } }
			]
		}
	],
	reads: [
		{
			name: "added",
			/** A read-back may be an Ordered. */
			query: versioned({
				kind: "order",
				input: rules({
					vars: [{ id: "v1", origin: undefined }],
					matches: [
						{
							source: { kind: "delta", side: "added", relation: "Task" },
							bindings: { id: { kind: "var", var: "v1" } }
						}
					],
					where: [],
					head: { id: { kind: "var", var: "v1" } },
					interiors: [],
					attach: []
				}),
				order: [{ column: "id", dir: "asc" }]
			})
		}
	],
	bindings: ["now"],
	boundRows: {}
}

/** A workload of every program kind. */
const workload: WorkloadDesc = {
	schema: "Work",
	programs: {
		budgets: { kind: "query", query },
		reach: { kind: "query", query: recursive },
		claim: { kind: "changeSet", changeSet }
	}
}

/** The rule's first condition. */
const expr: ExprDesc = defined(rule.where[0])

/** The expression kinds the rule does not reach: a cast, a base, an or and a point-in-span test. */
const castsAndSpans: ExprDesc = {
	kind: "or",
	args: [
		{
			kind: "compare",
			op: "lt",
			left: {
				kind: "cast",
				to: { kind: "numeric", precision: 12, scale: 2 },
				arg: { kind: "var", var: "v3" }
			},
			right: {
				kind: "base",
				arg: { kind: "param", name: "limit", type: { kind: "numeric", precision: 12, scale: 2 } }
			}
		},
		{
			kind: "pointIn",
			point: { kind: "literal", value: 4n },
			span: { kind: "literal", value: { span: { start: 1n, end: 5n } } }
		}
	]
}

/** One description of every kind, which together hold every stage, statement and expression kind. */
const samples: ReadonlyArray<readonly [DescKind, unknown]> = [
	["schema", schema],
	["statement", statements[4]],
	["statement", statements[7]],
	["relation", plan],
	["query", query],
	["query", recursive],
	["rule", rule],
	["expr", expr],
	["expr", castsAndSpans],
	["field", budget],
	["changeSet", changeSet],
	["workload", workload]
]

/**
 * A description decoded as its author's is: a schema through its admission, which admits its closed relations before it
 * decodes it as one (schema/admit.ts), any other kind by itself.
 */
export const decodeHanded = (
	kind: DescKind,
	value: unknown
): Result.Result<unknown, CompileError> =>
	kind === "schema" ? admitSchemaDesc(value) : decodeDesc(kind, value)

/**
 * A description and the kind it is decoded as: one of the samples, which hold every kind of description and every
 * stage, statement and expression kind no generator draws; a schema the differential oracle generates, one of its
 * relations or one of its statements; or a generated field type.
 */
export const corpusGen: Gen<readonly [DescKind, unknown]> = (source) => {
	const generated = source.draw(
		resolveSchema(
			source.draw(schemaSketchGen(defaultSchemaLimits)),
			{ mode: "drawn", edge: false },
			fullDataSwarm
		)
	)
	const desc = schemaDesc(generated)
	const arm = source.draw(int(0, 5))
	if (arm < 2) {
		return pickFrom(nonEmpty(samples, "the samples"), source.draw(pickGen))
	}
	if (arm === 2) {
		return ["schema", desc]
	}
	if (arm === 3) {
		return [
			"relation",
			pickFrom(nonEmpty(desc.relations, "a generated relation"), source.draw(pickGen))
		]
	}
	const [statement, ...more] = desc.statements
	return arm === 4 && statement !== undefined
		? ["statement", pickFrom([statement, ...more], source.draw(pickGen))]
		: ["field", source.draw(declaredGen).desc]
}

/** The JSON form written as JSON text and parsed back: what a process boundary does. */
export const throughJson = (value: unknown): unknown =>
	trustedJson<Json>(jsonText(succeeded(descToJson(value))))

/** Asserts that a description is refused as MalformedDescription. */
export const refuses = (kind: DescKind, value: unknown) => {
	assert.equal(fail(decodeHanded(kind, value)).reason._tag, "MalformedDescription")
}

/** `innermost` under `depth` relational negations. */
export const notChain = (depth: number, innermost: unknown): unknown => {
	let e = innermost
	for (let i = 0; i < depth; i++) {
		e = { kind: "not", arg: e }
	}
	return e
}

/** Every object of a decoded description that carries a location, with its path in the description. */
export const located = (
	value: unknown,
	path: ReadonlyArray<string | number>
): ReadonlyArray<{
	readonly path: ReadonlyArray<string | number>
	readonly loc: unknown
}> => {
	if (!isRecord(value)) {
		return []
	}
	const stated: unknown = Reflect.get(value, "loc")
	const here = Rec.has(value, "loc") ? [{ path, loc: stated }] : []
	return [
		...here,
		...Arr.flatMap(Rec.toEntries(value), ([key, member]) =>
			key === "loc" ? [] : located(member, [...path, Arr.isArray(value) ? Number(key) : key])
		)
	]
}

/** The value with a location stated on the object at `path`. */
export const statedAt = (
	value: unknown,
	path: ReadonlyArray<string | number>,
	loc: SourceLoc
): unknown => {
	const [head, ...rest] = path
	if (head === undefined) {
		return value !== null && typeof value === "object" ? { ...value, loc } : value
	}
	if (Arr.isArray(value)) {
		return Arr.map(value, (item, i) => (i === head ? statedAt(item, rest, loc) : item))
	}
	if (value === null || typeof value !== "object") {
		return value
	}
	return Rec.fromEntries(
		Arr.map(Rec.toEntries(value), ([key, member]) => [
			key,
			key === head ? statedAt(member, rest, loc) : member
		])
	)
}

/** What a node's location was: located by its path, or stated by its author, by description kind. */
export type LocatedFeature = `located ${DescKind}` | `stated ${DescKind}`

/**
 * A query description keeps the order of its combinators, so queryFromDescription rebuilds the same query: two
 * chains of combinators over one rule, or over a recursion, that both decode are one description exactly when they
 * are one chain, and each round-trips JSON. The combinators: orderBy, take(k), approximateNearest, and a rule added
 * after them.
 */
type Combinator = "order" | "take 2" | "take 5" | "approximate" | "a rule after"

/** A second arm of the budget rule, its head another column. */
const armB: RuleDesc = {
	...budgetRule,
	head: {
		budget: { kind: "var", var: "v9" },
		extra: { kind: "literal", value: 1 }
	}
}

/** A stage with a combinator after it. */
const combined = (input: QueryStageDesc, combinator: Combinator): QueryStageDesc => {
	switch (combinator) {
		case "order":
			return { kind: "order", input, order: [{ column: "budget", dir: "asc" }] }
		case "take 2":
			return { kind: "take", input, take: { kind: "literal", k: 2 } }
		case "take 5":
			return { kind: "take", input, take: { kind: "literal", k: 5 } }
		case "approximate":
			return { kind: "approx", input, by: "budget", take: 10 }
		case "a rule after":
			return { kind: "union", input, arms: [armB] }
	}
}

/** A combinator with a take's count swapped, 2 for 5 and 5 for 2, and any other as it is. */
export const countSwapped = (combinator: Combinator): Combinator => {
	switch (combinator) {
		case "take 2":
			return "take 5"
		case "take 5":
			return "take 2"
		case "order":
		case "approximate":
		case "a rule after":
			return combinator
	}
}

/** Whether two chains are one chain, combinator by combinator. */
export const sameChain = (a: ReadonlyArray<Combinator>, b: ReadonlyArray<Combinator>): boolean =>
	a.length === b.length && Arr.every(a, (x, i) => x === b[i])

/** A stage with each combinator of a chain after it, in order. */
export const chained = (
	start: QueryStageDesc,
	chain: ReadonlyArray<Combinator>
): QueryStageDesc => {
	let stage = start
	for (const combinator of chain) {
		stage = combined(stage, combinator)
	}
	return stage
}

/** A query's text, after asserting that its JSON round trip decodes as it does. */
export const roundTrips = (q: QueryDesc): string => {
	const back = succeeded(descFromJson("query", throughJson(q)))
	assert.deepEqual(back, succeeded(decodeDesc("query", q)))
	assert.equal(succeeded(descText(back)), succeeded(descText(q)))
	return succeeded(descText(q))
}

/** The value with `f` applied to the part at `path`. */
export const editedAt = (
	value: unknown,
	path: ReadonlyArray<string | number>,
	f: (part: unknown) => unknown
): unknown => {
	const [head, ...rest] = path
	if (head === undefined) {
		return f(value)
	}
	if (Arr.isArray(value)) {
		return Arr.map(value, (item, i) => (i === head ? editedAt(item, rest, f) : item))
	}
	if (value === null || typeof value !== "object") {
		return value
	}
	return Rec.fromEntries(
		Arr.map(Rec.toEntries(value), ([key, member]) => [
			key,
			key === head ? editedAt(member, rest, f) : member
		])
	)
}

/**
 * Every path to a part of a value, and whether the part is a struct: a plain object that is no record keyed by
 * names (the fields, bindings, head or row, the facts, the programs, a bind map, a payload). A side's selection is a
 * struct.
 */
const records: ReadonlyArray<string> = [
	"fields",
	"bindings",
	"head",
	"row",
	"facts",
	"programs",
	"bind",
	"payload"
]

/** Every part of a value by its path, and whether it is a struct. */
const partsOf = (
	value: unknown,
	path: ReadonlyArray<string | number>
): ReadonlyArray<{ readonly path: ReadonlyArray<string | number>; readonly struct: boolean }> => {
	if (
		value === null ||
		typeof value !== "object" ||
		Object.getPrototypeOf(value) !== (Arr.isArray(value) ? Array.prototype : Object.prototype)
	) {
		return [{ path, struct: false }]
	}
	const last = path.at(-1)
	const struct = !Arr.isArray(value) && !(typeof last === "string" && Arr.contains(records, last))
	return [
		{ path, struct },
		...Arr.flatMap(Rec.toEntries(value), ([key, member]) =>
			partsOf(member, [...path, Arr.isArray(value) ? Number(key) : key])
		)
	]
}

/** Where a query description stands: a whole query's place, or one that reads it as a set. */
export type QueryPlace =
	| "a page's query"
	| "an attachment child"
	| "a read-back"
	| "a workload program"
	| "an imported source"
	| "a ChangeSet member"
	| "a derived definition"

/** The places a whole query stands. */
export const wholePlaces: ReadonlyArray<QueryPlace> = [
	"a page's query",
	"an attachment child",
	"a read-back",
	"a workload program"
]

/** The value at `path` in `value`, or undefined where none is. */
const partAt = (value: unknown, path: ReadonlyArray<string | number>): unknown =>
	Arr.reduce(path, value, (part, key) =>
		part !== null && typeof part === "object" ? Reflect.get(part, key) : undefined
	)

/**
 * The place a query description at `path` stands, read off the description's grammar: what its parent and
 * grandparent are.
 */
export const queryPlaceOf = (
	kind: DescKind,
	value: unknown,
	path: ReadonlyArray<string | number>
): QueryPlace | undefined => {
	if (path.length === 0) {
		return kind === "query" ? "a page's query" : undefined
	}
	const [grand, parentKey, key] = Arr.takeRight(path, 3)
	const parent = partAt(value, Arr.dropRight(path, 1))
	if (key === "child" && parentKey === "attach") {
		return "an attachment child"
	}
	if (key !== "query") {
		return undefined
	}
	if (isRecord(parent) && Reflect.get(parent, "kind") === "derived") {
		return "a derived definition"
	}
	if (parentKey === "source") {
		return "an imported source"
	}
	if (parentKey === "member") {
		return "a ChangeSet member"
	}
	if (typeof parentKey === "number" && grand === "reads") {
		return "a read-back"
	}
	const programs = partAt(value, Arr.dropRight(path, 2))
	return isRecord(programs) && Arr.takeRight(Arr.dropRight(path, 2), 1)[0] === "programs"
		? "a workload program"
		: undefined
}

/** Every query description a description holds, by its path: a record whose one property is its stage. */
export const queriesIn = (value: unknown): ReadonlyArray<ReadonlyArray<string | number>> =>
	Arr.flatMap(partsOf(value, []), (part) => {
		const held = partAt(value, part.path)
		return isRecord(held) && Rec.keys(held).length === 1 && Rec.has(held, "stage")
			? [part.path]
			: []
	})

/** The samples that hold a query description: no generator draws one. */
export const queried = nonEmpty(
	Arr.filter(samples, ([, value]) => Arr.isReadonlyArrayNonEmpty(queriesIn(value))),
	"a sample holding a query"
)

/**
 * The Description boundary's own rules, each broken at every part of a description that offers it: no part null; a
 * struct of its kind's properties only; a literal no JavaScript NaN, a money, vector or decimal tagged; take only
 * after an order; a rules stage with an arm; on an Ordered only take, each other stage over it a rule of its own, so
 * that every one is reached; a union over a query, not over the builder's rules, which are one stage; each order
 * column once; a primary key nonempty and among the fields, filled by its writer (its caller, its family's draw, its
 * insert's place or its row's generation, never an accumulation, which a family fills from the row the key names); a
 * relation's, a field's and a program's name storable text; a closed relation's rows each of every field, one per key,
 * keyed by closed ids; an Allen mask of thirteen bits; a numeric precision 1-1000; each variable id once.
 */
export type DescRule =
	| "no part is null"
	| "a struct holds its kind's properties only"
	| "a literal is no JavaScript NaN"
	| "a money, vector or decimal literal is tagged"
	| "take only after an order"
	| "a rules stage has an arm"
	| "on an Ordered, only take: no attach"
	| "on an Ordered, only take: no union"
	| "on an Ordered, only take: no named"
	| "on an Ordered, only take: no second orderBy"
	| "on an Ordered, only take: no approximate search"
	| "a union is over a query, never the builder's rules"
	| "each order column once"
	| "a primary key is nonempty and among the fields"
	| "a primary key is filled by its writer"
	| "a name is storable text"
	| "a closed relation's rows are each of every field, one per key"
	| "a closed relation is keyed by closed ids"
	| "an Allen mask is thirteen bits"
	| "a numeric precision is 1 to 1000"
	| "each variable id once"

/** A description and the kind it is decoded as. */
type Described = readonly [DescKind, unknown]

/** One rule of the Description boundary, broken at its sites. */
type DescCorruption = Corruption<Described, DescKind, DescRule>

/** A part's kind, by which a site is named, or the key it stands at. */
const nameOf = (part: Readonly<Record<string, unknown>>, path: ReadonlyArray<string | number>) => {
	const kind = Reflect.get(part, "kind")
	return typeof kind === "string" ? kind : String(Arr.takeRight(path, 1)[0] ?? "the description")
}

/** Every record part `select` picks, each broken into each of `broken`'s values, as the sites of `rule`. */
const breaking = (
	rule: DescRule,
	select: (
		part: Readonly<Record<string, unknown>>,
		path: ReadonlyArray<string | number>
	) => boolean,
	broken: (part: Readonly<Record<string, unknown>>) => ReadonlyArray<unknown>
): DescCorruption => ({
	rule,
	from: "wild",
	weight: 1,
	sites: ([kind, value]) =>
		Arr.flatMap(partsOf(value, []), ({ path }) => {
			const part = partAt(value, path)
			return isRecord(part) && select(part, path)
				? Arr.map(broken(part), (edited) => ({
						value: editedAt(value, path, () => edited),
						refusal: kind,
						at: nameOf(part, path)
					}))
				: []
		})
})

/** Whether a part is of `kind` and holds every key of `keys`. */
const kindIs =
	(kind: string, ...keys: ReadonlyArray<string>) =>
	(part: Readonly<Record<string, unknown>>): boolean =>
		Reflect.get(part, "kind") === kind && Arr.every(keys, (key) => Rec.has(part, key))

/** The text no name may hold: a lone surrogate, and a NUL. */
const unstorable = ["\ud800", "a\u0000b"] as const

/** Every rule of the Description boundary, each broken at every site a description holds of it. */
export const descCorruptions: Arr.NonEmptyReadonlyArray<DescCorruption> = [
	{
		rule: "no part is null",
		from: "wild",
		weight: 1,
		sites: ([kind, value]) =>
			Arr.map(partsOf(value, []), ({ path }) => ({
				value: editedAt(value, path, () => null),
				refusal: kind,
				at: String(Arr.takeRight(path, 1)[0] ?? "the description")
			}))
	},
	{
		rule: "a struct holds its kind's properties only",
		from: "wild",
		weight: 1,
		sites: ([kind, value]) =>
			Arr.flatMap(partsOf(value, []), ({ path, struct }) => {
				const part = partAt(value, path)
				return struct && isRecord(part)
					? [
							{
								value: editedAt(value, path, () => ({ ...part, unknownProperty: 1 })),
								refusal: kind,
								at: nameOf(part, path)
							}
						]
					: []
			})
	},
	breaking("a literal is no JavaScript NaN", kindIs("literal", "value"), (part) => [
		{ ...part, value: Number.NaN }
	]),
	breaking("a money, vector or decimal literal is tagged", kindIs("literal", "value"), (part) => [
		{ ...part, value: { money: 5n } },
		{ ...part, value: { vector: [1, 2] } },
		{ ...part, value: { canonical: "1.5" } }
	]),
	breaking(
		"take only after an order",
		(part) => {
			const input = Reflect.get(part, "input")
			return (
				kindIs("take", "input")(part) && isRecord(input) && Reflect.get(input, "kind") === "order"
			)
		},
		(part) => {
			const input = Reflect.get(part, "input")
			return isRecord(input) ? [{ ...part, input: Reflect.get(input, "input") }] : []
		}
	),
	breaking("a rules stage has an arm", kindIs("rules", "arms"), (part) => [{ ...part, arms: [] }]),
	breaking("on an Ordered, only take: no attach", kindIs("order", "input", "order"), (part) => [
		{ kind: "attach", input: part, attach: { name: "a", child } }
	]),
	breaking("on an Ordered, only take: no union", kindIs("order", "input", "order"), (part) => [
		{ kind: "union", input: part, arms: [rule] }
	]),
	breaking("on an Ordered, only take: no named", kindIs("order", "input", "order"), (part) => [
		{ kind: "named", input: part, name: "n" }
	]),
	breaking(
		"on an Ordered, only take: no second orderBy",
		kindIs("order", "input", "order"),
		(part) => [{ kind: "order", input: part, order: [{ column: "id", dir: "asc" }] }]
	),
	breaking(
		"on an Ordered, only take: no approximate search",
		kindIs("order", "input", "order"),
		(part) => [{ kind: "approx", input: part, by: "d", take: 3 }]
	),
	breaking(
		"a union is over a query, never the builder's rules",
		kindIs("rules", "arms"),
		(part) => [{ kind: "union", input: part, arms: Reflect.get(part, "arms") }]
	),
	breaking("each order column once", kindIs("order", "input", "order"), (part) => {
		const [first, ...rest] = Arr.filter([Reflect.get(part, "order")].flat(), isRecord)
		return first === undefined
			? []
			: [
					{
						...part,
						order: [
							first,
							...rest,
							{ ...first, dir: Reflect.get(first, "dir") === "asc" ? "desc" : "asc" }
						]
					}
				]
	}),
	breaking(
		"a primary key is nonempty and among the fields",
		kindIs("relation", "fields", "primaryKey"),
		(part) => {
			const fields = Reflect.get(part, "fields")
			const fresh = `${Arr.join(isRecord(fields) ? Rec.keys(fields) : [], "")}x`
			return [
				{ ...part, primaryKey: [] },
				{ ...part, primaryKey: [...[Reflect.get(part, "primaryKey")].flat(), fresh] }
			]
		}
	),
	breaking(
		"a primary key is filled by its writer",
		kindIs("relation", "fields", "primaryKey"),
		(part) => {
			const fields = Reflect.get(part, "fields")
			const [key] = [Reflect.get(part, "primaryKey")].flat()
			const keyed =
				typeof key === "string" && isRecord(fields) ? Reflect.get(fields, key) : undefined
			return typeof key === "string" && isRecord(fields) && isRecord(keyed)
				? [
						{
							...part,
							fields: {
								...fields,
								[key]: {
									type: Reflect.get(keyed, "type"),
									writing: { kind: "accumulated", start: 0n }
								}
							}
						}
					]
				: []
		}
	),
	breaking(
		"a name is storable text",
		(part) =>
			kindIs("relation", "fields", "primaryKey")(part) ||
			kindIs("closed", "handles")(part) ||
			kindIs("closedRelation", "rows")(part) ||
			kindIs("derived", "query", "level")(part) ||
			isRecord(Reflect.get(part, "programs")),
		(part) => {
			const programs = Reflect.get(part, "programs")
			const fields = Reflect.get(part, "fields")
			return Arr.flatMap(unstorable, (bad): ReadonlyArray<unknown> => [
				...(isRecord(programs)
					? [{ ...part, programs: { ...programs, [bad]: { kind: "query", query } } }]
					: [{ ...part, name: bad }]),
				...(isRecord(fields) && Reflect.get(part, "kind") === "relation"
					? [{ ...part, fields: { ...fields, [bad]: caller({ kind: "uuid" }) } }]
					: [])
			])
		}
	),
	breaking(
		"a closed relation's rows are each of every field, one per key",
		kindIs("closedRelation", "rows"),
		(part) => {
			const [first, ...rest] = Arr.filter([Reflect.get(part, "rows")].flat(), isRecord)
			if (first === undefined) {
				return []
			}
			const [, ...fewer] = Rec.toEntries(first)
			return [
				{ ...part, rows: [Rec.fromEntries(fewer), ...rest] },
				{ ...part, rows: [first, first, ...rest] }
			]
		}
	),
	breaking(
		"a closed relation is keyed by closed ids",
		kindIs("closedRelation", "fields", "key"),
		(part) => {
			const fields = Reflect.get(part, "fields")
			return Arr.flatMap(isRecord(fields) ? Rec.toEntries(fields) : [], ([name, desc]) =>
				isRecord(desc) && Reflect.get(desc, "kind") !== "closedId" ? [{ ...part, key: [name] }] : []
			)
		}
	),
	breaking("an Allen mask is thirteen bits", kindIs("allen", "mask"), (part) =>
		Arr.map([2 ** 13, -1, 1.5], (mask) => ({ ...part, mask }))
	),
	breaking("a numeric precision is 1 to 1000", kindIs("numeric", "precision"), (part) =>
		Arr.map([0, numericMaxPrecision + 1], (precision) => ({ ...part, precision }))
	),
	breaking(
		"each variable id once",
		(part) => Arr.isArray(Reflect.get(part, "vars")) && Rec.has(part, "matches"),
		(part) => {
			const vars = [Reflect.get(part, "vars")].flat()
			const [first] = vars
			return first === undefined ? [] : [{ ...part, vars: [...vars, first] }]
		}
	)
]

/** A description broken at one site of one rule, or live. */
type DescCase = Corrupted<Described, DescKind, DescRule>

/** A drawn description, live or broken at one site of one rule. */
export const descCaseGen: Gen<DescCase> = (source) =>
	source.draw(corrupted(source.draw(corpusGen), descCorruptions))

/**
 * A sample, live or broken at one site of one rule: each sample live, then each corruption with a site in it at each of
 * its sites, so an exhaustion is every break of every sample.
 */
export const sampleCaseGen: Gen<DescCase> = (source) => {
	const live = source.draw(element(nonEmpty(samples, "the samples")))
	const corruption = source.draw(element(descCorruptions))
	return Arr.match(corruption.sites(live), {
		onEmpty: (): DescCase => ({ kind: "live", value: live }),
		onNonEmpty: (sites): DescCase => {
			const broken = source.draw(element(sites))
			return {
				kind: corruption.from,
				rule: corruption.rule,
				at: broken.at,
				value: broken.value,
				refusal: broken.refusal
			}
		}
	})
}

/**
 * For each corruption's feature, the cases aimed at it: one of the samples that holds a site of a corruption naming it,
 * broken as the corruptions naming it break it. The samples hold every kind of description and stage, so each
 * corruption has a site in one, where a drawn description holds the rarer ones in one draw of ten or fewer.
 */
export const corruptionAims: ReadonlyArray<readonly [CorruptedFeature<DescRule>, Gen<DescCase>]> =
	Arr.map(descCorruptions, (corruption) => {
		const feature: CorruptedFeature<DescRule> = `${corruption.from} ${corruption.rule}`
		const naming = nonEmpty(
			Arr.filter(descCorruptions, (c) => c.from === corruption.from && c.rule === corruption.rule),
			`the corruptions naming ${feature}`
		)
		return [
			feature,
			(source): DescCase =>
				source.draw(
					corrupted(
						source.draw(
							element(
								nonEmpty(
									Arr.filter(samples, (s) =>
										Arr.some(naming, (c) => Arr.isReadonlyArrayNonEmpty(c.sites(s)))
									),
									`a sample holding a site of ${feature}`
								)
							)
						),
						naming
					)
				)
		] as const
	})

/**
 * An in-memory description of any depth decodes, as its text form does, and never overflows the stack; a cyclic one
 * is MalformedDescription, and a value shared between siblings or levels is no cycle. The chains of r.not run from
 * none to one a recursion would overflow the stack on.
 */
export type Nesting =
	| { readonly kind: "a chain"; readonly depth: number }
	| { readonly kind: "a cycle"; readonly length: number; readonly back: number }
	| { readonly kind: "an array cycle" }
	| { readonly kind: "shared"; readonly depth: number }

/**
 * Generated expressions: decode, JSON round trip and canonical text are stable under every shape the generator
 * reaches, including bigints, decimals, money, vectors and strings that begin with "~".
 */
/** A string of printable ASCII, at least `min` and at most ten characters. */
const text = (min: number) => string(codePoint(0x20, 0x7e), { min, max: 10 })

/** The largest finite 32-bit float. */
const floatMax = 3.4028234663852886e38

/**
 * A literal: text, an integer, a double, a bigint, a decimal, a money or a vector, an escaped tilde among the texts.
 */
const literal = oneOf<LiteralDesc>([
	oneOf<string>([text(0), element(["~escaped", "~", "~~x", "~m:5"])]),
	int(-(2 ** 31), 2 ** 31 - 1),
	boolean,
	bigint(-(2n ** 64n), 2n ** 64n),
	map(
		(source) => [source.draw(bigint(-(10n ** 20n), 10n ** 20n)), source.draw(int(0, 6))] as const,
		([units, drawnScale]) => {
			/** The value's one text: the coefficient and scale with every trailing fractional zero dropped. */
			let digits = units
			let scale = drawnScale
			while (scale > 0 && digits % 10n === 0n) {
				digits /= 10n
				scale--
			}
			const sign = digits < 0n ? "-" : ""
			const abs = pipe((digits < 0n ? -digits : digits).toString(), Str.padStart(scale + 1, "0"))
			return dec(
				scale === 0
					? `${sign}${abs}`
					: `${sign}${Str.slice(0, -scale)(abs)}.${Str.slice(-scale)(abs)}`
			)
		}
	),
	map(bigint(-(2n ** 63n), 2n ** 63n - 1n), (minorUnits) =>
		defined(MoneyText.parse(String(minorUnits)))
	),
	map(array(float(-floatMax, floatMax), { min: 1, max: 4 }), (xs) =>
		succeeded(VectorText.of(Float32Array.from(xs)))
	)
])

/** An expression nested at most `depth` levels: a leaf first, so a failure shrinks toward one. */
const exprGen = (depth: number): Gen<ExprDesc> => {
	const leaves: Arr.NonEmptyReadonlyArray<Gen<ExprDesc>> = [
		map(text(1), (v): ExprDesc => ({ kind: "var", var: v })),
		map(text(1), (name): ExprDesc => ({
			kind: "param",
			name,
			type: { kind: "pg", type: "int4" }
		})),
		map(literal, (value): ExprDesc => ({ kind: "literal", value }))
	]
	if (depth === 0) {
		return oneOf(leaves)
	}
	const inner = exprGen(depth - 1)
	const args = array(inner, { min: 1, max: 3 })
	const operands: Gen<Arr.NonEmptyReadonlyArray<ExprDesc>> = map(
		(source) => [source.draw(inner), source.draw(array(inner, { min: 0, max: 2 }))] as const,
		([first, rest]): Arr.NonEmptyReadonlyArray<ExprDesc> => [first, ...rest]
	)
	return oneOf<ExprDesc>([
		...leaves,
		(source) => ({
			kind: "compare",
			op: source.draw(element(["eq", "lt", "ge"] as const)),
			left: source.draw(inner),
			right: source.draw(inner)
		}),
		map(operands, (a): ExprDesc => ({ kind: "and", args: a })),
		map(inner, (arg): ExprDesc => ({ kind: "not", arg })),
		map(operands, (a): ExprDesc => ({ kind: "or", args: a })),
		map(inner, (arg): ExprDesc => ({ kind: "base", arg })),
		(source) => ({
			kind: "cast",
			to: {
				kind: "numeric",
				precision: source.draw(int(1, 1000)),
				scale: source.draw(int(-1000, 1000))
			},
			arg: source.draw(inner)
		}),
		(source) => ({ kind: "pointIn", point: source.draw(inner), span: source.draw(inner) }),
		map(args, (a): ExprDesc => ({ kind: "compute", fn: "add", args: a }))
	])
}

/** Generated expressions, nested at most four levels. */
export const exprsGen = exprGen(4)

/**
 * Every literal of a generated expression travels in its identity text tagged by its carrier: a bigint as ~n:, a
 * Numeric as ~d:, Money (the owned value or its text) as ~m:, a Vector as ~v:, each with its exact payload; a string
 * whose first character is a tilde with the tilde doubled; and nothing as null.
 */
export type TagFeature = "~n" | "~d" | "~m" | "~v" | "an escaped tilde" | "an owned value kept"

/** Every literal a value holds, in order. */
export const literalsOf = (value: unknown): ReadonlyArray<unknown> => {
	if (value === null || typeof value !== "object") {
		return []
	}
	const own: ReadonlyArray<unknown> =
		Reflect.get(value, "kind") === "literal"
			? [Reflect.get(value, "value")]
			: Reflect.get(value, "kind") === "in"
				? [Reflect.get(value, "values")].flat()
				: []
	return [
		...own,
		...Arr.flatMap(Rec.values(value), (member) => (isPlainNode(member) ? literalsOf(member) : []))
	]
}

/** Whether a value is a plain node of a description: an array or a plain object. */
const isPlainNode = (value: unknown): boolean =>
	Arr.isArray(value) ||
	(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)

/** A value the canonical encoding tags: the tag and payload it states for itself. */
const isTagged = (value: unknown): value is Canonicalizable =>
	value !== null &&
	typeof value === "object" &&
	typeof Reflect.get(value, canonicalTag) === "function"

/** The tag feature of each tagged payload's letter. */
const tagFeatures: Readonly<Record<string, TagFeature>> = { d: "~d", m: "~m", v: "~v" }

/** The tag a literal carries and its canonical text, or untagged. */
export const tagOf = (literal: unknown): readonly [TagFeature, string] | "untagged" => {
	if (typeof literal === "bigint") {
		return ["~n", `"~n:${literal}"`]
	}
	if (isTagged(literal)) {
		const { tag, payload } = literal[canonicalTag]()
		const feature = tagFeatures[tag]
		return feature === undefined ? "untagged" : [feature, `"~${tag}:${payload}"`]
	}
	if (
		typeof literal === "string" &&
		Str.startsWith("~")(literal) &&
		regex("^[\\x20-\\x7e]*$").test(literal) &&
		!regex('["\\\\]').test(literal)
	) {
		return ["an escaped tilde", `"~${literal}"`]
	}
	return "untagged"
}

/**
 * The owned Money and a Vector's canonical snapshot are literals too: decoding keeps them as they are, and they carry
 * the same text as their payload texts.
 */
/** A component of no zero: a float32 of either sign, at least the least subnormal. */
const leastFloat32 = 2 ** binary32LeastExponent

/** A vector component a float32 holds, nonzero. */
const nonzeroComponent: Gen<number> = oneOf([float(-4, -leastFloat32), float(leastFloat32, 4)])

/** A literal of an owned value: a Numeric, a Money or a Vector. */
export const ownedGen: Gen<ExprDesc> = map(
	(source) =>
		[
			source.draw(bigint(-(2n ** 63n), 2n ** 63n - 1n)),
			[source.draw(nonzeroComponent), ...source.draw(array(float(-4, 4), { min: 0, max: 3 }))]
		] as const,
	([units, xs]): ExprDesc => {
		const vector = succeeded(Vector.canonical(Vector.make(Float32Array.from(xs), xs.length)))
		return { kind: "in", arg: { kind: "var", var: "v" }, values: [Money.of(units), vector] }
	}
)

/**
 * An and or or of no operand, written as untyped JavaScript where a Description may hold one: alone, as the first or
 * the second operand of a connective beside a generated expression, or negated.
 */
type EmptyPlace = "alone" | "a first operand" | "a second operand" | "negated"

/** What an empty connective case reached: and or or, and where it stood. */
export type EmptyFeature = "an empty conjunction" | "an empty disjunction" | EmptyPlace

/** An empty connective, and where it stands. */
interface Emptied {
	readonly kind: "and" | "or"
	readonly place: EmptyPlace
	readonly outer: "and" | "or"
	readonly beside: ExprDesc
}

/** An empty and or or, and where it stands. */
export const emptiedGen: Gen<Emptied> = (source) => ({
	kind: source.draw(element(["and", "or"] as const)),
	place: source.draw(element(["alone", "a first operand", "a second operand", "negated"] as const)),
	outer: source.draw(element(["and", "or"] as const)),
	beside: source.draw(exprsGen)
})

/**
 * The case as written, and the expression it means: the same expression, its empty connective the constant `unit`
 * and the generated expression beside it decoded.
 */
export const emptied = (
	s: Emptied,
	unit: ExprDesc,
	beside: ExprDesc
): readonly [unknown, ExprDesc] => {
	const empty = { kind: s.kind, args: [] }
	switch (s.place) {
		case "alone":
			return [empty, unit]
		case "a first operand":
			return [
				{ kind: s.outer, args: [empty, s.beside] },
				{ kind: s.outer, args: [unit, beside] }
			]
		case "a second operand":
			return [
				{ kind: s.outer, args: [s.beside, empty] },
				{ kind: s.outer, args: [beside, unit] }
			]
		case "negated":
			return [
				{ kind: "not", arg: empty },
				{ kind: "not", arg: unit }
			]
	}
}

/** The location an author states. */
export const stated = SourceLoc("stated by the author", ["builder"])

/** The kinds whose descriptions hold a located node, as the samples, which hold every kind, show. */
export const locatedKinds = nonEmpty(
	Arr.dedupe(
		Arr.flatMap(samples, ([kind, value]) =>
			Arr.isReadonlyArrayNonEmpty(located(succeeded(decodeHanded(kind, value)), [])) ? [kind] : []
		)
	),
	"the located kinds"
)

/** One combinator. */
const combinator = element<Combinator>(["order", "take 2", "take 5", "approximate", "a rule after"])

/** Up to four combinators. */
export const chain = array(combinator, { min: 0, max: 4 })

/** The query an order over the budget rule is. */
export const top: QueryDesc = versioned({
	kind: "order",
	input: rules(budgetRule),
	order: [{ column: "budget", dir: "asc" }]
})

/** An aggregate function. */
type AggregateFn = "count" | "sum" | "mean" | "min" | "max"

/** A compute call with a scale or none, or an aggregate with an argument or none. */
type DecoderCase =
	| {
			readonly kind: "compute"
			readonly fn: ComputeFn
			readonly args: number
			readonly scale: Option.Option<number>
	  }
	| { readonly kind: "aggregate"; readonly fn: AggregateFn; readonly arg: boolean }

/** Any function of the catalogue, called on any count of arguments, which the decoder never reads. */
export const space = oneOf<DecoderCase>([
	(source) => ({
		kind: "compute",
		fn: source.draw(element(computeFns)),
		args: source.draw(int(1, 4)),
		scale: source.draw(option(int(-2, 4)))
	}),
	(source) => ({
		kind: "aggregate",
		fn: source.draw(element<AggregateFn>(["count", "sum", "mean", "min", "max"])),
		arg: source.draw(boolean)
	})
])
