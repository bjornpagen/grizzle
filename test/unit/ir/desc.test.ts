import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required, requiredInSpace } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	constant,
	element,
	filter,
	type Gen,
	int,
	map,
	oneOf,
	string,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint, float } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, pipe, Record as Rec, String as Str } from "effect"
import { indices } from "#compiler/core/array.ts"
import { type Canonicalizable, canonicalTag, type Json } from "#compiler/core/canonical.ts"
import { formatLoc, SourceLoc } from "#compiler/core/loc.ts"
import { isRecord } from "#compiler/core/record.ts"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { MoneyText, VectorText } from "#compiler/ir/carriers.ts"
import { DecimalText } from "#compiler/ir/decimal.ts"
import {
	type ComputeFn,
	computeFns,
	type DescKind,
	decodeDesc,
	descText,
	descToJson,
	everyFact,
	type FieldDecl,
	type FieldDesc,
	type LiteralDesc
} from "#compiler/ir/desc.ts"
import { Compute } from "#compiler/public/compute.ts"
import { predicateExpr } from "#compiler/scalar/compute/term.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import {
	assert,
	containsText,
	defined,
	lacksText,
	nonEmpty,
	refusalLoc,
	succeeded
} from "#test/support/assert.ts"

import { descFromJson } from "#test/support/describe.ts"
import type {
	ChangeSetDesc,
	WorkloadDesc,
	AuthoredExprDesc as ExprDesc,
	QueryDesc,
	QueryStageDesc,
	AuthoredRelationDesc as RelationDesc,
	RuleDesc,
	SchemaDesc,
	AuthoredStatementDesc as StatementDesc
} from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { fail } from "#test/unit/ir/fixture.ts"

import { regex } from "arkregex"
const dec = (text: string) => defined(DecimalText.parse(text))

const budget: FieldDesc = {
	kind: "contract",
	name: "Budget",
	base: { kind: "numeric", precision: 12, scale: 2 },
	predicate: {
		kind: "between",
		arg: { kind: "value" },
		low: { kind: "literal", value: 0n, type: undefined },
		high: { kind: "literal", value: dec("1000000"), type: undefined }
	},
	facts: []
}

/** A field its caller writes. */
const caller = (type: FieldDesc): FieldDecl<object> => ({ type, writing: { kind: "caller" } })

/** Task's fields: one of each type, and one of each way a field is written. */
const fields: Readonly<Record<string, FieldDecl<object>>> = {
	id: caller({ kind: "uuid" }),
	account: caller({ kind: "uuid" }),
	kind: caller({ kind: "closedId", roster: "Kind" }),
	kinds: caller({ kind: "bits", roster: "Kind" }),
	budget: caller(budget),
	title: caller({ kind: "text", source: "^[A-Za-z ]{1,80}$", flags: "u" }),
	priority: caller({ kind: "pg", type: "integer" }),
	seq: { type: { kind: "pg", type: "bigint" }, writing: { kind: "serial" } },
	twice: {
		type: { kind: "pg", type: "bigint" },
		writing: {
			kind: "generated",
			expr: {
				kind: "compute",
				fn: "mul",
				args: [
					{ kind: "field", field: "priority" },
					{ kind: "literal", value: 2n, type: undefined }
				]
			}
		}
	},
	at: { type: { kind: "pg", type: "integer" }, writing: { kind: "drawn" } },
	running: { type: { kind: "pg", type: "bigint" }, writing: { kind: "accumulated", start: 0n } },
	window: caller({ kind: "span", endpoint: { kind: "pg", type: "bigint" }, width: 86_400n }),
	embedding: caller({ kind: "vector", dimensions: 3 }),
	cost: caller({ kind: "pg", type: "money" })
}

const rules = (...arms: Arr.NonEmptyReadonlyArray<RuleDesc>): QueryStageDesc => ({
	kind: "rules",
	arms
})
const versioned = (stage: QueryStageDesc): QueryDesc => ({ stage })

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

const rule: RuleDesc = {
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
			left: { kind: "literal", value: { span: { start: 1n, end: 5n } }, type: undefined },
			mask: 0b1_1111_1111,
			right: { kind: "literal", value: { span: { start: 3, end: 9 } }, type: undefined }
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
				{ kind: "literal", value: 2n, type: undefined }
			]
		},
		rounded: { kind: "compute", fn: "round", args: [{ kind: "var", var: "v3" }], scale: 1 },
		flag: {
			kind: "cond",
			pred: { kind: "var", var: "v1" },
			onTrue: { kind: "literal", value: 1, type: undefined },
			onFalse: { kind: "literal", value: 0, type: undefined }
		},
		nan: {
			kind: "literal",
			value: { float: "NaN" },
			type: { kind: "pg", type: "double precision" }
		},
		price: {
			kind: "literal",
			value: defined(MoneyText.parse("1999")),
			type: { kind: "pg", type: "money" }
		},
		probe: {
			kind: "literal",
			value: succeeded(VectorText.of(Float32Array.of(0.5, 1, 0.25))),
			type: undefined
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

const budgetRule: RuleDesc = {
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

const reach: QueryStageDesc = {
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

const recursive: QueryDesc = versioned({ kind: "approx", input: reach, by: "distance", take: 20 })

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
			right: { kind: "literal", value: 0, type: undefined }
		}
	},
	{
		kind: "alternatives",
		parent: { relation: "Task", terms: [{ kind: "field", field: "id" }], selection: everyFact },
		discriminator: "kind",
		roster: "Kind",
		arms: [
			{
				handle: "Automatic",
				arm: {
					relation: "AutomaticTask",
					terms: [{ kind: "field", field: "task" }],
					selection: everyFact
				}
			}
		]
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
		root: "document"
	}
]

/** A derived definition reads no parameter and has no bound. */
const unbounded: QueryDesc = versioned(attached)

/** Each tier's plan: a closed relation keyed by a closed id of the roster Tier. */
const plan: RelationDesc = {
	kind: "closedRelation",
	name: "Plan",
	fields: {
		tier: { kind: "closedId", roster: "Tier" },
		seats: { kind: "pg", type: "integer" },
		price: { kind: "numeric", precision: 10, scale: 2 }
	},
	key: ["tier"],
	slots: [],
	pack: "rows",
	rows: [
		{ tier: "Free", seats: 1, price: dec("0") },
		{ tier: "Pro", seats: 10, price: dec("49") }
	]
}

const relations: ReadonlyArray<RelationDesc> = [
	{ kind: "relation", name: "Task", fields, primaryKey: ["id"] },
	{ kind: "closed", name: "Kind", handles: ["Automatic", "Manual"] },
	{ kind: "closed", name: "Tier", handles: ["Free", "Pro"] },
	plan,
	{
		kind: "closedRelation",
		name: "Fee",
		fields: { tier: { kind: "closedId", roster: "Tier" }, amount: { kind: "pg", type: "money" } },
		key: ["tier"],
		slots: [],
		pack: "rows",
		rows: [{ tier: "Pro", amount: defined(MoneyText.parse("1999")) }]
	},
	{
		kind: "derived",
		name: "Totals",
		query: unbounded,
		level: 1
	}
]

const base: SchemaDesc = {
	name: "Work",
	relations: relations.slice(0, 5),
	statements: statements.slice(0, 4),
	extends: undefined
}

const schema: SchemaDesc = {
	name: "Work",
	relations: relations.slice(5),
	statements: statements.slice(4),
	extends: base
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
				point: { kind: "param", name: "now", type: { kind: "pg", type: "bigint" } },
				span: { kind: "var", var: "v2" }
			}
		],
		head: { id: { kind: "var", var: "v1" } },
		interiors: [],
		attach: []
	})
)

const changeSet: ChangeSetDesc = {
	schema: "Work",
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
	bindings: ["now"]
}

const workload: WorkloadDesc = {
	schema: "Work",
	programs: {
		budgets: { kind: "query", query },
		reach: { kind: "query", query: recursive },
		claim: { kind: "changeSet", changeSet }
	}
}

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
			point: { kind: "literal", value: 4n, type: undefined },
			span: { kind: "literal", value: { span: { start: 1n, end: 5n } }, type: undefined }
		}
	]
}

const samples: ReadonlyArray<readonly [DescKind, unknown]> = [
	["schema", schema],
	["statement", statements[5]],
	["statement", statements[8]],
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

/** The JSON form written as JSON text and parsed back: what a process boundary does. */
const throughJson = (value: unknown): unknown =>
	trustedJson<Json>(jsonText(succeeded(descToJson(value))))

const refuses = (kind: DescKind, value: unknown) => {
	assert.equal(fail(decodeDesc(kind, value)).reason._tag, "MalformedDescription")
}

const side = (relation: string, field: string) => ({
	relation,
	terms: [{ kind: "field", field }],
	selection: everyFact
})

/** `innermost` under `depth` relational negations. */
const notChain = (depth: number, innermost: unknown): unknown => {
	let e = innermost
	for (let i = 0; i < depth; i++) {
		e = { kind: "not", arg: e }
	}
	return e
}

describe("Descriptions", () => {
	for (const [i, [kind, value]] of samples.entries()) {
		it(`${kind} #${i} round-trips JSON`, () => {
			/**
			 * Decoding locates the nodes the value leaves unlocated and changes nothing else: the identity text is the
			 * value's, and decoding the owned copy again, or the value's JSON, gives the same copy.
			 */
			const owned = succeeded(decodeDesc(kind, value))
			assert.equal(succeeded(descText(owned)), succeeded(descText(value)))
			assert.deepEqual(succeeded(decodeDesc(kind, owned)), owned)
			const back = succeeded(descFromJson(kind, throughJson(value)))
			assert.deepEqual(back, owned)
			assert.equal(succeeded(descText(back)), succeeded(descText(value)))
		})
	}

	/** Every object of a decoded description that carries a location, with its path in the description. */
	const located = (
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
	const statedAt = (
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
	type LocatedFeature = `located ${DescKind}` | `stated ${DescKind}`

	it.effect(
		"locates every node a JavaScript author leaves unlocated by its path, and keeps a stated location",
		(ctx) => {
			const stated = SourceLoc("stated by the author", ["builder"])
			const sites = Arr.flatMap(samples, ([kind, value]) => [
				{ kind, value, site: "none" as const },
				...Arr.map(located(succeeded(decodeDesc(kind, value)), []), (l) => ({
					kind,
					value,
					site: l.path
				}))
			])
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/ir/desc-locations",
						literal: Formatter.format,
						generator: element(nonEmpty(sites, "the location sites")),
						limit: 2000,
						coverage: requiredInSpace<LocatedFeature>(
							Arr.flatMap(
								nonEmpty(
									Arr.dedupe(Arr.flatMap(sites, (x) => (x.site === "none" ? [] : [x.kind]))),
									"the located kinds"
								),
								(kind): Arr.NonEmptyReadonlyArray<LocatedFeature> => [
									`located ${kind}`,
									`stated ${kind}`
								]
							)
						),
						caseHang
					},
					({ kind, value, site }, c) =>
						Effect.sync(() => {
							const input = site === "none" ? value : statedAt(value, site, stated)
							assert.equal(succeeded(descText(input)), succeeded(descText(value)))
							if (site !== "none") {
								assert.notDeepEqual(succeeded(descToJson(input)), succeeded(descToJson(value)))
							}
							/** One label names the description every unstated location lies in; the path is the node's own. */
							const labels = new Set<unknown>()
							for (const l of located(succeeded(decodeDesc(kind, input)), [])) {
								const isStated =
									site !== "none" &&
									l.path.length === site.length &&
									Arr.every(l.path, (p, i) => p === site[i])
								c.note(isStated ? `stated ${kind}` : `located ${kind}`)
								if (isStated) {
									assert.deepEqual(l.loc, stated)
									continue
								}
								assert.ok(l.loc !== null && typeof l.loc === "object", "a location")
								assert.deepEqual(Reflect.get(l.loc, "path"), l.path)
								labels.add(Reflect.get(l.loc, "label"))
							}
							assert.ok(
								labels.size <= 1,
								`one description label: ${Arr.join(
									Arr.map([...labels], (label) => String(label)),
									", "
								)}`
							)
						})
				)
			)
		}
	)

	/**
	 * A query description keeps the order of its combinators, so queryFromDescription rebuilds the same query: two
	 * chains of combinators over one rule, or over a recursion, that both decode are one description exactly when they
	 * are one chain, and each round-trips JSON. The combinators: orderBy, take(k), approximateNearest, and a rule added
	 * after them.
	 */
	type Combinator = "order" | "take 2" | "take 5" | "approximate" | "a rule after"
	const armB: RuleDesc = {
		...budgetRule,
		head: {
			budget: { kind: "var", var: "v9" },
			extra: { kind: "literal", value: 1, type: undefined }
		}
	}
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
	const chained = (start: QueryStageDesc, chain: ReadonlyArray<Combinator>): QueryStageDesc => {
		let stage = start
		for (const combinator of chain) {
			stage = combined(stage, combinator)
		}
		return stage
	}
	const roundTrips = (q: QueryDesc): string => {
		const back = succeeded(descFromJson("query", throughJson(q)))
		assert.deepEqual(back, succeeded(decodeDesc("query", q)))
		assert.equal(succeeded(descText(back)), succeeded(descText(q)))
		return succeeded(descText(q))
	}
	it.effect(
		"keeps the order of a query's combinators: two chains are one description exactly when they are one chain",
		(ctx) => {
			const combinator = element<Combinator>([
				"order",
				"take 2",
				"take 5",
				"approximate",
				"a rule after"
			])
			const chain = array(combinator, { min: 0, max: 4 })
			return searched(
				ctx,
				explore(
					{
						suite: "unit/ir/desc-combinator-order",
						literal: Formatter.format,
						draw: drawn(
							(source) => [source.draw(boolean), source.draw(chain), source.draw(chain)] as const
						),
						runs: 500,
						shrink: completeShrink,
						coverage: required<
							"two chains told apart" | "one chain" | "over a recursion" | "a chain refused"
						>(["two chains told apart", "one chain", "over a recursion", "a chain refused"], {
							cases: 500,
							sense: notesOnly
						}),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([overRecursion, a, b], c) =>
						Effect.sync(() => {
							const start = overRecursion ? reach : rules(budgetRule)
							if (overRecursion) {
								c.note("over a recursion")
							}
							const [qa, qb] = [versioned(chained(start, a)), versioned(chained(start, b))]
							const [da, db] = [decodeDesc("query", qa), decodeDesc("query", qb)]
							if (!da.ok || !db.ok) {
								c.note("a chain refused")
								return
							}
							const same = a.length === b.length && Arr.every(a, (x, i) => x === b[i])
							c.note(same ? "one chain" : "two chains told apart")
							assert.equal(roundTrips(qa) === roundTrips(qb), same)
						})
				)
			)
		}
	)

	it.effect("admits an Ordered exactly where a whole query stands", (ctx) => {
		const top: QueryDesc = versioned({
			kind: "order",
			input: rules(budgetRule),
			order: [{ column: "budget", dir: "asc" }]
		})
		type Position =
			| "a page's query"
			| "an attachment child"
			| "a read-back"
			| "a workload program"
			| "an imported source"
			| "a ChangeSet member"
			| "a derived definition"
		const placed = (position: Position): readonly [DescKind, unknown] => {
			switch (position) {
				case "a page's query":
					return ["query", top]
				case "an attachment child":
					return [
						"query",
						versioned({ kind: "attach", input: rules(rule), attach: { name: "a", child: top } })
					]
				case "a read-back":
					return ["changeSet", { ...changeSet, reads: [{ name: "page", query: top }] }]
				case "a workload program":
					return ["workload", { ...workload, programs: { ordered: { kind: "query", query: top } } }]
				case "an imported source":
					return [
						"rule",
						{ ...rule, matches: [{ source: { kind: "query", query: top }, bindings: {} }] }
					]
				case "a ChangeSet member":
					return [
						"changeSet",
						{
							...changeSet,
							strata: [
								{
									members: [
										{ op: "insert", relation: "Task", member: { kind: "query", query: top } }
									]
								}
							]
						}
					]
				case "a derived definition":
					return ["relation", { kind: "derived", name: "D", query: top, level: 1 }]
			}
		}
		const whole: ReadonlyArray<Position> = [
			"a page's query",
			"an attachment child",
			"a read-back",
			"a workload program"
		]
		return searched(
			ctx,
			exhaust(
				{
					suite: "unit/ir/desc-ordered-positions",
					literal: Formatter.format,
					generator: element<Position>([
						"a page's query",
						"an attachment child",
						"a read-back",
						"a workload program",
						"an imported source",
						"a ChangeSet member",
						"a derived definition"
					]),
					limit: 7,
					coverage: requiredInSpace<Position>([
						"a page's query",
						"an attachment child",
						"a read-back",
						"a workload program",
						"an imported source",
						"a ChangeSet member",
						"a derived definition"
					]),
					caseHang
				},
				(position, c) =>
					Effect.sync(() => {
						c.note(position)
						const [kind, value] = placed(position)
						if (whole.includes(position)) {
							succeeded(decodeDesc(kind, value))
						} else {
							refuses(kind, value)
						}
					})
			)
		)
	})

	it.effect(
		"decodes a scale and an aggregate's argument exactly where their arm states them, refuses each at it, and refuses an origin on every statement",
		(ctx) => {
			type AggregateFn = "count" | "sum" | "mean" | "min" | "max"
			/** The statements an origin is tried on: none states one, a containment included (R5 deleted the origin). */
			type OriginKind = "key" | "mutable" | "check" | "contained"
			type DecoderCase =
				| { readonly kind: "compute"; readonly fn: ComputeFn; readonly scale: "absent" | 2 }
				| { readonly kind: "statement"; readonly statement: OriginKind }
				| { readonly kind: "aggregate"; readonly fn: AggregateFn; readonly arg: boolean }
			/**
			 * The arguments each function's call states: the decoder reads none of their count, so any count is an input.
			 */
			const arity: Readonly<Record<ComputeFn, number>> = {
				add: 2,
				sub: 2,
				mul: 2,
				div: 2,
				mod: 2,
				neg: 1,
				quot: 2,
				rem: 2,
				abs: 1,
				sign: 1,
				round: 1,
				trunc: 1,
				ceil: 1,
				floor: 1,
				gcd: 2,
				lcm: 2,
				power: 2,
				sqrt: 1,
				least: 2,
				greatest: 2,
				widthBucket: 4,
				minScale: 1,
				union: 2,
				intersection: 2,
				difference: 2,
				cardinality: 1,
				subset: 2,
				disjoint: 2,
				numeric: 1,
				lower: 1,
				upper: 1,
				width: 1,
				charLength: 1,
				concat: 2,
				startsWith: 2,
				endsWith: 2,
				matches: 2,
				cosineDistance: 2
			}
			const origin = { alternatives: "A" }
			const statementOf = (kind: OriginKind): unknown => {
				switch (kind) {
					case "key":
						return { kind, side: side("R", "a"), origin }
					case "mutable":
						return { kind, relation: "R", origin }
					case "check":
						return {
							kind,
							name: "positive",
							relation: "R",
							predicate: {
								kind: "compare",
								op: "gt",
								left: { kind: "field", field: "a" },
								right: { kind: "field", field: "b" }
							},
							origin
						}
					case "contained":
						return { kind, left: side("R", "a"), right: side("S", "id"), origin }
				}
			}
			const space = oneOf<DecoderCase>([
				(source) => ({
					kind: "compute",
					fn: source.draw(element(computeFns)),
					scale: source.draw(element<"absent" | 2>(["absent", 2]))
				}),
				map(
					element<OriginKind>(["key", "mutable", "check", "contained"]),
					(statement): DecoderCase => ({
						kind: "statement",
						statement
					})
				),
				(source) => ({
					kind: "aggregate",
					fn: source.draw(element<AggregateFn>(["count", "sum", "mean", "min", "max"])),
					arg: source.draw(boolean)
				})
			])
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/ir/desc-dependent-absences",
						literal: Formatter.format,
						generator: space,
						limit: 100,
						coverage: requiredInSpace<
							| "scale refused"
							| "scale decoded"
							| "origin refused"
							| "aggregate refused"
							| "aggregate decoded"
						>([
							"scale refused",
							"scale decoded",
							"origin refused",
							"aggregate refused",
							"aggregate decoded"
						]),
						caseHang
					},
					(c, n) =>
						Effect.sync(() => {
							switch (c.kind) {
								case "compute": {
									const args = Arr.map(indices(arity[c.fn]), (i) => ({
										kind: "field",
										field: `f${i}`
									}))
									const decoded = decodeDesc(
										"expr",
										c.scale === "absent"
											? { kind: "compute", fn: c.fn, args }
											: { kind: "compute", fn: c.fn, args, scale: c.scale }
									)
									const admitted = c.scale === "absent" || c.fn === "round" || c.fn === "trunc"
									assert.equal(decoded.ok, admitted, `${c.fn} with scale ${c.scale}`)
									if (decoded.ok) {
										n.note("scale decoded")
										return
									}
									n.note("scale refused")
									assert.equal(decoded.error.reason._tag, "MalformedDescription")
									containsText(formatLoc(refusalLoc(decoded.error)), "scale")
									return
								}
								case "statement": {
									const decoded = decodeDesc("statement", statementOf(c.statement))
									n.note("origin refused")
									const error = fail(decoded)
									assert.equal(error.reason._tag, "MalformedDescription")
									containsText(formatLoc(refusalLoc(error)), "origin")
									return
								}
								case "aggregate": {
									const term = c.arg
										? { kind: "aggregate", fn: c.fn, arg: { kind: "var", var: "v1" } }
										: { kind: "aggregate", fn: c.fn }
									const decoded = decodeDesc("rule", { ...rule, head: { n: term } })
									assert.equal(
										decoded.ok,
										c.arg === (c.fn !== "count"),
										`${c.fn} with arg ${c.arg}`
									)
									n.note(decoded.ok ? "aggregate decoded" : "aggregate refused")
									return
								}
							}
						})
				)
			)
		}
	)

	/** The value with `f` applied to the part at `path`. */
	const editedAt = (
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
	const records = new Set([
		"fields",
		"bindings",
		"head",
		"row",
		"facts",
		"programs",
		"bind",
		"payload"
	])
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
		const struct = !Arr.isArray(value) && !(typeof last === "string" && records.has(last))
		return [
			{ path, struct },
			...Arr.flatMap(Rec.toEntries(value), ([key, member]) =>
				partsOf(member, [...path, Arr.isArray(value) ? Number(key) : key])
			)
		]
	}
	const ordered: QueryStageDesc = {
		kind: "order",
		input: rules(rule),
		order: [{ column: "account", dir: "asc" }]
	}
	/**
	 * The Description boundary's own rules, each broken in a sample: one version; a literal no JavaScript NaN, a money,
	 * vector or decimal tagged; take only after an order; a rules stage with an arm; on an Ordered only take; a union
	 * over a query, not over the builder's rules, which are one stage; each order column once; a primary key nonempty and
	 * among the fields; a relation's, a field's and a program's name storable text; a role with a relation; a context
	 * field of a claim's scalar type; a closed relation's rows each of every field, keyed by closed ids, one per key; a
	 * primary key its writer fills, never a generated field; an Allen mask of thirteen bits; a numeric precision 1-1000;
	 * each variable id once; a payload in JSON canonical.
	 */
	const broken: ReadonlyArray<readonly [string, DescKind, unknown]> = [
		["another version", "query", { ...query, v: 2 }],
		["a JavaScript NaN literal", "expr", { kind: "literal", value: Number.NaN }],
		[
			"take but no order",
			"query",
			versioned({ kind: "take", input: rules(rule), take: { kind: "literal", k: 1 } })
		],
		["a rules stage without arms", "query", { stage: { kind: "rules", arms: [] } }],
		[
			"an attachment on an Ordered",
			"query",
			versioned({ kind: "attach", input: ordered, attach: { name: "a", child } })
		],
		["a union on an Ordered", "query", versioned({ kind: "union", input: ordered, arms: [rule] })],
		["a name on an Ordered", "query", versioned({ kind: "named", input: ordered, name: "n" })],
		[
			"an order on an Ordered",
			"query",
			versioned({ kind: "order", input: ordered, order: [{ column: "id", dir: "asc" }] })
		],
		[
			"an approximate stage on an Ordered",
			"query",
			versioned({ kind: "approx", input: ordered, by: "d", take: 3 })
		],
		[
			"a union over the builder's rules",
			"query",
			versioned({ kind: "union", input: rules(rule), arms: [rule] })
		],
		[
			"a repeated order column",
			"query",
			versioned({
				kind: "order",
				input: rules(rule),
				order: [
					{ column: "account", dir: "asc" },
					{ column: "account", dir: "desc" }
				]
			})
		],
		["an untagged money literal", "expr", { kind: "literal", value: { money: 5n } }],
		["an untagged vector literal", "expr", { kind: "literal", value: { vector: [1, 2] } }],
		["an untagged decimal", "expr", { kind: "literal", value: { canonical: "1.5" } }],
		[
			"a primary key outside the fields",
			"relation",
			{ kind: "relation", name: "R", fields: { a: caller({ kind: "uuid" }) }, primaryKey: ["b"] }
		],
		[
			"an empty primary key",
			"relation",
			{ kind: "relation", name: "R", fields: { a: caller({ kind: "uuid" }) }, primaryKey: [] }
		],
		...Arr.flatMap(
			["\ud800", "a\u0000b"],
			(bad): ReadonlyArray<readonly [string, DescKind, unknown]> => [
				[
					`a relation name ${Formatter.format(bad)}`,
					"relation",
					{
						kind: "relation",
						name: bad,
						fields: { a: caller({ kind: "uuid" }) },
						primaryKey: ["a"]
					}
				],
				[
					`a field name ${Formatter.format(bad)}`,
					"relation",
					{
						kind: "relation",
						name: "R",
						fields: { a: caller({ kind: "uuid" }), [bad]: caller({ kind: "uuid" }) },
						primaryKey: ["a"]
					}
				],
				[
					`a program name ${Formatter.format(bad)}`,
					"workload",
					{ schema: "S", programs: { [bad]: { kind: "query", query } } }
				]
			]
		),
		[
			"a role with no relation",
			"role",
			{
				name: "r",
				base: { name: "S", relations, statements: [] },
				relations: [],
				write: [],
				refresh: []
			}
		],
		[
			"a context field of a numeric type, which no claim carries exactly",
			"context",
			{ name: "Session", fields: { amount: { kind: "numeric", precision: 10, scale: 2 } } }
		],
		[
			"a closed relation's row without a field",
			"relation",
			{ ...plan, rows: [{ tier: "Free", seats: 1 }] }
		],
		[
			"two closed rows at one key",
			"relation",
			{
				...plan,
				rows: [
					{ tier: "Free", seats: 1, price: dec("0") },
					{ tier: "Free", seats: 2, price: dec("1") }
				]
			}
		],
		["a closed relation keyed by an open field", "relation", { ...plan, key: ["seats"] }],
		[
			"a primary key over a generated field",
			"relation",
			{
				kind: "relation",
				name: "R",
				fields: {
					a: {
						type: { kind: "pg", type: "integer" },
						writing: { kind: "generated", expr: { kind: "literal", value: 1, type: undefined } }
					}
				},
				primaryKey: ["a"]
			}
		],
		...Arr.map([8192, -1, 1.5], (mask): readonly [string, DescKind, unknown] => [
			`an Allen mask ${mask}`,
			"expr",
			{ kind: "allen", left: { kind: "var", var: "a" }, mask, right: { kind: "var", var: "b" } }
		]),
		...Arr.map([0, 1001], (precision): readonly [string, DescKind, unknown] => [
			`a numeric precision ${precision}`,
			"field",
			{ kind: "numeric", precision }
		]),
		["a repeated variable id", "rule", { ...rule, vars: [{ id: "v1" }, { id: "v1" }] }]
	]
	const malformedPayloads = ["~d:1.2.3", "~m:-0", "~m:1.5", "~v:[0.1]", "~v:[1]@"] as const
	type Corrupt =
		| {
				readonly kind: "null"
				readonly sample: number
				readonly path: ReadonlyArray<string | number>
		  }
		| {
				readonly kind: "unknown property"
				readonly sample: number
				readonly path: ReadonlyArray<string | number>
		  }
		| {
				readonly kind: "a broken rule"
				readonly rule: string
				readonly desc: DescKind
				readonly value: unknown
		  }
		| { readonly kind: "a malformed payload"; readonly text: string }
	type CorruptFeature = Corrupt["kind"] | `broken: ${string}`

	it.effect("refuses every description broken at one part or one rule", (ctx) => {
		const corruptions = oneOf<Corrupt>([
			map(
				element(
					nonEmpty(
						Arr.flatMap(samples, ([, value], sample) =>
							Arr.map(partsOf(value, []), (part) => ({ sample, part }))
						),
						"the samples' parts"
					)
				),
				({ sample, part }): Corrupt => ({ kind: "null", sample, path: part.path })
			),
			map(
				element(
					nonEmpty(
						Arr.flatMap(samples, ([, value], sample) =>
							Arr.flatMap(partsOf(value, []), (part) =>
								part.struct ? [{ sample, path: part.path }] : []
							)
						),
						"the samples' structs"
					)
				),
				({ sample, path }): Corrupt => ({ kind: "unknown property", sample, path })
			),
			map(element(nonEmpty(broken, "the broken rules")), ([rule, desc, value]): Corrupt => ({
				kind: "a broken rule",
				rule,
				desc,
				value
			})),
			map(element(malformedPayloads), (text): Corrupt => ({
				kind: "a malformed payload",
				text
			}))
		])
		return searched(
			ctx,
			exhaust(
				{
					suite: "unit/ir/desc-corruptions",
					literal: Formatter.format,
					generator: corruptions,
					limit: 20_000,
					coverage: requiredInSpace<CorruptFeature>([
						"null",
						"unknown property",
						"a malformed payload",
						...Arr.map(broken, ([rule]): CorruptFeature => `broken: ${rule}`)
					]),
					caseHang
				},
				(corrupt, c) =>
					Effect.sync(() => {
						switch (corrupt.kind) {
							case "null":
							case "unknown property": {
								c.note(corrupt.kind)
								const [kind, value] = defined(samples[corrupt.sample])
								refuses(
									kind,
									editedAt(value, corrupt.path, (part) =>
										corrupt.kind === "null"
											? null
											: { ...(isRecord(part) ? part : {}), unknownProperty: 1 }
									)
								)
								return
							}
							case "a broken rule":
								c.note(`broken: ${corrupt.rule}`)
								refuses(corrupt.desc, corrupt.value)
								return
							case "a malformed payload":
								c.note(corrupt.kind)
								assert.equal(
									fail(descFromJson("expr", { kind: "literal", value: corrupt.text })).reason._tag,
									"MalformedDescription"
								)
						}
					})
			)
		)
	})

	/**
	 * An in-memory description of any depth decodes, as its text form does, and never overflows the stack; a cyclic one
	 * is MalformedDescription, and a value shared between siblings or levels is no cycle. The chains of r.not run from
	 * none to one a recursion would overflow the stack on.
	 */
	type Nesting =
		| { readonly kind: "a chain"; readonly depth: number }
		| { readonly kind: "a cycle"; readonly length: number; readonly back: number }
		| { readonly kind: "an array cycle" }
		| { readonly kind: "shared"; readonly depth: number }
	it.effect(
		"decodes an in-memory expression nested to any depth, and refuses a cyclic one",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/ir/desc-nesting",
						literal: Formatter.format,
						generator: oneOf<Nesting>([
							map(element([0, 1, 2, 100_000]), (depth): Nesting => ({
								kind: "a chain",
								depth
							})),
							(source) => {
								const length = source.draw(int(1, 4))
								return { kind: "a cycle", length, back: source.draw(int(0, length - 1)) }
							},
							constant<Nesting>({ kind: "an array cycle" }),
							map(int(0, 3), (depth): Nesting => ({ kind: "shared", depth }))
						]),
						limit: 100,
						coverage: requiredInSpace<Nesting["kind"]>([
							"a chain",
							"a cycle",
							"an array cycle",
							"shared"
						]),
						caseHang
					},
					(n, c) =>
						Effect.sync(() => {
							c.note(n.kind)
							switch (n.kind) {
								case "a chain": {
									/** The var at the bottom of `depth` r.not lies inside `depth` containers. */
									const chain = notChain(n.depth, { kind: "var", var: "v" })
									succeeded(decodeDesc("expr", chain))
									return
								}
								case "a cycle": {
									/** A chain of `length` r.not whose last argument is the one `back` levels below the root. */
									const nodes = Array.from(
										{ length: n.length },
										(): { kind: "not"; arg: unknown } => ({
											kind: "not",
											arg: undefined
										})
									)
									for (const [i, node] of nodes.entries()) {
										node.arg = i + 1 < nodes.length ? nodes[i + 1] : nodes[n.back]
									}
									assert.equal(
										fail(decodeDesc("expr", nodes[0])).reason._tag,
										"MalformedDescription"
									)
									return
								}
								case "an array cycle": {
									const loop: Array<unknown> = []
									loop.push({ kind: "var", var: "v" }, { kind: "and", args: loop })
									assert.equal(
										fail(decodeDesc("expr", { kind: "and", args: loop })).reason._tag,
										"MalformedDescription"
									)
									return
								}
								case "shared": {
									const shared: ExprDesc = { kind: "var", var: "v" }
									succeeded(
										decodeDesc("expr", { kind: "and", args: [notChain(n.depth, shared), shared] })
									)
								}
							}
						})
				)
			)
	)

	/**
	 * Generated expressions: decode, JSON round trip and canonical text are stable under every shape the generator
	 * reaches, including bigints, decimals, money, vectors and strings that begin with "~".
	 */
	/** A string of printable ASCII, at least `min` and at most ten characters. */
	const text = (min: number) => string(codePoint(0x20, 0x7e), { min, max: 10 })
	/** The largest finite 32-bit float. */
	const floatMax = 3.4028234663852886e38
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
				type: { kind: "pg", type: "integer" }
			})),
			map(literal, (value): ExprDesc => ({ kind: "literal", value, type: undefined }))
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
	const exprsGen = exprGen(4)

	/**
	 * Every literal of a generated expression travels in its identity text tagged by its carrier: a bigint as ~n:, a
	 * Decimal as ~d:, Money (the owned value or its text) as ~m:, a Vector as ~v:, each with its exact payload; a string
	 * whose first character is a tilde with the tilde doubled; and nothing as null.
	 */
	type TagFeature = "~n" | "~d" | "~m" | "~v" | "an escaped tilde" | "an owned value kept"
	const literalsOf = (value: unknown): ReadonlyArray<unknown> => {
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
	const isPlainNode = (value: unknown): boolean =>
		Arr.isArray(value) ||
		(value !== null &&
			typeof value === "object" &&
			Object.getPrototypeOf(value) === Object.prototype)
	/** A value the canonical encoding tags: the tag and payload it states for itself. */
	const isTagged = (value: unknown): value is Canonicalizable =>
		value !== null &&
		typeof value === "object" &&
		typeof Reflect.get(value, canonicalTag) === "function"
	const tagFeatures: Readonly<Record<string, TagFeature>> = { d: "~d", m: "~m", v: "~v" }
	const tagOf = (literal: unknown): readonly [TagFeature, string] | "untagged" => {
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
	const ownedGen: Gen<ExprDesc> = map(
		filter(
			(source) =>
				[
					source.draw(bigint(-(2n ** 63n), 2n ** 63n - 1n)),
					source.draw(array(float(-4, 4), { min: 1, max: 4 }))
				] as const,
			([, xs]) => Arr.some(xs, (x) => x !== 0),
			10
		),
		([units, xs]): ExprDesc => {
			const vector = succeeded(Vector.canonical(Vector.make(Float32Array.from(xs), xs.length)))
			return { kind: "in", arg: { kind: "var", var: "v" }, values: [Money.of(units), vector] }
		}
	)
	it.effect(
		"carries bigint, Decimal, Money and Vector as tagged strings and escapes a leading tilde",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/ir/desc-tagged-literals",
						literal: Formatter.format,
						draw: drawn(
							weighted([
								[4, exprsGen],
								[1, ownedGen]
							])
						),
						runs: 500,
						shrink: completeShrink,
						coverage: required<TagFeature>(
							["~n", "~d", "~m", "~v", "an escaped tilde", "an owned value kept"],
							{ cases: 500, sense: notesOnly }
						),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(e, c) =>
						Effect.sync(() => {
							const text = succeeded(descText(e))
							lacksText(text, "null")
							const owned = succeeded(decodeDesc("expr", e))
							if (e.kind === "in" && owned.kind === "in") {
								for (const [i, value] of e.values.entries()) {
									if (value instanceof Money) {
										c.note("an owned value kept")
										assert.equal(owned.values[i], value)
									}
								}
							}
							for (const literal of literalsOf(e)) {
								const tagged = tagOf(literal)
								if (tagged === "untagged") {
									continue
								}
								c.note(tagged[0])
								containsText(text, tagged[1])
							}
						})
				)
			)
	)

	it.effect("round-trips generated expressions", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/ir/desc-19",
					literal: Formatter.format,
					draw: drawn(exprsGen),
					runs: 300,
					shrink: completeShrink,
					coverage: noCoverage,
					kept: [],
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(e) =>
					Effect.sync(() => {
						const back = succeeded(descFromJson("expr", throughJson(e)))
						assert.deepEqual(back, succeeded(decodeDesc("expr", e)))
						assert.equal(succeeded(descText(back)), succeeded(descText(e)))
					})
			)
		)
	)

	/**
	 * An and or or of no operand, written as untyped JavaScript where a Description may hold one: alone, as the first or
	 * the second operand of a connective beside a generated expression, or negated.
	 */
	type EmptyPlace = "alone" | "a first operand" | "a second operand" | "negated"
	type EmptyFeature = "an empty conjunction" | "an empty disjunction" | EmptyPlace
	interface Emptied {
		readonly kind: "and" | "or"
		readonly place: EmptyPlace
		readonly outer: "and" | "or"
		readonly beside: ExprDesc
	}
	const emptiedGen: Gen<Emptied> = (source) => ({
		kind: source.draw(element(["and", "or"] as const)),
		place: source.draw(
			element(["alone", "a first operand", "a second operand", "negated"] as const)
		),
		outer: source.draw(element(["and", "or"] as const)),
		beside: source.draw(exprsGen)
	})
	/**
	 * The case as written, and the expression it means: the same expression, its empty connective the constant `unit`
	 * and the generated expression beside it decoded.
	 */
	const emptied = (s: Emptied, unit: ExprDesc, beside: ExprDesc): readonly [unknown, ExprDesc] => {
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

	it.effect(
		"decodes an empty and or or to the constant its builder builds of no predicate",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/ir/desc-empty-connective",
						literal: Formatter.format,
						draw: drawn(emptiedGen),
						runs: 200,
						shrink: completeShrink,
						coverage: required<EmptyFeature>(
							[
								"an empty conjunction",
								"an empty disjunction",
								"alone",
								"a first operand",
								"a second operand",
								"negated"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							c.note(s.kind === "and" ? "an empty conjunction" : "an empty disjunction")
							c.note(s.place)
							const unit = succeeded(
								decodeDesc("expr", predicateExpr(s.kind === "and" ? Compute.and() : Compute.or()))
							)
							assert.deepEqual<ExprDesc>(unit, {
								kind: "literal",
								value: s.kind === "and",
								type: { kind: "pg", type: "boolean" }
							})
							const [written, meant] = emptied(s, unit, succeeded(decodeDesc("expr", s.beside)))
							assert.deepEqual<ExprDesc>(succeeded(decodeDesc("expr", written)), meant)
						})
				)
			)
	)
})
