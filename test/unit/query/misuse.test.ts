import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { constant, element, type Gen, map, oneOf } from "@grizzle/testing/gen"
import {
	type Drawn,
	type DrawnFeature,
	drawnFeature,
	lsw,
	passed,
	type Stale,
	WILD_KINDS
} from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { ALLEN } from "#compiler/allen/mask.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { type CompileReasonTag, isCompileError } from "#compiler/core/errors.ts"
import type { Built } from "#compiler/core/phantom.ts"
import { descText } from "#compiler/ir/desc.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import {
	type QueryValue,
	queryOver as query,
	queryValueDesc,
	varsOver as v
} from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { assert } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { Account, AutomaticTask, Task, TaskNote, Work } from "#test/support/fixtures/api/work.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	Booking,
	Document,
	DocumentCurrent,
	DocumentEmbedding,
	Preference,
	Schedule,
	Search,
	Settings
} from "#test/unit/query/fixtures.ts"

/**
 * The query builder's untyped core, handed Live, Stale and Wild arguments at every argument position, and the values it
 * branches on, as a JavaScript caller may hand them (G-lsw).
 *
 * Every argument position of the builder (the schema of query(S), a rule's callback, a match's source, a scope's name,
 * a match's bindings and one binding's value, a filter's predicate, each side of a comparison, a parameter's name and
 * descriptor, a negation's source and bindings, the head and one head term, an order pair, a take bound, an
 * attachment's name, child and delivery, a stage's name, approximateNearest's column and bound, an Allen left operand,
 * a pointIn point, a vector-valued binding) is given either its Live argument, inside an otherwise valid query, or a Wild value of every
 * kind the library draws (@grizzle/testing/lsw). A Stale argument is a value that was live in another scope of the builder: a
 * variable, a rule builder, a Finished, an interior stage, a parent variable or a self of another rule, attachment or
 * recursive definition, each named by where it comes from. A near miss is a value the builder branches on, one call
 * each at the position it names: a take bound, an order pair, an attachment name, a binding's value, an empty
 * conjunction, an aggregate over a carrier PostgreSQL does not define it for. The contract:
 *
 * - a Live argument builds a query whose Description has a canonical text;
 * - a Stale argument is refused at build time with exactly MalformedDescription;
 * - a Wild argument either builds such a query (a Wild string may well be a valid name) or throws a CompileError
 *   whose reason is MalformedDescription or UnsupportedOperation; it never throws anything else, and never builds a
 *   query whose Description has no canonical text;
 * - a near miss is refused with MalformedDescription or UnsupportedOperation, or builds a query with a canonical text
 *   that compiles to a template or to a CompileError, and never throws while it compiles.
 *
 * Every stale source, every wild kind, every position and every near miss is a required feature. A hostile proxy and
 * an object whose getter throws are refused at the entry that receives them (query/build/host.ts), before any read of
 * the builder's own reaches them.
 */
type Vars = ReturnType<typeof v>

/** The parent variables an attachment passes its child, as the builder's untyped core reads them. */
type ParentVars = Readonly<Record<string, unknown>>

/** An argument made inside a rule callback, from the rule builder and the variables of the rule's source. */
type InRule = (inside: { readonly r: RuleValue; readonly vars: Vars }) => unknown

/**
 * One argument position: outside every rule, where the argument is a value, or inside a rule, where the Live argument
 * is made from the rule builder.
 */
type Position =
	| {
			readonly kind: "outer"
			readonly name: string
			readonly live: unknown
			readonly build: (arg: unknown) => unknown
	  }
	| {
			readonly kind: "inner"
			readonly name: string
			readonly live: InRule
			readonly build: (arg: InRule) => unknown
	  }

/** A valid query whose rule takes one argument at a position. */
const ruled = (body: (r: RuleValue, task: Vars) => unknown) =>
	query(Work).rule((r: RuleValue) => body(r, v(Task, "task")))

const live = () =>
	ruled((r, task) =>
		r
			.match(Task, { id: task["id"], account: task["account"] })
			.find({ id: task["id"], account: task["account"] })
	)

const liveBody = (r: RuleValue) => {
	const { id } = v(Task, "task")
	return r.match(Task, { id }).find({ id })
}

const note = (parent: ParentVars) =>
	query(Work).rule((r: RuleValue) => {
		const { note: n } = v(TaskNote, "taskNote")
		return r.match(TaskNote, { task: parent["id"], note: n }).find({ note: n })
	})

const accounts = () =>
	query(Work).rule((r: RuleValue) => {
		const { id, name } = v(Account, "account")
		return r.match(Account, { id, name }).find({ id, name })
	})

/** The vector example's exact distance per current document revision, through the builder's untyped core. */
const scoredDocuments = () =>
	query(Search).rule((r: RuleValue) => {
		const { document, revision, value } = v(DocumentEmbedding, "documentEmbedding")
		return r
			.match(DocumentEmbedding, { document, revision, value })
			.match(DocumentCurrent, { document, revision })
			.match(Document, { id: document, account: r.param("account", Document.fields.account) })
			.find({
				document,
				revision,
				distance: Compute.cosineDistance(value, r.param("vector", DocumentEmbedding.fields.value))
			})
	})

/**
 * Two bookings of one room, the second's span the first's partner: the rule an Allen operand and a pointIn point sit
 * in, `arg` given the second booking's variables.
 */
const bookings = (predicate: (r: RuleValue, a: Vars, b: Vars) => unknown) =>
	query(Schedule).rule((r: RuleValue) => {
		const a = v(Booking, "first")
		const b = v(Booking, "second")
		return r
			.match(Booking, { room: a["room"], during: a["during"] })
			.match(Booking, { room: a["room"], during: b["during"] })
			.where(predicate(r, a, b))
			.find({ room: a["room"] })
	})

const positions = [
	{
		kind: "outer",
		name: "the schema of query(S)",
		live: Work,
		build: (s) => query(s).rule(liveBody)
	},
	{ kind: "outer", name: "a rule's callback", live: liveBody, build: (cb) => query(Work).rule(cb) },
	{
		kind: "inner",
		name: "a match's source",
		live: () => Task,
		build: (arg) =>
			ruled((r, task) =>
				r.match(arg({ r, vars: task }), { id: task["id"] }).find({ id: task["id"] })
			)
	},
	{
		kind: "inner",
		name: "a scope's name",
		live: () => "other",
		build: (arg) =>
			ruled((r, task) => {
				const other = v(Task, arg({ r, vars: task }))
				return r.match(Task, { id: other["id"] }).find({ id: other["id"] })
			})
	},
	{
		kind: "inner",
		name: "a match's bindings",
		live: ({ vars: task }) => ({ id: task["id"] }),
		build: (arg) =>
			ruled((r, task) => r.match(Task, arg({ r, vars: task })).find({ id: task["id"] }))
	},
	{
		kind: "inner",
		name: "a binding's value",
		live: ({ vars: task }) => task["id"],
		build: (arg) =>
			ruled((r, task) =>
				r
					.match(Task, { id: arg({ r, vars: task }), account: task["account"] })
					.find({ account: task["account"] })
			)
	},
	{
		kind: "inner",
		name: "a filter's predicate",
		live: ({ r, vars: task }) => r.eq(task["account"], r.param("a", uuid)),
		build: (arg) =>
			ruled((r, task) =>
				r
					.match(Task, { id: task["id"], account: task["account"] })
					.where(arg({ r, vars: task }))
					.find({ id: task["id"] })
			)
	},
	{
		kind: "inner",
		name: "a comparison's left side",
		live: ({ vars: task }) => task["account"],
		build: (arg) =>
			ruled((r, task) =>
				r
					.match(Task, { id: task["id"], account: task["account"] })
					.where(r.eq(arg({ r, vars: task }), r.param("a", uuid)))
					.find({ id: task["id"] })
			)
	},
	{
		kind: "inner",
		name: "a comparison's right side",
		live: ({ r }) => r.param("a", uuid),
		build: (arg) =>
			ruled((r, task) =>
				r
					.match(Task, { id: task["id"], account: task["account"] })
					.where(r.eq(task["account"], arg({ r, vars: task })))
					.find({ id: task["id"] })
			)
	},
	{
		kind: "inner",
		name: "a parameter's name",
		live: () => "a",
		build: (arg) =>
			ruled((r, task) =>
				r
					.match(Task, { id: task["id"], account: task["account"] })
					.where(r.eq(task["account"], r.param(arg({ r, vars: task }), uuid)))
					.find({ id: task["id"] })
			)
	},
	{
		kind: "inner",
		name: "a parameter's descriptor",
		live: () => uuid,
		build: (arg) =>
			ruled((r, task) =>
				r
					.match(Task, { id: task["id"], account: task["account"] })
					.where(r.eq(task["account"], r.param("a", arg({ r, vars: task }))))
					.find({ id: task["id"] })
			)
	},
	{
		kind: "inner",
		name: "a negation's source",
		live: () => TaskNote,
		build: (arg) =>
			ruled((r, task) =>
				r
					.match(Task, { id: task["id"] })
					.where(r.not(arg({ r, vars: task }), { task: task["id"] }))
					.find({ id: task["id"] })
			)
	},
	{
		kind: "inner",
		name: "a negation's bindings",
		live: ({ vars: task }) => ({ task: task["id"] }),
		build: (arg) =>
			ruled((r, task) =>
				r
					.match(Task, { id: task["id"] })
					.where(r.not(TaskNote, arg({ r, vars: task })))
					.find({ id: task["id"] })
			)
	},
	{
		kind: "inner",
		name: "the head",
		live: ({ vars: task }) => ({ id: task["id"] }),
		build: (arg) =>
			ruled((r, task) => r.match(Task, { id: task["id"] }).find(arg({ r, vars: task })))
	},
	{
		kind: "inner",
		name: "a head term",
		live: ({ vars: task }) => task["id"],
		build: (arg) =>
			ruled((r, task) => r.match(Task, { id: task["id"] }).find({ out: arg({ r, vars: task }) }))
	},
	{
		kind: "outer",
		name: "an order pair",
		live: ["id", "asc"],
		build: (pair) => live().orderBy(pair).take(1)
	},
	{
		kind: "outer",
		name: "a take bound",
		live: 1,
		build: (k) => live().orderBy(["id", "asc"]).take(k)
	},
	{
		kind: "outer",
		name: "an attachment's name",
		live: "note",
		build: (n) => live().attach(n, note, "array")
	},
	{
		kind: "outer",
		name: "an attachment's child",
		live: note,
		build: (c) => live().attach("note", c, "array")
	},
	{
		kind: "outer",
		name: "an attachment's delivery",
		live: "array",
		build: (d) => live().attach("note", note, d)
	},
	{ kind: "outer", name: "a stage's name", live: "tasks", build: (n) => live().named(n) },
	{
		kind: "outer",
		name: "approximateNearest's by",
		live: "distance",
		build: (by) => scoredDocuments().approximateNearest({ by, take: 20 })
	},
	{
		kind: "outer",
		name: "approximateNearest's take",
		live: 20,
		build: (take) => scoredDocuments().approximateNearest({ by: "distance", take })
	},
	{
		kind: "inner",
		name: "an Allen left operand",
		live: ({ vars: a }) => a["during"],
		build: (arg) =>
			bookings((r, a, b) => r.allen(arg({ r, vars: a }), ALLEN.intersects, b["during"]))
	},
	{
		kind: "inner",
		name: "a pointIn point",
		live: ({ vars: b }) => Compute.lower(b["during"], pg.bigint),
		build: (arg) => bookings((r, a, b) => r.pointIn(arg({ r, vars: b }), a["during"]))
	},
	{
		kind: "outer",
		name: "a vector-valued binding",
		live: Vector.make(Float32Array.of(1, 0, 0, 0), 4),
		build: (value) =>
			query(Search).rule((r: RuleValue) => {
				const { document } = v(DocumentEmbedding, "documentEmbedding")
				return r.match(DocumentEmbedding, { document, value }).find({ document })
			})
	}
] as const satisfies Arr.NonEmptyReadonlyArray<Position>

type PositionEntry = (typeof positions)[number]
type PositionName = PositionEntry["name"]

/**
 * A value a builder callback hands out, held past the callback as a JavaScript caller may hold it. The builder runs
 * its callbacks at once, so the value is there by the time `held` reads it; a callback that ran other than once is a
 * defect of the test, never a stale value.
 */
interface Holder<T> {
	readonly hold: (value: T) => void
	readonly held: () => T
}

const holder = <T>(): Holder<T> => {
	const kept: Array<T> = []
	return {
		hold: (value) => {
			kept.push(value)
		},
		held: () => {
			const [first, ...rest] = kept
			if (first === undefined || rest.length > 0) {
				throw new Error(`a builder callback ran ${kept.length} times where it runs once`)
			}
			return first
		}
	}
}

/**
 * The stale values whose scope ended before the call: each made once here, by a valid query, so a refusal of the
 * call is the stale value's and never the making's.
 */
const strayInterior = holder<Built>()
query(Work).rule((r: RuleValue) => {
	strayInterior.hold(
		r.interior((r2: RuleValue) => {
			const { id } = v(Task, "task")
			return r2.match(Task, { id }).find({ id })
		})
	)
	return liveBody(r)
})

const strayParent = holder<ParentVars>()
query(Work)
	.rule((r: RuleValue) => {
		const { id } = v(Account, "account")
		return r.match(Account, { id }).find({ id })
	})
	.attach(
		"x",
		(a: ParentVars) => {
			strayParent.hold(a)
			return query(Work).rule((r: RuleValue) => {
				const { id } = v(Task, "task")
				return r.match(Task, { id, account: a["id"] }).find({ id })
			})
		},
		"array"
	)

const unresolvedChild = holder<QueryValue>()
query(Work)
	.rule((r: RuleValue) => {
		const { id } = v(Account, "account")
		return r.match(Account, { id }).find({ id })
	})
	.attach(
		"x",
		(a: ParentVars) => {
			const child = query(Work).rule((r: RuleValue) => {
				const { id } = v(Task, "task")
				return r.match(Task, { id, account: a["id"] }).find({ id })
			})
			unresolvedChild.hold(child)
			return child
		},
		"array"
	)

const straySelf = holder<object>()
query(Work).recursive("Reach", {
	row: { task: Task.fields.id },
	base: [
		(r: RuleValue) => {
			const { id } = v(Task, "task")
			return r.match(Task, { id }).find({ task: id })
		}
	],
	rec: [
		(r: RuleValue, s: object) => {
			straySelf.hold(s)
			const { task } = v(s, "s")
			return r.match(s, { task }).match(Task, { id: task }).find({ task })
		}
	]
})

const strayRule = holder<RuleValue>()
query(Work).rule((r: RuleValue) => {
	strayRule.hold(r)
	return liveBody(r)
})

const strayFinished = holder<FinishedValue>()
query(Work).rule((r: RuleValue) => {
	const finished = liveBody(r)
	strayFinished.hold(finished)
	return finished
})

const strayVariable = holder<Vars>()
query(Work).rule((r: RuleValue) => {
	const t = v(Task, "task")
	strayVariable.hold(t)
	return r.match(Task, { id: t["id"] }).find({ id: t["id"] })
})

/**
 * The stale sources: a value that was live in another scope of the builder. Every one is refused with exactly
 * MalformedDescription at build time.
 */
const staleSources = [
	{ from: "v outside every rule", call: () => v(Task, "task") },
	{
		from: "variable of a finished query",
		call: () =>
			query(Work).rule((r: RuleValue) => {
				const t = strayVariable.held()
				return r.match(Task, { id: t["id"] }).find({ id: t["id"] })
			})
	},
	{
		from: "enclosing rule's variable inside an interior stage",
		call: () =>
			query(Work).rule((r: RuleValue) => {
				const { id } = v(Task, "task")
				const notes = r.interior((r2: RuleValue) => {
					const { note: n } = v(TaskNote, "taskNote")
					return r2.match(TaskNote, { task: id, note: n }).find({ note: n })
				})
				return r.match(Task, { id }).match(notes, {}).find({ id })
			})
	},
	{
		from: "enclosing rule's variable inside a nested query",
		call: () =>
			query(Work).rule((r: RuleValue) => {
				const { id, name } = v(Account, "account")
				const inner = query(Work).rule((r2: RuleValue) => {
					const t = v(Task, "task")
					return r2.match(Task, { id: t["id"], account: id }).find({ id: t["id"] })
				})
				return r.match(Account, { id, name }).match(inner, {}).find({ id })
			})
	},
	{
		from: "attachment child's free variable in a rule and its interior stage",
		call: () =>
			query(Work).rule((outer: RuleValue) => {
				const { id: parentId } = v(Task, "task")
				return outer
					.match(Task, { id: parentId })
					.find({ id: parentId })
					.attach(
						"child",
						() => {
							const t = v(Task, "task")
							return query(Work).rule((r: RuleValue) => {
								const i = r.interior((ir: RuleValue) =>
									ir
										.match(Task, { id: t["id"], account: t["account"] })
										.find({ account: t["account"] })
								)
								return r
									.match(Task, { id: t["id"] })
									.match(i, { account: t["account"] })
									.find({ id: t["id"] })
							})
						},
						"array"
					)
			})
	},
	{
		from: "attachment child's free variable in a rule and a nested query",
		call: () =>
			query(Work).rule((outer: RuleValue) => {
				const { id: parentId } = v(Task, "task")
				return outer
					.match(Task, { id: parentId })
					.find({ id: parentId })
					.attach(
						"child",
						() => {
							const t = v(Task, "task")
							return query(Work).rule((r: RuleValue) => {
								const inner = query(Work).rule((r2: RuleValue) =>
									r2
										.match(Task, { id: t["id"], account: t["account"] })
										.find({ account: t["account"] })
								)
								return r
									.match(Task, { id: t["id"], account: t["account"] })
									.match(inner, {})
									.find({ id: t["id"] })
							})
						},
						"array"
					)
			})
	},
	{
		from: "finished interior stage's variable used by the enclosing rule",
		call: () =>
			query(Work).rule((r: RuleValue) => {
				const leaked = holder<Vars>()
				const i = r.interior((ir: RuleValue) => {
					const t = v(Task, "task")
					leaked.hold(t)
					return ir.match(Task, { id: t["id"], account: t["account"] }).find({ id: t["id"] })
				})
				const t = leaked.held()
				return r.match(i, { id: t["id"] }).match(Task, { id: t["id"] }).find({ id: t["id"] })
			})
	},
	{
		from: "parent rule's variable captured by an attachment child",
		call: () =>
			query(Work).rule((r: RuleValue) => {
				const { id, kind } = v(Task, "task")
				return r
					.match(Task, { id, kind })
					.find({ id, kind })
					.attach(
						"note",
						() =>
							query(Work).rule((r2: RuleValue) => {
								const { note: n } = v(TaskNote, "taskNote")
								return r2.match(TaskNote, { task: id, note: n }).find({ note: n })
							}),
						"array"
					)
			})
	},
	{
		from: "interior stage matched outside its rule",
		call: () =>
			query(Work).rule((r: RuleValue) => {
				const stage = strayInterior.held()
				const { id } = v(stage, "stage")
				return r.match(stage, { id }).find({ id })
			})
	},
	{
		from: "enclosing attachment's parent variable in a nested attachment",
		call: () =>
			accounts().attach(
				"tasks",
				(a: ParentVars) =>
					query(Work)
						.rule((r: RuleValue) => {
							const { id } = v(Task, "task")
							return r.match(Task, { id, account: a["id"] }).find({ id })
						})
						.attach(
							"notes",
							(t: ParentVars) =>
								query(Work).rule((r: RuleValue) => {
									const { note: n } = v(TaskNote, "taskNote")
									return r
										.match(TaskNote, { task: t["id"], note: n })
										.where(r.eq(a["id"], t["id"]))
										.find({ note: n })
								}),
							"option"
						),
				"array"
			)
	},
	{
		from: "parent variable inside the child's interior stage",
		call: () =>
			query(Work)
				.rule(liveBody)
				.attach(
					"notes",
					(t: ParentVars) =>
						query(Work).rule((r: RuleValue) => {
							const notes = r.interior((r2: RuleValue) => {
								const { note: n } = v(TaskNote, "taskNote")
								return r2.match(TaskNote, { task: t["id"], note: n }).find({ note: n })
							})
							const { note: n } = v(notes, "notes")
							return r.match(notes, { note: n }).find({ note: n })
						}),
					"array"
				)
	},
	{
		from: "parent variable inside the child's imported query",
		call: () =>
			accounts().attach(
				"tasks",
				(a: ParentVars) => {
					const inner = query(Work).rule((r: RuleValue) => {
						const { id } = v(Task, "task")
						return r.match(Task, { id, account: a["id"] }).find({ id })
					})
					return query(Work).rule((r: RuleValue) => {
						const { id } = v(inner, "inner")
						return r.match(inner, { id }).find({ id })
					})
				},
				"array"
			)
	},
	{
		from: "parent variable after its attachment returned",
		call: () =>
			ruled((r, task) =>
				r
					.match(Task, { id: task["id"], account: strayParent.held()["id"] })
					.find({ id: task["id"] })
			)
	},
	{
		from: "attachment child described before the attachment resolves it",
		call: () => {
			/** Describing the child is the call: the attachment resolved its own copy, never this value. */
			const child = unresolvedChild.held()
			queryValueDesc(child)
			return child
		}
	},
	{
		from: "self outside its recursive arms",
		call: () =>
			query(Work).rule((r: RuleValue) => {
				const self = straySelf.held()
				const { task } = v(self, "self")
				return r.match(self, { task }).find({ task })
			})
	},
	{
		from: "rule builder after its callback returned",
		call: () =>
			query(Work).rule(() => {
				const { id } = v(Task, "task")
				return strayRule.held().match(Task, { id }).find({ id })
			})
	},
	{ from: "Finished of another rule", call: () => query(Work).rule(() => strayFinished.held()) },
	{
		from: "interior stage of another rule",
		call: () =>
			query(Work).rule((r: RuleValue) => {
				const stage = r.interior((r2: RuleValue) => {
					const { id } = v(Task, "task")
					return r2.match(Task, { id }).find({ id })
				})
				/** The stage is the enclosing rule's; the nested interior rule matches it as if it were its own. */
				const nested = r.interior((r2: RuleValue) => {
					const { id } = v(stage, "stage")
					return r2.match(stage, { id }).find({ id })
				})
				const { id } = v(nested, "nested")
				return r.match(nested, { id }).find({ id })
			})
	}
] as const satisfies ReadonlyArray<{ readonly from: string; readonly call: () => unknown }>
type StaleSource = (typeof staleSources)[number]["from"]

/** The call of a stale source, by its name. */
const staleCall = (from: StaleSource): (() => unknown) => {
	for (const source of staleSources) {
		if (source.from === from) {
			return source.call
		}
	}
	throw new Error(`the stale source ${from} is not listed`)
}

/** The values the builder branches on, one call each, at the position each names. */
const nearMisses = [
	{ name: "take bound 0", call: () => live().orderBy(["id", "asc"]).take(0) },
	{ name: "take bound -1", call: () => live().orderBy(["id", "asc"]).take(-1) },
	{ name: "take bound 1.5", call: () => live().orderBy(["id", "asc"]).take(1.5) },
	{ name: "take bound empty text", call: () => live().orderBy(["id", "asc"]).take("") },
	{ name: "take bound 2n", call: () => live().orderBy(["id", "asc"]).take(2n) },
	{ name: "take bound 2147483648", call: () => live().orderBy(["id", "asc"]).take(2147483648) },
	{ name: "order pair unknown column", call: () => live().orderBy(["nope", "asc"]).take(1) },
	{ name: "order pair unknown direction", call: () => live().orderBy(["id", "up"]).take(1) },
	{
		name: "order pair column repeated",
		call: () => live().orderBy(["id", "asc"], ["id", "asc"]).take(1)
	},
	{ name: "order pair bare column", call: () => live().orderBy("id").take(1) },
	{
		name: "attachment name already in the heading",
		call: () => live().attach("id", note, "array")
	},
	{ name: "attachment name empty", call: () => live().attach("", note, "array") },
	{
		name: "binding a JavaScript number to a bigint field",
		call: () =>
			query(Work).rule((r: RuleValue) => {
				const { task } = v(AutomaticTask, "automaticTask")
				return r.match(AutomaticTask, { task, budget: 5 }).find({ task })
			})
	},
	{
		name: "binding 1 to a boolean field",
		call: () =>
			query(Settings).rule((r: RuleValue) => {
				const { account } = v(Preference, "preference")
				return r.match(Preference, { account, enabled: 1 }).find({ account })
			})
	},
	{
		name: "binding an unknown handle",
		call: () =>
			ruled((r, task) =>
				r.match(Task, { id: task["id"], kind: "Neither" }).find({ id: task["id"] })
			)
	},
	{
		name: "binding a malformed uuid",
		call: () =>
			ruled((r, task) =>
				r
					.match(Task, { id: "not-a-uuid", account: task["account"] })
					.find({ account: task["account"] })
			)
	},
	{
		name: "approximateNearest by a column outside the heading",
		call: () => scoredDocuments().approximateNearest({ by: "nope", take: 20 })
	},
	{
		name: "approximateNearest take 0",
		call: () => scoredDocuments().approximateNearest({ by: "distance", take: 0 })
	},
	{
		name: "sum of a boolean",
		call: () =>
			query(Settings).rule((r: RuleValue) => {
				const { account, enabled } = v(Preference, "preference")
				return r.match(Preference, { account, enabled }).find({ account, total: r.sum(enabled) })
			})
	},
	{
		name: "min of a uuid",
		call: () =>
			ruled((r, task) =>
				r
					.match(Task, { id: task["id"], account: task["account"] })
					.find({ account: task["account"], first: r.min(task["id"]) })
			)
	},
	{
		name: "mean of a text",
		call: () =>
			query(Work).rule((r: RuleValue) => {
				const { id, name } = v(Account, "account")
				return r.match(Account, { id, name }).find({ id, average: r.mean(name) })
			})
	}
] as const satisfies ReadonlyArray<{ readonly name: string; readonly call: () => unknown }>
type NearMiss = (typeof nearMisses)[number]["name"]

type MisuseFeature = DrawnFeature<StaleSource> | `position ${PositionName}` | `near ${NearMiss}`

type MisuseCase =
	| {
			readonly kind: "position"
			readonly position: PositionEntry
			readonly argument: Drawn<"live", StaleSource>
	  }
	| { readonly kind: "near"; readonly near: (typeof nearMisses)[number] }

/** What a call did: built a query with a canonical Description, threw a CompileError, or anything else. */
type Outcome =
	| { readonly kind: "built"; readonly query: unknown }
	| { readonly kind: "refused"; readonly reason: CompileReasonTag }
	| { readonly kind: "defect"; readonly what: string }

const thrownText = (caught: unknown): string =>
	Error.isError(caught) ? `${caught.name}: ${caught.message}` : String(caught)

const outcomeOf = (call: () => unknown): Outcome => {
	const called = Result.try(call)
	if (Result.isFailure(called)) {
		const caught = called.failure
		return isCompileError(caught)
			? { kind: "refused", reason: caught.reason._tag }
			: { kind: "defect", what: thrownText(caught) }
	}
	const built = called.success
	const desc = queryValueDesc(built)
	if (desc === undefined) {
		return { kind: "defect", what: "a value that records no Description" }
	}
	const text = descText(desc)
	return text.ok
		? { kind: "built", query: built }
		: {
				kind: "defect",
				what: `a Description with no canonical text: ${text.error.message}`
			}
}

/** An outcome in a failure message: what the call did, never the value it was handed. */
const shown = (outcome: Outcome): string => {
	switch (outcome.kind) {
		case "built":
			return "built a query"
		case "refused":
			return `refused as ${outcome.reason}`
		case "defect":
			return `a defect: ${outcome.what}`
	}
}

/** What compiling a built query did: it returned a template or a CompileError, or it threw. */
type Compiled = { readonly kind: "returned" } | { readonly kind: "threw"; readonly what: string }

const compiledOf = (built: unknown): Compiled => {
	const compiled = Result.try(() => compileTemplate(built, undefined, testCompile))
	return Result.isFailure(compiled)
		? { kind: "threw", what: thrownText(compiled.failure) }
		: { kind: "returned" }
}

/** The argument a position case draws: its position's Live argument first, then a stale source, then a wild value. */
const argumentGen = lsw<"live", StaleSource>({
	live: constant<"live">("live"),
	stale: Option.some(
		map(element<(typeof staleSources)[number]>(staleSources), (s): Stale<"live", StaleSource> => ({
			value: "live",
			from: s.from
		}))
	),
	wild: WILD_KINDS
})

const positionCase: Gen<MisuseCase> = (source) => ({
	kind: "position",
	position: source.draw(element<PositionEntry>(positions)),
	argument: source.draw(argumentGen)
})

const nearCase: Gen<MisuseCase> = map(
	element<(typeof nearMisses)[number]>(nearMisses),
	(near): MisuseCase => ({ kind: "near", near })
)

/** A position case first, so a failure shrinks toward a Live argument. */
const caseGen: Gen<MisuseCase> = oneOf([positionCase, nearCase])

/**
 * The call a position case makes: the position's Live argument, the stale source's own call whatever the position, or
 * the wild value at its position, read from the drawn value only here, at the boundary call.
 */
const callOf = (position: PositionEntry, argument: Drawn<"live", StaleSource>): (() => unknown) => {
	switch (argument.kind) {
		case "live":
			return position.kind === "outer"
				? () => position.build(position.live)
				: () => position.build(position.live)
		case "stale":
			return staleCall(argument.from)
		case "wild": {
			const wild = passed(argument)
			return position.kind === "outer"
				? () => position.build(wild)
				: () => position.build(() => wild)
		}
	}
}

const admitted: ReadonlySet<CompileReasonTag> = new Set([
	"MalformedDescription",
	"UnsupportedOperation"
])

const situations: Arr.NonEmptyReadonlyArray<MisuseFeature> = [
	"live",
	...Arr.map(staleSources, (s): MisuseFeature => `stale ${s.from}`),
	...Arr.map(WILD_KINDS, (k): MisuseFeature => `wild ${k}`),
	...Arr.map(positions, (p): MisuseFeature => `position ${p.name}`),
	...Arr.map(nearMisses, (n): MisuseFeature => `near ${n.name}`)
]

describe("the query builder's untyped core", () => {
	it.effect(
		"builds a canonical Description from a Live argument, refuses a Stale one, and from any other refuses with a typed error or builds one",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/query/misuse",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<MisuseFeature>(situations, { cases: 1500, sense: notesOnly }),
						kept: [],
						runs: 1500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(misuse, c) =>
						Effect.sync(() => {
							switch (misuse.kind) {
								case "position": {
									const { position, argument } = misuse
									c.note(drawnFeature(argument))
									const outcome = outcomeOf(callOf(position, argument))
									switch (argument.kind) {
										case "live":
											c.note(`position ${position.name}`)
											if (outcome.kind !== "built") {
												assert.fail(`the Live argument at ${position.name}: ${shown(outcome)}`)
											}
											break
										case "stale":
											if (outcome.kind !== "refused" || outcome.reason !== "MalformedDescription") {
												assert.fail(
													`stale ${argument.from}: expected a MalformedDescription refusal, ${shown(outcome)}`
												)
											}
											break
										case "wild": {
											c.note(`position ${position.name}`)
											const at = `${position.name}, ${drawnFeature(argument)}`
											if (outcome.kind === "defect") {
												assert.fail(`${at}: ${shown(outcome)}`)
											}
											if (outcome.kind === "refused") {
												assert.ok(admitted.has(outcome.reason), `${at} is ${shown(outcome)}`)
											}
											break
										}
									}
									return
								}
								case "near": {
									const { name, call } = misuse.near
									c.note(`near ${name}`)
									const outcome = outcomeOf(call)
									switch (outcome.kind) {
										case "defect":
											return assert.fail(`near ${name}: ${shown(outcome)}`)
										case "refused":
											assert.ok(admitted.has(outcome.reason), `near ${name} is ${shown(outcome)}`)
											return
										case "built": {
											/**
											 * A built near miss compiles to a template or to a CompileError; compiling it never throws.
											 */
											const compiled = compiledOf(outcome.query)
											if (compiled.kind === "threw") {
												assert.fail(
													`near ${name} built a query, and compiling it threw ${compiled.what}`
												)
											}
											return
										}
									}
								}
							}
						})
				)
			)
	)
})

/**
 * Where a scope's variable is bound: Task's id at Task, Task's id at AutomaticTask's task, a field of another relation,
 * or AutomaticTask's task at AutomaticTask.
 */
const scopeShapes = [
	{ source: Task, label: "Task", at: Task, field: "id", column: "id" },
	{ source: Task, label: "Task", at: AutomaticTask, field: "id", column: "task" },
	{
		source: AutomaticTask,
		label: "AutomaticTask",
		at: AutomaticTask,
		field: "task",
		column: "task"
	}
] as const

/** Two scopes of one rule, each of a shape, and their names: two names, or one name given twice. */
interface TwoScopes {
	readonly first: (typeof scopeShapes)[number]
	readonly second: (typeof scopeShapes)[number]
	readonly names: readonly [string, string]
}

const twoScopes: Gen<TwoScopes> = (source) => ({
	first: source.draw(element(scopeShapes)),
	second: source.draw(element(scopeShapes)),
	names: source.draw(
		element([
			["task", "other"],
			["task", "task"]
		] as const)
	)
})

/** The rule of two scopes, each bound by its own match, built through the builder's untyped core. */
const twoScoped = ({ first, second, names }: TwoScopes) =>
	catchCompileError(() =>
		query(Work).rule((r: RuleValue) => {
			const a = v(first.source, names[0])
			const b = v(second.source, names[1])
			return r
				.match(first.at, { [first.column]: a[first.field] })
				.match(second.at, { [second.column]: b[second.field] })
				.find({ first: a[first.field], second: b[second.field] })
		})
	)

describe("named scopes", () => {
	it.effect(
		"a rule's two scopes of two names compile, one relation's and a field of another's included, its Description spelling each variable by its scope; one name given twice is DuplicateIdentity naming both calls",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/query/named-scopes",
						generator: twoScopes,
						literal: (c) =>
							`${c.first.label}@${c.first.column} ${c.second.label}@${c.second.column} ${Arr.join(c.names, "/")}`,
						limit: 18,
						coverage: noCoverage,
						caseHang
					},
					(c) =>
						Effect.sync(() => {
							const built = twoScoped(c)
							const [name, again] = c.names
							if (name !== again) {
								assert.ok(
									built.ok && compileTemplate(built.value, undefined, testCompile).ok,
									"two scopes of two names compile"
								)
								const stage = queryValueDesc(built.value)?.stage
								const spelled: ReadonlyArray<string> =
									stage?.kind === "rules" ? Arr.map(stage.arms[0].vars, (d) => d.id) : []
								assert.deepEqual(
									spelled,
									[`${name}.${c.first.field}`, `${again}.${c.second.field}`],
									"the Description names each variable by its scope and field"
								)
								return
							}
							const reason = built.ok ? undefined : built.error.reason
							assert.deepEqual(
								reason?._tag === "DuplicateIdentity" && reason.duplicate.kind === "scope"
									? {
											name: reason.duplicate.name,
											at: reason.at.label,
											earlier: reason.duplicate.earlier.label
										}
									: reason?._tag,
								{
									name,
									at: `v(${c.second.label}, "${name}")`,
									earlier: `v(${c.first.label}, "${name}")`
								},
								"one name given twice is DuplicateIdentity of the scope at the second call, the first its earlier"
							)
						})
				)
			)
	)
})
