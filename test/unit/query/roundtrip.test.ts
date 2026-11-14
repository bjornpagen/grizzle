/**
 * A Description rebuilds the same query: a query value rebuilt from its QueryDesc records the same Description,
 * carries the same heading and supports the same combinators; and the builder's output is deterministic, valid,
 * canonical and stable over generated queries.
 *
 * - Generated chains (arms over the worked example's schema and over the span example's, then a chain of rules, named
 *   stages, attachments, takes and imports, then a set or ordered ending): the Description decodes, is canonical, is
 *   built alike twice, rebuilds to the same text through the Description and through a QueryDescription carried as
 *   JSON, keeps its heading's names, and a prefix rebuilt and resumed is the whole chain. Oracle: the round trip, a
 *   universal law, and the builder run twice.
 * - Attachments: a rebuilt query keeps its attachment names, refusing what the original refuses. Oracle: the original,
 *   a differential.
 * - A rebuilt recursive row is typed under the schema's rosters as the original was: a literal against its handle is
 *   checked against the roster. Oracle: the original, and the roster's own handles.
 *
 * Features: each op of a chain and each ending, a chain cut inside; a roster handle and a text that is none.
 *
 * Plants (~/.cache/grizzle-release/BR06/plants): roundtrip-rebuilt-attachment-lost (a rebuilt attach stage without its
 * attachment's name) and roundtrip-rebuilt-row-untyped (a rebuilt field typed by its Description untyped).
 */
import { describe, it } from "@effect/vitest"
import { type Case, drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	string,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { ALLEN } from "#compiler/allen/mask.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { CompileReasonTag } from "#compiler/core/errors.ts"
import { type Direction, directions } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { decodeDesc, descText, type QueryDesc } from "#compiler/ir/desc.ts"
import { toQueryDescription } from "#compiler/ir/describe.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import {
	isOrderedValue,
	isQueryValue,
	type OrderedValue,
	type QueryValue,
	queryOver as query,
	varsOver as v
} from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { queryState } from "#compiler/query/build/state.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { fromQueryDescription, queryFromDesc } from "#test/support/describe.ts"
import { AutomaticTask, Kind, Task, TaskNote, Work } from "#test/support/fixtures/api/work.ts"
import { caseHang } from "#test/support/limits.ts"
import { at, Booking, descOf, Schedule } from "#test/unit/query/fixtures.ts"

const text = (q: unknown): string => {
	const t = descText(descOf(q))
	if (!t.ok) {
		throw t.error
	}
	return t.value
}

const rebuilt = (desc: QueryDesc, schema: unknown): QueryValue | OrderedValue => {
	const value = queryFromDesc(desc, schema)
	if (!value.ok) {
		throw value.error
	}
	return value.value
}

/** A rebuilt Query, checked to be one. */
const rebuiltQuery = (desc: QueryDesc, schema: unknown): QueryValue => {
	const value = rebuilt(desc, schema)
	if (!isQueryValue(value)) {
		throw new Error("not a Query")
	}
	return value
}

/** The parent variables an attachment passes its child, as the builder's untyped core reads them. */
type ParentVars = Readonly<Record<string, unknown>>

const viaDescription = (desc: QueryDesc): QueryDesc => {
	const description = toQueryDescription(desc)
	if (!description.ok) {
		throw description.error
	}
	/** Transported as JSON text, as a caller stores and sends it. */
	const parsed = fromQueryDescription(trustedJson<unknown>(jsonText(description.value)))
	if (!parsed.ok) {
		throw parsed.error
	}
	const decoded = fromQueryDescription(description.value)
	if (!decoded.ok) {
		throw decoded.error
	}
	assert.deepEqual(descText(parsed.value), descText(decoded.value))
	return parsed.value
}

/** The names a heading carries: its fields in heading order, and its attachments. */
const names = (q: unknown) => {
	const h = queryState(q)?.heading
	if (h === undefined) {
		throw new Error("not a query value")
	}
	return { fields: [...h.fields.keys()], attached: Arr.sort([...h.attached], Order.String) }
}

/** Generated queries: arms over a schema, then a chain of combinators, then an ending. */
type Op =
	| { readonly op: "rule"; readonly arm: number }
	| { readonly op: "named" }
	| { readonly op: "attach" }
	| {
			readonly op: "take"
			readonly k: number
			readonly dir: Direction
			readonly param: boolean
	  }
	| { readonly op: "import" }

/** The chain may end ordered: an Ordered is no Query, so the ending is drawn apart from the ops and applied last. */
type Ending = { readonly kind: "set" } | { readonly kind: "ordered"; readonly dir: Direction }

/** A schema's generated queries: the arms drawn over it, how each builds a rule, a key to order by, and a child. */
interface Grammar<A> {
	readonly schema: unknown
	readonly arms: Gen<A>
	readonly rule: (arm: A) => (r: RuleValue) => FinishedValue
	/** A field every arm's head has, to order by. */
	readonly key: string
	readonly child: (p: ParentVars) => QueryValue
}

const opGen = (armCount: number): Gen<Op> =>
	weighted<Op>([
		[1, map(int(0, armCount - 1), (arm): Op => ({ op: "rule", arm }))],
		[1, constant({ op: "named" })],
		[1, constant({ op: "attach" })],
		[
			1,
			(source) => ({
				op: "take",
				k: source.draw(int(1, 5)),
				dir: source.draw(element(directions)),
				param: source.draw(boolean)
			})
		],
		[1, constant({ op: "import" })]
	])

const endingGen: Gen<Ending> = element<Ending>([
	{ kind: "set" },
	{ kind: "ordered", dir: "asc" },
	{ kind: "ordered", dir: "desc" }
])

/** One op applied to the chain so far; `i` numbers its names. */
const applyOp = <A>(
	gen: Grammar<A>,
	out: QueryValue,
	arms: ReadonlyArray<A>,
	op: Op,
	i: number
): QueryValue => {
	switch (op.op) {
		case "rule":
			return out.rule(gen.rule(at(arms, op.arm)))
		case "named":
			return out.named(`stage${i}`)
		case "attach":
			return out.attach(`a${i}`, gen.child, "array")
		case "take":
			return out.orderBy([gen.key, op.dir]).take(op.param ? "batch" : op.k)
		case "import":
			return query(gen.schema).rule((r: RuleValue) => {
				const vars = v(out, "out")
				return r.match(out, vars).find(vars)
			})
	}
}

/** Applies `ops` to `q`, numbering names from `offset` so a split chain names its stages as the whole chain does. */
const applyOps = <A>(
	gen: Grammar<A>,
	q: QueryValue,
	arms: ReadonlyArray<A>,
	ops: ReadonlyArray<Op>,
	offset: number
): QueryValue => Arr.reduce(ops, q, (out, op, j) => applyOp(gen, out, arms, op, offset + j))

/** The chain's ending, applied after every op. */
const ended = <A>(gen: Grammar<A>, q: QueryValue, ending: Ending): QueryValue | OrderedValue =>
	ending.kind === "set" ? q : q.orderBy([gen.key, ending.dir])

const generated =
	<A>(gen: Grammar<A>): Gen<readonly [ReadonlyArray<A>, ReadonlyArray<Op>, Ending, number]> =>
	(source) =>
		[
			source.draw(array(gen.arms, { min: 1, max: 3 })),
			source.draw(array(opGen(3), { min: 0, max: 4 })),
			source.draw(endingGen),
			source.draw(int(0, 2 ** 31 - 1))
		] as const

/** What a generated chain reaches: each op, each ending, and a cut inside the chain. */
type ChainFeature = `op ${Op["op"]}` | `ending ${Ending["kind"]}` | "a cut inside the chain"

const chainFeatures: Arr.NonEmptyReadonlyArray<ChainFeature> = [
	"op rule",
	"op named",
	"op attach",
	"op take",
	"op import",
	"ending set",
	"ending ordered",
	"a cut inside the chain"
]

const property =
	<A>(gen: Grammar<A>) =>
	(
		[armsIn, ops, ending, cut]: readonly [ReadonlyArray<A>, ReadonlyArray<Op>, Ending, number],
		c: Case<ChainFeature>
	): Effect.Effect<void> =>
		Effect.sync(() => {
			c.noteAll(Arr.map(ops, (op): ChainFeature => `op ${op.op}`))
			c.note(`ending ${ending.kind}`)
			const arms = [...armsIn, ...armsIn, ...armsIn]
			const chain = (part: ReadonlyArray<Op>, offset: number): QueryValue =>
				applyOps(gen, query(gen.schema).rule(gen.rule(at(arms, 0))), arms, part, offset)
			const q = ended(gen, chain(ops, 0), ending)
			/** descOf asserts the Description canonical: no provisional spelling, every clause variable listed. */
			const desc = descOf(q)
			assert.equal(decodeDesc("query", desc).ok, true)
			assert.equal(text(ended(gen, chain(ops, 0), ending)), text(q))
			const back = rebuilt(desc, gen.schema)
			assert.equal(text(back), text(q))
			assert.equal(text(rebuilt(viaDescription(desc), gen.schema)), text(q))
			assert.equal(isOrderedValue(back), ending.kind === "ordered")
			assert.deepEqual(names(back), names(q))
			/**
			 * Rebuilding a prefix of the chain and applying the rest, then the ending, gives the whole chain's Description.
			 */
			const k = cut % (ops.length + 1)
			if (k > 0 && k < ops.length) {
				c.note("a cut inside the chain")
			}
			const prefix = rebuiltQuery(descOf(chain(ops.slice(0, k), 0)), gen.schema)
			const resumed = ended(gen, applyOps(gen, prefix, arms, ops.slice(k), k), ending)
			assert.equal(text(resumed), text(q))
			assert.deepEqual(names(resumed), names(q))
		})

/**
 * Over the worked example's schema: matches, negations, parameter filters, between with variable bounds, Compute cast, cond and
 * base, inSet, an interior stage, a bound import, and aggregate heads. A cond's first branch is a term, never a literal
 * or a parameter, since it types the conditional (scalar/compute/builders.ts cond): condLiteral states its literal
 * second.
 */
interface WorkArm {
	/** The task's kind bound to a literal, or left free. */
	readonly kind: "Automatic" | "Manual" | "free"
	readonly budget: boolean
	readonly note: boolean
	readonly noNote: boolean
	readonly byAccount: boolean
	readonly between: boolean
	readonly compute: "none" | "cast" | "numeric" | "cond" | "condLiteral" | "base"
	readonly inSet: boolean
	readonly interior: boolean
	readonly bind: boolean
	readonly head: "plain" | "count" | "sum"
}

const notesOf = query(Work).rule((r: RuleValue) => {
	const { note } = v(TaskNote, "taskNote")
	return r.match(TaskNote, { task: r.param("task", TaskNote.fields.task), note }).find({ note })
})

const work: Grammar<WorkArm> = {
	schema: Work,
	arms: (source) => ({
		kind: source.draw(element(["Automatic", "Manual", "free"] as const)),
		budget: source.draw(boolean),
		note: source.draw(boolean),
		noNote: source.draw(boolean),
		byAccount: source.draw(boolean),
		between: source.draw(boolean),
		compute: source.draw(
			element(["none", "cast", "numeric", "cond", "condLiteral", "base"] as const)
		),
		inSet: source.draw(boolean),
		interior: source.draw(boolean),
		bind: source.draw(boolean),
		head: source.draw(element(["plain", "count", "sum"] as const))
	}),
	rule: (arm) => (r: RuleValue) => {
		const { id, account } = v(Task, "task")
		const { budget } = v(AutomaticTask, "automaticTask")
		const { note } = v(TaskNote, "taskNote")
		let rule = r.match(
			Task,
			arm.kind === "free" ? { id, account } : { id, account, kind: arm.kind }
		)
		const needsBudget = arm.budget || arm.head === "sum" || arm.between || arm.compute !== "none"
		if (needsBudget) {
			rule = rule.match(AutomaticTask, { task: id, budget })
		}
		if (arm.note) {
			rule = rule.match(TaskNote, { task: id, note })
		}
		if (arm.interior) {
			const automatic = r.interior((r2: RuleValue) => {
				const { task, budget: b } = v(AutomaticTask, "automaticTask")
				return r2.match(AutomaticTask, { task, budget: b }).find({ task, budget: b })
			})
			const { budget: staged } = v(automatic, "automatic")
			rule = rule.match(automatic, { task: id, budget: staged })
		}
		if (arm.bind) {
			const bound = notesOf.bind({ task: id })
			const { note: imported } = v(bound, "bound")
			rule = rule.match(bound, { note: imported })
		}
		if (arm.noNote) {
			rule = rule.where(r.not(TaskNote, { task: id }))
		}
		if (arm.byAccount) {
			rule = rule.where(r.eq(account, r.param("account", Task.fields.account)))
		}
		if (arm.between) {
			rule = rule.where(r.between(budget, budget, budget))
		}
		if (arm.inSet) {
			rule = rule.where(r.inSet(id, ["a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"]))
		}
		const extra =
			arm.compute === "cast"
				? { x: Compute.cast(Compute.base(budget), pg.numeric(19, 0)) }
				: arm.compute === "numeric"
					? { x: Compute.numeric(Compute.base(budget)) }
					: arm.compute === "cond"
						? {
								x: Compute.cond(
									r.eq(account, r.param("account", Task.fields.account)),
									Compute.base(budget),
									0n
								)
							}
						: arm.compute === "condLiteral"
							? { x: Compute.cond(r.le(budget, 1n), Compute.base(budget), 0n) }
							: arm.compute === "base"
								? { x: Compute.base(budget) }
								: {}
		switch (arm.head) {
			case "plain":
				return rule.find({ id, account, ...extra })
			case "count":
				return rule.find({ account, n: r.count(), ...extra })
			case "sum":
				return rule.find({ account, total: r.sum(budget), ...extra })
		}
	},
	key: "account",
	child: (p: ParentVars) =>
		query(Work).rule((r: RuleValue) => {
			const { id } = v(Task, "task")
			return r.match(Task, { id, account: p["account"] }).find({ id })
		})
}

/** Over the span example's schedule: Allen masks and point membership between two span variables, and the producers. */
interface SpanArm {
	readonly allen: boolean
	readonly pointIn: boolean
	readonly producer: "none" | "intersection" | "difference" | "pack"
}

const spans: Grammar<SpanArm> = {
	schema: Schedule,
	arms: (source) => ({
		allen: source.draw(boolean),
		pointIn: source.draw(boolean),
		producer: source.draw(element(["none", "intersection", "difference", "pack"] as const))
	}),
	rule: (arm) => (r: RuleValue) => {
		const a = v(Booking, "first")
		const b = v(Booking, "second")
		let rule = r.match(Booking, { room: a["room"], during: a["during"] })
		const pair =
			arm.allen || arm.pointIn || arm.producer === "intersection" || arm.producer === "difference"
		if (pair) {
			rule = rule.match(Booking, { room: a["room"], during: b["during"] })
		}
		if (arm.allen) {
			rule = rule.where(r.allen(a["during"], ALLEN.intersects, b["during"]))
		}
		if (arm.pointIn) {
			rule = rule.where(r.pointIn(Compute.lower(b["during"], pg.bigint), a["during"]))
		}
		switch (arm.producer) {
			case "none":
				return rule.find({ room: a["room"], during: a["during"] })
			case "intersection":
				return rule.find({ room: a["room"], overlap: r.intersection(a["during"], b["during"]) })
			case "difference":
				return rule.find({ room: a["room"], rest: r.difference(a["during"], b["during"]) })
			case "pack":
				return rule.find({ room: a["room"], covered: r.pack(a["during"]) })
		}
	},
	key: "room",
	child: (p: ParentVars) =>
		query(Schedule).rule((r: RuleValue) => {
			const { during, guest } = v(Booking, "booking")
			return r.match(Booking, { room: p["room"], during, guest }).find({ guest })
		})
}

describe("rebuilding from a Description", () => {
	const automatic = () =>
		query(Work).rule((r: RuleValue) => {
			const { id, account } = v(Task, "task")
			const { budget } = v(AutomaticTask, "automaticTask")
			return r
				.match(Task, { id, account, kind: "Automatic" })
				.match(AutomaticTask, { task: id, budget })
				.find({ id, account, budget })
		})

	const noteChild = (t: ParentVars) =>
		query(Work).rule((r: RuleValue) => {
			const { note } = v(TaskNote, "taskNote")
			return r.match(TaskNote, { task: t["id"], note }).find({ note })
		})

	/**
	 * A query with the note attachment, from an attach stage or from an arm's attach, and an operation on it once
	 * rebuilt: the rebuilt query knows its attachment's name as the original did.
	 */
	type Attached = "an attach stage" | "an arm's attach"
	type Operation = "attach the name again" | "attach another name" | "order by the attachment"
	const attachedQuery = (from: Attached): QueryValue =>
		from === "an attach stage"
			? automatic().attach("note", noteChild, "array")
			: query(Work).rule((r: RuleValue) => {
					const { id } = v(Task, "task")
					return r.match(Task, { id }).find({ id }).attach("note", noteChild, "array")
				})
	const operate = (q: QueryValue, operation: Operation) => () => {
		switch (operation) {
			case "attach the name again":
				return q.attach("note", noteChild, "array")
			case "attach another name":
				return q.attach("other", noteChild, "array")
			case "order by the attachment":
				return q.orderBy(["note", "asc"])
		}
	}

	it.effect(
		"keeps the attachment names of a rebuilt query, refusing what the original refuses",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "both ways to attach, under each operation on the attachment's name",
						oracle: {
							kind: "second-implementation",
							name: "the original query, before the round trip"
						},
						suite: "unit/query/roundtrip-attached",
						generator: (source) =>
							[
								source.draw(element<Attached>(["an attach stage", "an arm's attach"])),
								source.draw(
									element<Operation>([
										"attach the name again",
										"attach another name",
										"order by the attachment"
									])
								)
							] as const,
						literal: Formatter.format,
						coverage: noCoverage,
						caseHang,
						concurrency: 1
					},
					([from, operation]) =>
						Effect.sync(() => {
							const original = attachedQuery(from)
							const back = rebuiltQuery(descOf(original), Work)
							assert.deepEqual(names(back), names(original))
							/** An attachment's name is a field of the result: attached again or ordered by, it is refused. */
							const refusal: CompileReasonTag = "MalformedDescription"
							const expected = operation === "attach another name" ? "built" : refusal
							const outcome = (f: () => unknown): CompileReasonTag | "built" => {
								const r = catchCompileError(f)
								return r.ok ? "built" : r.error.reason._tag
							}
							assert.equal(outcome(operate(original, operation)), expected, `${from}: ${operation}`)
							assert.equal(
								outcome(operate(back, operation)),
								expected,
								`${from}, rebuilt: ${operation}`
							)
						})
				)
			)
	)

	/** Task's kinds as a recursive row typed by the roster, whose literal handles are checked against the roster. */
	const kinds = () =>
		query(Work).recursive("Kinds", {
			row: { task: Task.fields.id, kind: closedId(Kind) },
			base: [
				(r: RuleValue) => {
					const { id, kind } = v(Task, "task")
					return r.match(Task, { id, kind }).find({ task: id, kind })
				}
			],
			rec: [
				(r: RuleValue, s: object) =>
					r
						.match(s, {})
						.find({ task: r.param("t", Task.fields.id), kind: r.param("k", closedId(Kind)) })
			]
		})
	const matchingKind = (q: unknown, handle: string) => () =>
		query(Work).rule((r: RuleValue) => {
			const { task } = v(q, "q")
			return r.match(q, { task, kind: handle }).find({ task })
		})

	it.effect(
		"types a rebuilt recursive row under the schema's rosters, as the original was typed",
		(ctx) => {
			const original = kinds()
			const back = rebuilt(descOf(original), Work)
			const handles: ReadonlyArray<string> = Kind.handles
			type Handle = "a roster handle" | "no handle"
			return searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "the original recursive row, and the roster's own handles"
						},
						suite: "unit/query/roundtrip-roster",
						draw: drawn(
							weighted([
								[1, element(nonEmpty(handles, "Kind's handles"))],
								[1, string(codePoint(0x20, 0x7e), { min: 0, max: 8 })]
							])
						),
						literal: Formatter.format,
						coverage: required<Handle>(["a roster handle", "no handle"], {
							cases: 60,
							sense: notesOnly
						}),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(handle, c) =>
						Effect.sync(() => {
							assert.deepEqual(
								queryState(back)?.heading.fields.get("kind"),
								queryState(original)?.heading.fields.get("kind")
							)
							/**
							 * A literal against the rebuilt row's handle is checked against the roster, as against the original's.
							 */
							const outcome = (q: unknown) =>
								Result.map(catchCompileError(matchingKind(q, handle)), () => "built")
							const expected = outcome(original)
							assert.deepEqual(
								Result.mapError(outcome(back), (e) => e.reason),
								Result.mapError(expected, (e) => e.reason)
							)
							assert.equal(expected.ok, handles.includes(handle), handle)
							c.note(expected.ok ? "a roster handle" : "no handle")
						})
				)
			)
		}
	)
})

describe("generated queries", () => {
	it.effect(
		"over the worked example's schema decode, are canonical and deterministic, and rebuild to the same query",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "universal",
							name: "the round trip through the Description and its JSON, and the builder run twice"
						},
						suite: "unit/query/roundtrip-58",
						draw: drawn(generated(work)),
						literal: Formatter.format,
						coverage: required<ChainFeature>(chainFeatures, { cases: 300, sense: notesOnly }),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					property(work)
				)
			)
	)

	it.effect(
		"over spans decode, are canonical and deterministic, and rebuild to the same query",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "universal",
							name: "the round trip through the Description and its JSON, and the builder run twice"
						},
						suite: "unit/query/roundtrip-109",
						draw: drawn(generated(spans)),
						literal: Formatter.format,
						coverage: required<ChainFeature>(chainFeatures, { cases: 150, sense: notesOnly }),
						kept: [],
						runs: 150,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					property(spans)
				)
			)
	)
})
