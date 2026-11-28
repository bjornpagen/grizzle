/** What the properties of misuse.test.ts read: its spaces, models and helpers. */

import { constant, element, type Gen, map, weighted } from "@bjornpagen/testing/gen"
import {
	type Drawn,
	type DrawnFeature,
	lsw,
	passed,
	type Stale,
	WILD_KINDS,
	wild
} from "@bjornpagen/testing/lsw"
import { Array as Arr, Option, Result } from "effect"
import { ALLEN } from "#compiler/allen/mask.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { type CompileReasonTag, isCompileError } from "#compiler/core/errors.ts"
import type { Built } from "#compiler/core/phantom.ts"
import { descText } from "#compiler/ir/desc.ts"
import { pg } from "#compiler/public/fields.ts"
import {
	queryOver as query,
	type QueryValue,
	queryValueDesc,
	varsOver as v
} from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { Account, AutomaticTask, Task, TaskNote, Work } from "#test/support/fixtures/api/work.ts"
import { Id } from "#test/support/ids.ts"
import {
	Booking,
	Document,
	DocumentCurrent,
	DocumentEmbedding,
	Preference,
	Schedule,
	Search,
	Settings
} from "#test/support/unit/query/fixtures.ts"

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
				distance: computeCore.cosineDistance(
					value,
					r.param("vector", DocumentEmbedding.fields.value)
				)
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
		live: ({ r, vars: task }) => r.eq(task["account"], r.param("a", Id)),
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
					.where(r.eq(arg({ r, vars: task }), r.param("a", Id)))
					.find({ id: task["id"] })
			)
	},
	{
		kind: "inner",
		name: "a comparison's right side",
		live: ({ r }) => r.param("a", Id),
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
					.where(r.eq(task["account"], r.param(arg({ r, vars: task }), Id)))
					.find({ id: task["id"] })
			)
	},
	{
		kind: "inner",
		name: "a parameter's descriptor",
		live: () => Id,
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
		live: ({ vars: b }) => computeCore.lower(b["during"], pg.bigint),
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
 * The value `make` hands its hold while it builds a valid query, held past the builder's callback as a JavaScript
 * caller may hold it: each stale value is made once, here, by a valid query, so a refusal of the call that reads it is
 * the stale value's and never the making's.
 */
const heldPast = <T>(make: (hold: (value: T) => void) => unknown): T => {
	const kept = holder<T>()
	make(kept.hold)
	return kept.held()
}

/** An interior stage of a finished rule, which "interior stage matched outside its rule" matches in another rule. */
const strayInterior = heldPast<Built>((hold) =>
	query(Work).rule((r: RuleValue) => {
		hold(
			r.interior((r2: RuleValue) => {
				const { id } = v(Task, "task")
				return r2.match(Task, { id }).find({ id })
			})
		)
		return liveBody(r)
	})
)

/** The parent variables of a resolved attachment, which "parent variable after its attachment returned" binds. */
const strayParent = heldPast<ParentVars>((hold) =>
	query(Work)
		.rule((r: RuleValue) => {
			const { id } = v(Account, "account")
			return r.match(Account, { id }).find({ id })
		})
		.attach(
			"x",
			(a: ParentVars) => {
				hold(a)
				return query(Work).rule((r: RuleValue) => {
					const { id } = v(Task, "task")
					return r.match(Task, { id, account: a["id"] }).find({ id })
				})
			},
			"array"
		)
)

/**
 * An attachment's child as its callback returned it, which the attachment resolved its own copy of: "attachment child
 * described before the attachment resolves it" describes it.
 */
const unresolvedChild = heldPast<QueryValue>((hold) =>
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
				hold(child)
				return child
			},
			"array"
		)
)

/** The self of a finished recursive definition, which "self outside its recursive arms" matches in a rule. */
const straySelf = heldPast<object>((hold) =>
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
				hold(s)
				const { task } = v(s, "s")
				return r.match(s, { task }).match(Task, { id: task }).find({ task })
			}
		]
	})
)

/** The rule builder of a finished rule, which "rule builder after its callback returned" matches with. */
const strayRule = heldPast<RuleValue>((hold) =>
	query(Work).rule((r: RuleValue) => {
		hold(r)
		return liveBody(r)
	})
)

/** The Finished of another rule, which "Finished of another rule" returns from its own. */
const strayFinished = heldPast<FinishedValue>((hold) =>
	query(Work).rule((r: RuleValue) => {
		const finished = liveBody(r)
		hold(finished)
		return finished
	})
)

/** The variables of a finished query, which "variable of a finished query" binds in another. */
const strayVariable = heldPast<Vars>((hold) =>
	query(Work).rule((r: RuleValue) => {
		const t = v(Task, "task")
		hold(t)
		return r.match(Task, { id: t["id"] }).find({ id: t["id"] })
	})
)

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
				const t = strayVariable
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
				const stage = strayInterior
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
				r.match(Task, { id: task["id"], account: strayParent["id"] }).find({ id: task["id"] })
			)
	},
	{
		from: "attachment child described before the attachment resolves it",
		call: () => {
			/** Describing the child is the call: the attachment resolved its own copy, never this value. */
			const child = unresolvedChild
			queryValueDesc(child)
			return child
		}
	},
	{
		from: "self outside its recursive arms",
		call: () =>
			query(Work).rule((r: RuleValue) => {
				const self = straySelf
				const { task } = v(self, "self")
				return r.match(self, { task }).find({ task })
			})
	},
	{
		from: "rule builder after its callback returned",
		call: () =>
			query(Work).rule(() => {
				const { id } = v(Task, "task")
				return strayRule.match(Task, { id }).find({ id })
			})
	},
	{ from: "Finished of another rule", call: () => query(Work).rule(() => strayFinished) },
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
		name: "a match's binding naming no field",
		call: () =>
			ruled((r, task) =>
				r.match(Task, { id: task["id"], nope: task["id"] }).find({ id: task["id"] })
			)
	},
	{
		name: "a negation's binding naming no field",
		call: () =>
			ruled((r, task) =>
				r
					.match(Task, { id: task["id"] })
					.where(r.not(TaskNote, { task: task["id"], nope: task["id"] }))
					.find({ id: task["id"] })
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

export type MisuseFeature =
	| DrawnFeature<StaleSource>
	| `position ${PositionName}`
	| `near ${NearMiss}`

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

export const outcomeOf = (call: () => unknown): Outcome => {
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
export const shown = (outcome: Outcome): string => {
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

export const compiledOf = (built: unknown): Compiled => {
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

/** A position case at a drawn position, handed the argument `argument` draws. */
const positionWith =
	(argument: Gen<Drawn<"live", StaleSource>>): Gen<MisuseCase> =>
	(source) => ({
		kind: "position",
		position: source.draw(element<PositionEntry>(positions)),
		argument: source.draw(argument)
	})

/** A position case: a drawn position, handed a Live, Stale or Wild argument. */
const positionCase: Gen<MisuseCase> = positionWith(argumentGen)

/** A Live or a Wild argument: the arguments a position case notes its position for. */
const liveOrWild = lsw<"live", StaleSource>({
	live: constant<"live">("live"),
	stale: Option.none(),
	wild: WILD_KINDS
})

/**
 * The case each situation but live is aimed at while it is pending, constructed to reach it: a position case handed
 * the stale source or the wild kind it names, a case at the position it names handed a Live or a Wild argument (the
 * arguments a position is noted for), and the near miss it names.
 */
export const aims: ReadonlyArray<readonly [MisuseFeature, Gen<MisuseCase>]> = [
	...Arr.map(staleSources, (s): readonly [MisuseFeature, Gen<MisuseCase>] => [
		`stale ${s.from}`,
		positionWith(
			constant<Drawn<"live", StaleSource>>({ kind: "stale", value: "live", from: s.from })
		)
	]),
	...Arr.map(WILD_KINDS, (kind): readonly [MisuseFeature, Gen<MisuseCase>] => [
		`wild ${kind}`,
		positionWith(
			map(wild([kind]), (drawn): Drawn<"live", StaleSource> => ({ kind: "wild", wild: drawn }))
		)
	]),
	...Arr.map(positions, (position): readonly [MisuseFeature, Gen<MisuseCase>] => [
		`position ${position.name}`,
		(source) => ({ kind: "position", position, argument: source.draw(liveOrWild) })
	]),
	...Arr.map(nearMisses, (near): readonly [MisuseFeature, Gen<MisuseCase>] => [
		`near ${near.name}`,
		constant<MisuseCase>({ kind: "near", near })
	])
]

const nearCase: Gen<MisuseCase> = map(
	element<(typeof nearMisses)[number]>(nearMisses),
	(near): MisuseCase => ({ kind: "near", near })
)

/** A position case first, so a failure shrinks toward a Live argument. */
export const caseGen: Gen<MisuseCase> = weighted([
	[1, positionCase],
	[1, nearCase]
])

/**
 * The call a position case makes: the position's Live argument, the stale source's own call whatever the position, or
 * the wild value at its position, read from the drawn value only here, at the boundary call.
 */
export const callOf = (
	position: PositionEntry,
	argument: Drawn<"live", StaleSource>
): (() => unknown) => {
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

/**
 * The builder's own refusals, one per door: malformed's MalformedDescription, builderRefusal's Refused (a rule the
 * types name too) and unsupported's UnsupportedOperation.
 */
export const admitted: ReadonlySet<CompileReasonTag> = new Set([
	"MalformedDescription",
	"Refused",
	"UnsupportedOperation"
])

export const situations: Arr.NonEmptyReadonlyArray<MisuseFeature> = [
	"live",
	...Arr.map(staleSources, (s): MisuseFeature => `stale ${s.from}`),
	...Arr.map(WILD_KINDS, (k): MisuseFeature => `wild ${k}`),
	...Arr.map(positions, (p): MisuseFeature => `position ${p.name}`),
	...Arr.map(nearMisses, (n): MisuseFeature => `near ${n.name}`)
]

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

export const twoScopes: Gen<TwoScopes> = (source) => ({
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
export const twoScoped = ({ first, second, names }: TwoScopes) =>
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
