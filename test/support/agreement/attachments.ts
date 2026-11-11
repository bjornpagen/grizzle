import { floorPopulation } from "@grizzle/testing/features"
import { constant, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { sample, type Source } from "@grizzle/testing/source"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { type Delivery, headingsOf, licenses } from "#compiler/core/decoder.ts"
import type { CompileReason } from "#compiler/core/errors.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import * as Result from "#compiler/core/result.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { NodeOf, RelNode } from "#compiler/ir/rel.ts"
import { arm } from "#compiler/query/build/attach.ts"
import { queryOver, type QueryValue, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { AccountTally, Tallies } from "#test/support/agreement/deliver-tally.ts"
import { groupFields, recordType } from "#test/support/agreement/heading.ts"
import { Deliver, DeliverApart } from "#test/support/agreement/schema.ts"
import { defined } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { messageOf } from "#test/support/message.ts"
import {
	identifiers,
	preludeAt,
	type PreludeAt,
	preludeFrom,
	preludeProgram
} from "#test/support/prelude.ts"

/**
 * The attachment agreement: a parent query and a child attached to it, drawn over Deliver (./schema.ts), each with the
 * engine's verdict on the delivery it states, and the one TypeScript program that states every verdict as a type
 * assertion, which the type tier checks (test/types/evidence/attachments.test.ts).
 *
 * The engine is the oracle. A parent matches one relation, or two scopes of it joined on a drawn field; a child matches
 * one relation, binding each field to a parent's head field of its kind, its own variable, a literal or nothing,
 * maybe compares its own variable with a parent's field, heads its own fields or counts its group of parent fields,
 * maybe is ordered or ordered and taken once, and is one rule, a union of two of one heading, or of two headings. A
 * child of one rule heading its own fields may hold a nested attachment of its own, drawn as a child of that child
 * (nestedOf), each attachment delivered by its own evidence and stated under its own directive. The stated delivery is
 * drawn: an array, an Option, the one child, or arm(field, handle) of a parent's head field and a
 * handle of Kind, written as a literal or through a `string`. The engine compiles the attached query in the snapshot
 * context and proves each attachment's delivery (core/decoder.ts licenses): an array always; an Option where it proves
 * at most one child; the one child where it proves exactly one. An arm needs the child the engine proves at most one
 * per parent to be the arm of its handle, which the alternatives law over Task makes it (armClaim): the child's only
 * clause a match of an arm relation keyed by the parent's Task.id of one scope, every other binding its own variable,
 * its field the parent's head field of that scope's Task.kind, and its handle that arm's, one literal. A child of two
 * headings, which one attachment statement cannot deliver, and an attachment named as a field of its parent are the
 * engine's own refusals, and so is a child written over DeliverApart, a schema of Deliver's relations that is no level
 * of the parent's (ForeignLevel), which the types refuse as no child of the parent's schema. The program states each
 * refusal under its directive at the child's line or the name's, and
 * each admitted one's records, of a snapshot read and of a read inside a write transaction, as the engine decodes them:
 * the parent's and the child's records, and the child under the delivery stated, its arm narrowed to Some where the
 * parent's field holds the handle and None elsewhere, and a read-back's one child or arm an Option (readBack), which the
 * engine must prove in the transaction context (transactionFaults), and which a ChangeSet's read-back of it delivers.
 *
 * The floor's witnesses, the same in every run, reach every delivery admitted and refused, every arm refusal, both of
 * the engine's own refusals, every proof of the one child (a containment into an ordinary relation, into a closed one,
 * a composite one, a reflexive aggregate), a self-join parent, a derived parent, every shape of child, and a nested
 * attachment admitted and refused.
 */

type Rel =
	| "Account"
	| "Task"
	| "AutomaticTask"
	| "ManualTask"
	| "TaskNote"
	| "Label"
	| "TaskLabel"
	| "PlanBudget"
	| "AccountTally"
type Kind = "uuid" | "int" | "plan" | "kind" | "cents" | "count"

interface Field {
	readonly name: string
	readonly kind: Kind
}

const fieldsOf: { readonly [R in Rel]: Arr.NonEmptyReadonlyArray<Field> } = {
	Account: [
		{ name: "id", kind: "uuid" },
		{ name: "rank", kind: "int" },
		{ name: "plan", kind: "plan" }
	],
	Task: [
		{ name: "id", kind: "uuid" },
		{ name: "account", kind: "uuid" },
		{ name: "kind", kind: "kind" },
		{ name: "score", kind: "int" }
	],
	AutomaticTask: [
		{ name: "task", kind: "uuid" },
		{ name: "budget", kind: "cents" }
	],
	ManualTask: [
		{ name: "task", kind: "uuid" },
		{ name: "operator", kind: "int" }
	],
	TaskNote: [
		{ name: "task", kind: "uuid" },
		{ name: "note", kind: "int" }
	],
	Label: [
		{ name: "account", kind: "uuid" },
		{ name: "label", kind: "int" },
		{ name: "color", kind: "int" }
	],
	TaskLabel: [
		{ name: "task", kind: "uuid" },
		{ name: "account", kind: "uuid" },
		{ name: "label", kind: "int" }
	],
	PlanBudget: [
		{ name: "plan", kind: "plan" },
		{ name: "budget", kind: "cents" }
	],
	AccountTally: [
		{ name: "account", kind: "uuid" },
		{ name: "tasks", kind: "count" }
	]
}

/** Each relation's primary key, by its fields (./schema.ts). */
const keyOf: { readonly [R in Rel]: Arr.NonEmptyReadonlyArray<string> } = {
	Account: ["id"],
	Task: ["id"],
	AutomaticTask: ["task"],
	ManualTask: ["task"],
	TaskNote: ["task"],
	Label: ["account", "label"],
	TaskLabel: ["task", "label"],
	PlanBudget: ["plan"],
	AccountTally: ["account"]
}

/** The relations a parent matches, and those a child does: every relation, the closed one and Task's arms included. */
const parents: Arr.NonEmptyReadonlyArray<Rel> = [
	"Account",
	"Task",
	"TaskNote",
	"Label",
	"TaskLabel"
]
const children: Arr.NonEmptyReadonlyArray<Rel> = [
	"Account",
	"Task",
	"AutomaticTask",
	"ManualTask",
	"TaskNote",
	"Label",
	"TaskLabel",
	"PlanBudget"
]

/** The arm relations of the alternatives law over Task, by the handle of Kind each is the arm of. */
const armOf: { readonly [R in Rel]?: "Automatic" | "Manual" } = {
	AutomaticTask: "Automatic",
	ManualTask: "Manual"
}

/** A parent's head field: its name, and the field of the scope (0 or 1) its variable is minted at. */
interface HeadField {
	readonly name: string
	readonly scope: 0 | 1
	readonly field: Field
}

/** A parent query: its relation, the field a second scope of it is joined on, if it has one, and its head. */
interface Parent {
	readonly rel: Rel
	readonly peer: string | undefined
	readonly head: Arr.NonEmptyReadonlyArray<HeadField>
}

/** What a child binds a field to: a parent's head field, its own variable, or a literal. */
type ChildTerm =
	| { readonly kind: "parent"; readonly name: string }
	| { readonly kind: "own" }
	| { readonly kind: "literal"; readonly value: number }

/** A child's head: some of its own fields, or the count of its group of parent fields. */
type ChildHead =
	| { readonly kind: "own"; readonly fields: Arr.NonEmptyReadonlyArray<string> }
	| { readonly kind: "count"; readonly groups: ReadonlyArray<string> }

/** A child's comparison of its own variable with a parent's head field. */
interface ChildFilter {
	readonly op: "le" | "lt" | "ne"
	readonly field: string
	readonly parent: string
}

interface Child {
	/** The schema the child is written over: the parent's, or DeliverApart, which is no level of it. */
	readonly schema: "Deliver" | "DeliverApart"
	readonly rel: Rel
	readonly bindings: ReadonlyArray<readonly [string, ChildTerm]>
	readonly filter: ChildFilter | undefined
	readonly head: ChildHead
	/** A set, ordered by its first head field, or ordered and taken once. */
	readonly shape: "set" | "ordered" | "first"
	/** One rule, a union of two of one heading, or of two headings. */
	readonly arms: "one" | "twice" | "apart"
}

/** The delivery an attachment states. */
type Stated =
	| { readonly kind: "array" }
	| { readonly kind: "option" }
	| { readonly kind: "one" }
	| {
			readonly kind: "arm"
			readonly field: string
			readonly handle: "Automatic" | "Manual"
			readonly spelling: "literal" | "widened"
	  }

/** An attachment: its parent, its child, and its stated delivery. */
interface Attachment {
	readonly parent: Parent
	readonly child: Child
	readonly stated: Stated
}

/**
 * One case: an attachment and the name it is stated under, and maybe a nested one on its child, whose parent is the
 * child seen as one (childAsParent).
 */
interface AttachSpec extends Attachment {
	readonly name: string
	readonly nested: Attachment | undefined
}

/** The name a nested attachment is stated under, which no relation's field is. */
const nestedName = "nested"

const capitalized = (s: string): string => Str.capitalize(s)

/** A parent's head field's name: its field's for the first scope, `peer` and its field's for the second. */
const headName = (scope: 0 | 1, field: Field): string =>
	scope === 0 ? field.name : `peer${capitalized(field.name)}`

/**
 * The proofs a child is drawn toward, so the floor reaches each: a containment from a parent's field into the child's
 * key, into an ordinary relation, a closed one or a composite key; a reflexive count over the parent's own relation;
 * a child keyed by the parent, which is at most one per parent; an arm of the alternatives law over Task; a child of
 * Account keyed by a derived parent's account (./deliver-tally.ts), which no containment reaches, so its key proves at
 * most one owner per tally and never exactly one; or a free child. Each draws the parent's head the proof reads and the child the proof makes, then perturbs it: a filter, an
 * order, a take, a second rule, a binding of its own, each of which the engine decides.
 */
const intents = [
	"containment",
	"closed",
	"composite",
	"reflexive",
	"keyed",
	"arm",
	"derived",
	"free"
] as const
type Intent = (typeof intents)[number]

/**
 * The intents a case draws, an arm's, the containments' and a reflexive count's more often, whose refusals and proofs
 * need the most draws.
 */
const intentGen: Gen<Intent> = weighted<Intent>([
	[2, constant("containment")],
	[2, constant("closed")],
	[3, constant("composite")],
	[2, constant("reflexive")],
	[1, constant("keyed")],
	[5, constant("arm")],
	[1, constant("derived")],
	[1, constant("free")]
])

/** For each intent, the parent relation, the parent fields it heads, the child relation and its bindings to them. */
interface Plan {
	readonly parent: Rel
	readonly heads: ReadonlyArray<string>
	readonly child: Rel
	readonly bound: ReadonlyArray<readonly [string, string]>
}

/** The intents whose plans are fixed: each one's plans, drawn among. */
const fixedIntents = ["containment", "closed", "derived", "composite", "keyed", "arm"] as const
type FixedIntent = (typeof fixedIntents)[number]

const fixedPlans: { readonly [I in FixedIntent]: Arr.NonEmptyReadonlyArray<Plan> } = {
	containment: [
		{ parent: "Task", heads: ["account"], child: "Account", bound: [["id", "account"]] },
		{ parent: "TaskNote", heads: ["task"], child: "Task", bound: [["id", "task"]] }
	],
	closed: [{ parent: "Account", heads: ["plan"], child: "PlanBudget", bound: [["plan", "plan"]] }],
	derived: [
		{ parent: "AccountTally", heads: ["account"], child: "Account", bound: [["id", "account"]] }
	],
	composite: [
		{
			parent: "TaskLabel",
			heads: ["account", "label"],
			child: "Label",
			bound: [
				["account", "account"],
				["label", "label"]
			]
		}
	],
	keyed: [
		{ parent: "Task", heads: ["id"], child: "TaskNote", bound: [["task", "id"]] },
		{ parent: "Account", heads: ["id"], child: "Label", bound: [["account", "id"]] },
		{ parent: "TaskLabel", heads: ["task"], child: "Task", bound: [["id", "task"]] }
	],
	arm: [
		{ parent: "Task", heads: ["id", "kind"], child: "AutomaticTask", bound: [["task", "id"]] },
		{ parent: "Task", heads: ["id", "kind"], child: "ManualTask", bound: [["task", "id"]] }
	]
}

/** A reflexive count's plan over `parent`, grouped by its field `grouped`. */
const reflexivePlan = (parent: Rel, grouped: string): Plan => ({
	parent,
	heads: [grouped],
	child: parent,
	bound: [[grouped, grouped]]
})

/** The free plans over `parent`'s fields `heads`: a child with a field of one's kind, bound to nothing planned. */
const freePlans = (parent: Rel, heads: ReadonlyArray<Field>): ReadonlyArray<Plan> =>
	Arr.flatMap(heads, (f) =>
		Arr.flatMap(children, (c) =>
			Arr.some(fieldsOf[c], (g) => g.kind === f.kind)
				? [{ parent, heads: [f.name], child: c, bound: [] }]
				: []
		)
	)

const planOf = (source: Source, intent: Intent): Plan => {
	switch (intent) {
		case "containment":
		case "closed":
		case "derived":
		case "composite":
		case "keyed":
		case "arm":
			return source.draw(element(fixedPlans[intent]))
		case "reflexive": {
			const parent = source.draw(element(parents))
			return reflexivePlan(parent, source.draw(element(fieldsOf[parent])).name)
		}
		case "free": {
			const parent = source.draw(element(parents))
			const plans = freePlans(parent, fieldsOf[parent])
			const task: Plan = { parent, heads: ["id"], child: "Task", bound: [] }
			return source.draw(element(Arr.isReadonlyArrayNonEmpty(plans) ? plans : [task]))
		}
	}
}

/**
 * The plan of a nested attachment over `parent`, a child seen as a parent, with its intent: a fixed plan over its
 * relation whose parent fields its head holds, a reflexive count by one of them, or a free child of one's kind.
 */
const nestedPlanOf = (source: Source, parent: Parent): readonly [Intent, Plan] => {
	const heads = Arr.map(parent.head, (h) => h.field)
	const fixed = Arr.flatMap(fixedIntents, (intent) =>
		Arr.flatMap(fixedPlans[intent], (plan): ReadonlyArray<readonly [Intent, Plan]> =>
			plan.parent === parent.rel &&
			Arr.every(plan.heads, (h) => Arr.some(heads, (f) => f.name === h))
				? [[intent, plan]]
				: []
		)
	)
	const reflexive = Arr.map(heads, (f): readonly [Intent, Plan] => [
		"reflexive",
		reflexivePlan(parent.rel, f.name)
	])
	const free = Arr.map(freePlans(parent.rel, heads), (plan): readonly [Intent, Plan] => [
		"free",
		plan
	])
	return source.draw(element(Arr.appendAll(reflexive, [...fixed, ...free])))
}

/** A coin that lands 1 one time in `odds`. */
const coin = (source: Source, odds: number): boolean => source.draw(int(1, odds)) === 1

/**
 * The parent of a plan: its relation, maybe a second scope joined on a field, and a head of the plan's fields of the
 * first scope and some others of either scope.
 */
const parentOf = (source: Source, plan: Plan): Parent => {
	const fields = fieldsOf[plan.parent]
	const peer = coin(source, 4) ? source.draw(element(fields)).name : undefined
	const scopes: ReadonlyArray<0 | 1> = peer === undefined ? [0] : [0, 1]
	const candidates = Arr.flatMap(scopes, (scope) =>
		Arr.flatMap(fields, (field): ReadonlyArray<HeadField> =>
			scope === 1 && field.name === peer ? [] : [{ name: headName(scope, field), scope, field }]
		)
	)
	const planned = (h: HeadField): boolean => h.scope === 0 && Arr.contains(plan.heads, h.field.name)
	const picked = Arr.filter(candidates, (h) => planned(h) || coin(source, 2))
	const head: Arr.NonEmptyReadonlyArray<HeadField> = Arr.isArrayNonEmpty(picked)
		? picked
		: [defined(candidates[0], "a head field")]
	return { rel: plan.parent, peer, head }
}

/**
 * The child of a plan over `parent`: the plan's bindings to the parent's first scope, every other field its own
 * variable, nothing, a parent's field of its kind or a literal; then the draws that perturb it.
 */
const childOf = (source: Source, plan: Plan, parent: Parent, intent: Intent): Child => {
	const fields = fieldsOf[plan.child]
	const plannedTo = (field: string): string | undefined =>
		Option.getOrUndefined(
			Option.map(
				Arr.findFirst(plan.bound, ([f]) => f === field),
				([, p]) => p
			)
		)
	const drawn = Arr.flatMap(fields, (field): ReadonlyArray<readonly [string, ChildTerm]> => {
		const planned = plannedTo(field.name)
		if (planned !== undefined && !coin(source, 8)) {
			return [[field.name, { kind: "parent", name: planned }]]
		}
		const fitting = Arr.filter(parent.head, (h) => h.field.kind === field.kind)
		const forms: Arr.NonEmptyReadonlyArray<() => ChildTerm | undefined> = [
			() => ({ kind: "own" }),
			() => undefined,
			...(Arr.isReadonlyArrayNonEmpty(fitting) && (intent === "free" || coin(source, 6))
				? [(): ChildTerm => ({ kind: "parent", name: source.draw(element(fitting)).name })]
				: []),
			...(field.kind === "int" && coin(source, 6)
				? [(): ChildTerm => ({ kind: "literal", value: 1 })]
				: [])
		]
		const term = source.draw(element(forms))()
		return term === undefined ? [] : [[field.name, term] as const]
	})
	const bindings = correlated(source, drawn, fields, parent)
	const own = Arr.flatMap(bindings, ([f, t]) => (t.kind === "own" ? [f] : []))
	const kindOf = (f: string): Kind | undefined =>
		Option.getOrUndefined(
			Option.map(
				Arr.findFirst(fields, (g) => g.name === f),
				(g) => g.kind
			)
		)
	const comparable = Arr.flatMap(own, (f) =>
		Arr.flatMap(parent.head, (h) => {
			const kind = kindOf(f)
			return (kind === "int" || kind === "uuid") && kind === h.field.kind
				? [[f, h.name] as const]
				: []
		})
	)
	const calm = intent !== "free" && intent !== "reflexive"
	const filtered = intent === "reflexive" ? coin(source, 2) : coin(source, calm ? 10 : 5)
	const filter: ChildFilter | undefined =
		Arr.isReadonlyArrayNonEmpty(comparable) && filtered
			? (() => {
					const [field, name] = source.draw(element(comparable))
					return { op: source.draw(element(["le", "lt", "ne"] as const)), field, parent: name }
				})()
			: undefined
	const parented = Arr.flatMap(bindings, ([, t]) => (t.kind === "parent" ? [t.name] : []))
	const counted = intent === "reflexive" ? !coin(source, 8) : coin(source, calm ? 10 : 5)
	const head: ChildHead =
		Arr.isReadonlyArrayNonEmpty(own) && !counted
			? {
					kind: "own",
					fields: (() => {
						const picked = Arr.filter(own, () => coin(source, 2))
						return Arr.isReadonlyArrayNonEmpty(picked) ? picked : [own[0]]
					})()
				}
			: { kind: "count", groups: Arr.dedupe(Arr.filter(parented, () => coin(source, 2))) }
	const shape = coin(source, calm ? 8 : 4)
		? source.draw(element(["ordered", "first"] as const))
		: "set"
	const arms = coin(source, calm ? 10 : 5)
		? source.draw(element(["twice", "apart"] as const))
		: "one"
	return {
		schema: "Deliver",
		rel: plan.child,
		bindings: keyed(plan.child, bindings, head),
		filter,
		head,
		shape,
		arms
	}
}

/**
 * A counting child's bindings, which bind every field of its relation's key (a fold reads each fact it matches once, by
 * a key): as drawn where they do, and otherwise with the key's unbound fields bound to its own variables.
 */
const keyed = (
	rel: Rel,
	bindings: ReadonlyArray<readonly [string, ChildTerm]>,
	head: ChildHead
): ReadonlyArray<readonly [string, ChildTerm]> =>
	head.kind === "own"
		? bindings
		: [
				...bindings,
				...Arr.flatMap(keyOf[rel], (f): ReadonlyArray<readonly [string, ChildTerm]> =>
					Arr.some(bindings, ([b]) => b === f) ? [] : [[f, { kind: "own" }]]
				)
			]

/**
 * A child's bindings with one to a parent's field at least, so it reads its parent: as drawn where they hold one, and
 * otherwise with a field of a kind some parent's field has bound to such a field, in place of its own binding.
 */
const correlated = (
	source: Source,
	drawn: ReadonlyArray<readonly [string, ChildTerm]>,
	fields: ReadonlyArray<Field>,
	parent: Parent
): ReadonlyArray<readonly [string, ChildTerm]> => {
	if (Arr.some(drawn, ([, t]) => t.kind === "parent")) {
		return drawn
	}
	const fitting = Arr.flatMap(fields, (f) =>
		Arr.flatMap(parent.head, (h) => (h.field.kind === f.kind ? [[f.name, h.name] as const] : []))
	)
	if (!Arr.isReadonlyArrayNonEmpty(fitting)) {
		return drawn
	}
	const [field, name] = source.draw(element(fitting))
	return [...Arr.filter(drawn, ([f]) => f !== field), [field, { kind: "parent", name }]]
}

/**
 * A delivery stated over `parent` and `child`: an array, an Option, the one child or an arm of a parent's field, an
 * arm's field and handle mostly the ones the plan's arm would state, and the one child more often where the intent is
 * a proof of it. A child of two headings states an array, so the engine's one refusal of it is the case's one.
 */
const statedOf = (source: Source, parent: Parent, child: Child, intent: Intent): Stated => {
	if (child.arms === "apart") {
		return { kind: "array" }
	}
	const armed = intent === "arm" ? !coin(source, 3) : coin(source, 8)
	if (armed) {
		const kinds = Arr.filter(parent.head, (h) => h.scope === 0 && h.field.name === "kind")
		const field =
			Arr.isReadonlyArrayNonEmpty(kinds) && !coin(source, 3)
				? kinds[0].name
				: source.draw(element(parent.head)).name
		const handle = handleOfArm(child.rel)
		return {
			kind: "arm",
			field,
			handle:
				handle !== undefined && !coin(source, 4)
					? handle
					: source.draw(element(["Automatic", "Manual"] as const)),
			spelling: coin(source, 4) ? "widened" : "literal"
		}
	}
	const proving =
		intent === "containment" ||
		intent === "closed" ||
		intent === "composite" ||
		intent === "reflexive"
	return source.draw(
		element(
			proving
				? ([{ kind: "array" }, { kind: "option" }, { kind: "one" }, { kind: "one" }] as const)
				: ([{ kind: "array" }, { kind: "option" }, { kind: "one" }] as const)
		)
	)
}

/** The field of a relation named `name`. */
const fieldOf = (rel: Rel, name: string): Field =>
	defined(
		Option.getOrUndefined(Arr.findFirst(fieldsOf[rel], (f) => f.name === name)),
		`${rel}.${name}`
	)

/**
 * A child as the parent of a nested attachment, where it is a set of one rule heading its own fields: its relation,
 * and those fields as its head, all of one scope.
 */
const childAsParent = (child: Child): Parent | undefined =>
	child.head.kind === "own" && child.arms === "one" && child.shape === "set"
		? {
				rel: child.rel,
				peer: undefined,
				head: Arr.map(child.head.fields, (name): HeadField => ({
					name,
					scope: 0,
					field: fieldOf(child.rel, name)
				}))
			}
		: undefined

/**
 * A nested attachment over a child seen as `parent`: a plan over it (nestedPlanOf), and a child of one heading toward
 * the plan with its stated delivery, drawn as a case's.
 */
const nestedOf = (source: Source, parent: Parent): Attachment => {
	const [intent, plan] = nestedPlanOf(source, parent)
	const drawn = childOf(source, plan, parent, intent)
	const child: Child = { ...drawn, arms: drawn.arms === "apart" ? "one" : drawn.arms }
	return { parent, child, stated: statedOf(source, parent, child, intent) }
}

/**
 * One case: an intent, a parent and child toward it, the attachment's name (mostly new, sometimes a field of the
 * parent's, with an array of a child of one rule so the name is the case's one refusal), its stated delivery, and, on
 * a child that may hold one, sometimes a nested attachment.
 */
const specGen: Gen<AttachSpec> = (source) => {
	const intent = source.draw(intentGen)
	const plan = planOf(source, intent)
	const parent = parentOf(source, plan)
	const child = childOf(source, plan, parent, intent)
	if (coin(source, 16)) {
		return {
			parent,
			name: source.draw(element(parent.head)).name,
			child: { ...child, arms: "one" },
			stated: { kind: "array" },
			nested: undefined
		}
	}
	if (coin(source, 16)) {
		return {
			parent,
			name: "child",
			child: { ...child, schema: "DeliverApart", arms: "one" },
			stated: { kind: "array" },
			nested: undefined
		}
	}
	const asParent = childAsParent(child)
	return {
		parent,
		name: "child",
		child,
		stated: statedOf(source, parent, child, intent),
		nested: asParent !== undefined && coin(source, 3) ? nestedOf(source, asParent) : undefined
	}
}

/** The scope names of a parent's two scopes, and a child's. */
const scopeNames = ["own", "peer"] as const
const childScope = "child"

/** The variable of a parent's scope at `field`, in the program. */
const parentVar = (scope: 0 | 1, field: string): string => `${scopeNames[scope]}.${field}`

/** The parent's rule, in the program: its scopes, its matches, and its head. */
const parentSource = (parent: Parent): string => {
	const fields = fieldsOf[parent.rel]
	const own = `{ ${Arr.join(
		Arr.map(fields, (f) => `${f.name}: ${parentVar(0, f.name)}`),
		", "
	)} }`
	const peer =
		parent.peer === undefined
			? ""
			: `.match(${parent.rel}, { ${Arr.join(
					Arr.map(fields, (f) => `${f.name}: ${parentVar(f.name === parent.peer ? 0 : 1, f.name)}`),
					", "
				)} })`
	const scopes =
		parent.peer === undefined
			? `const own = v(${parent.rel}, "own"); `
			: `const own = v(${parent.rel}, "own"); const peer = v(${parent.rel}, "peer"); `
	const head = `{ ${Arr.join(
		Arr.map(parent.head, (h) => `${h.name}: ${parentVar(h.scope, h.field.name)}`),
		", "
	)} }`
	return `query(${schemaName(parent.rel)}).rule((r) => { ${scopes}return r.match(${parent.rel}, ${own})${peer}.find(${head}) })`
}

/** A child's term, in the program: a parent's field, its own variable, or a literal. */
const childTerm = (field: string, t: ChildTerm): string => {
	switch (t.kind) {
		case "parent":
			return `p.${t.name}`
		case "own":
			return `${childScope}.${field}`
		case "literal":
			return String(t.value)
	}
}

/** The head of a child's rule, in the program, and of its second rule where it is a union. */
const childHead = (child: Child, second: boolean): string => {
	const fields =
		child.head.kind === "own"
			? Arr.map(child.head.fields, (f) => `${f}: ${childScope}.${f}`)
			: [...Arr.map(child.head.groups, (g) => `${g}: p.${g}`), "n: r.count()"]
	const told = child.arms === "one" ? [] : [`d: ${jsonText(second ? "b" : "a")}`]
	const apart = child.arms === "apart" && second ? ["e: 1"] : []
	return `{ ${Arr.join([...fields, ...told, ...apart], ", ")} }`
}

/** A child's first head field, which an ordered child orders by. */
const firstHeadField = (child: Child): string =>
	child.head.kind === "own" ? child.head.fields[0] : "n"

/** The child of an attachment, in the program: `(p) => query(Deliver).rule(…)`, its second rule, its order and take. */
const childSource = (child: Child): string => {
	const bindings = `{ ${Arr.join(
		Arr.map(child.bindings, ([f, t]) => `${f}: ${childTerm(f, t)}`),
		", "
	)} }`
	const filter =
		child.filter === undefined
			? ""
			: `.where(r.${child.filter.op}(${childScope}.${child.filter.field}, p.${child.filter.parent}))`
	const reads =
		Arr.some(child.bindings, ([, t]) => t.kind === "own") ||
		child.filter !== undefined ||
		child.head.kind === "own"
	const scope = reads ? `const ${childScope} = v(${child.rel}, ${jsonText(childScope)}); ` : ""
	const rule = (second: boolean): string =>
		`.rule((r) => { ${scope}return r.match(${child.rel}, ${bindings})${filter}.find(${childHead(child, second)}) })`
	const arms = child.arms === "one" ? rule(false) : `${rule(false)}${rule(true)}`
	const order =
		child.shape === "set"
			? ""
			: `.orderBy([${jsonText(firstHeadField(child))}, "asc"])${child.shape === "first" ? ".take(1)" : ""}`
	return `(p) => query(${child.schema})${arms}${order}`
}

/** The stated delivery, in the program. */
const statedSource = (stated: Stated): string => {
	switch (stated.kind) {
		case "array":
		case "option":
		case "one":
			return jsonText(stated.kind)
		case "arm":
			return `arm(${jsonText(stated.field)}, ${stated.spelling === "literal" ? jsonText(stated.handle) : "anyHandle"})`
	}
}

/** The relations of Deliver and its derived parent, by name, as the JavaScript view reads them. */
const relations: Readonly<Record<Rel, unknown>> = { ...Deliver.relations, AccountTally }

/** The schema a parent over a relation is a query over: Deliver, or its extension for its derived relation. */
const schemaName = (rel: Rel): "Deliver" | "Tallies" =>
	rel === "AccountTally" ? "Tallies" : "Deliver"

const schemas = { Deliver, Tallies } as const

/** The schemas a child is written over, by name. */
const childSchemas = { Deliver, DeliverApart } as const

const relationOf = (rel: Rel): unknown => relations[rel]

/** The parent, built through the query builder's JavaScript view. */
const builtParent = (parent: Parent): QueryValue =>
	queryOver(schemas[schemaName(parent.rel)]).rule((r: RuleValue) => {
		const own = varsOver(relationOf(parent.rel), "own")
		const peer = parent.peer === undefined ? own : varsOver(relationOf(parent.rel), "peer")
		const scope = (s: 0 | 1): Readonly<Record<string, unknown>> => (s === 0 ? own : peer)
		const fields = fieldsOf[parent.rel]
		const first = r.match(
			relationOf(parent.rel),
			Rec.fromEntries(Arr.map(fields, (f) => [f.name, own[f.name]] as const))
		)
		const matched =
			parent.peer === undefined
				? first
				: first.match(
						relationOf(parent.rel),
						Rec.fromEntries(
							Arr.map(
								fields,
								(f) => [f.name, (f.name === parent.peer ? own : peer)[f.name]] as const
							)
						)
					)
		return matched.find(
			Rec.fromEntries(Arr.map(parent.head, (h) => [h.name, scope(h.scope)[h.field.name]] as const))
		)
	})

/** The `second`-th rule of a child over the parent's variables `p`, built through the query builder's JavaScript view. */
const childRule =
	(child: Child, p: Readonly<Record<string, unknown>>, second: boolean) =>
	(r: RuleValue): unknown => {
		const own = varsOver(relationOf(child.rel), childScope)
		const term = (field: string, t: ChildTerm): unknown => {
			switch (t.kind) {
				case "parent":
					return p[t.name]
				case "own":
					return own[field]
				case "literal":
					return t.value
			}
		}
		const matched = r.match(
			relationOf(child.rel),
			Rec.fromEntries(Arr.map(child.bindings, ([f, t]) => [f, term(f, t)] as const))
		)
		const filtered =
			child.filter === undefined
				? matched
				: matched.where(r[child.filter.op](own[child.filter.field], p[child.filter.parent]))
		const fields: ReadonlyArray<readonly [string, unknown]> =
			child.head.kind === "own"
				? Arr.map(child.head.fields, (f) => [f, own[f]] as const)
				: [...Arr.map(child.head.groups, (g) => [g, p[g]] as const), ["n", r.count()]]
		const told: ReadonlyArray<readonly [string, unknown]> =
			child.arms === "one" ? [] : [["d", second ? "b" : "a"]]
		const apart: ReadonlyArray<readonly [string, unknown]> =
			child.arms === "apart" && second ? [["e", 1]] : []
		return filtered.find(Rec.fromEntries([...fields, ...told, ...apart]))
	}

/** The child over the parent's variables `p`, as its attachment states it: its rules, its order and take. */
const builtChild = (child: Child, p: Readonly<Record<string, unknown>>): unknown => {
	const first = queryOver(childSchemas[child.schema]).rule(childRule(child, p, false))
	const union = child.arms === "one" ? first : first.rule(childRule(child, p, true))
	switch (child.shape) {
		case "set":
			return union
		case "ordered":
			return union.orderBy([firstHeadField(child), "asc"])
		case "first":
			return union.orderBy([firstHeadField(child), "asc"]).take(1)
	}
}

/** The delivery a stated one is read under by the analysis: an arm is at most one child, as an Option is. */
const deliveryOf = (stated: Stated): Delivery => (stated.kind === "arm" ? "option" : stated.kind)

/** How a read inside a write transaction reads each stated delivery: the one child and an arm as an Option. */
const readBack = (stated: Stated): Delivery => {
	switch (stated.kind) {
		case "array":
			return "array"
		case "option":
		case "one":
		case "arm":
			return "option"
	}
}

/** The stated delivery, through the JavaScript view. */
const statedValue = (stated: Stated): unknown =>
	stated.kind === "arm" ? arm(stated.field, stated.handle) : stated.kind

/**
 * The parent with its attachment, built through the JavaScript view: its child, or, where it holds a nested attachment,
 * its child's one rule with the nested attachment on it.
 */
const builtAttached = (spec: AttachSpec): QueryValue =>
	builtParent(spec.parent).attach(
		spec.name,
		(p: Readonly<Record<string, unknown>>) => {
			const nested = spec.nested
			return nested === undefined
				? builtChild(spec.child, p)
				: queryOver(Deliver)
						.rule(childRule(spec.child, p, false))
						.attach(
							nestedName,
							(q: Readonly<Record<string, unknown>>) => builtChild(nested.child, q),
							statedValue(nested.stated)
						)
		},
		statedValue(spec.stated)
	)

/** The arm relations' handles: the handle of Kind whose arm a child's relation is, where it is one. */
const handleOfArm = (rel: Rel): "Automatic" | "Manual" | undefined => armOf[rel]

/**
 * The arm claim the alternatives law over Task makes of a stated arm (see the header): the refusal the types name
 * where the claim fails, in the order the types read it, and none where it holds.
 */
const armClaim = (
	spec: Attachment,
	stated: Extract<Stated, { readonly kind: "arm" }>
): Refused | undefined => {
	const handle = handleOfArm(spec.child.rel)
	const keyedBy = Arr.flatMap(spec.child.bindings, ([f, t]) =>
		f === "task" && t.kind === "parent" ? [t.name] : []
	)
	const others = Arr.every(spec.child.bindings, ([f, t]) => f === "task" || t.kind === "own")
	const keyField = Arr.findFirst(
		spec.parent.head,
		(h) => Arr.contains(keyedBy, h.name) && h.field.name === "id"
	)
	const armShaped =
		spec.parent.rel === "Task" &&
		others &&
		spec.child.filter === undefined &&
		spec.child.head.kind === "own" &&
		spec.child.shape !== "first" &&
		spec.child.arms === "one"
	if (handle === undefined || Option.isNone(keyField) || !armShaped) {
		return "an arm needs a child that is the arm of one handle of an alternatives law, keyed by the parent's key"
	}
	const scope = keyField.value.scope
	const kinds = Arr.filter(spec.parent.head, (h) => h.scope === scope && h.field.name === "kind")
	const [discriminator] = kinds
	if (kinds.length !== 1 || discriminator === undefined || discriminator.name !== stated.field) {
		return "the arm's field is the parent's head field that holds its discriminator"
	}
	if (stated.spelling === "widened") {
		return "the arm's handle is one literal"
	}
	return stated.handle === handle
		? undefined
		: "the arm's handle is the handle the child is the arm of"
}

/** Where a refusal's directive stands: above the attachment's name, its child, or its nested attachment's child. */
type AttachAt = "name" | "child" | "nested"

/**
 * What the program states of an attachment the types must refuse: its line, and the refusal it names, or why in prose
 * where the refusal is structural (a child over no level of the parent's schema).
 */
interface AttachRefused {
	readonly at: AttachAt
	readonly claim:
		| { readonly kind: "refusal"; readonly refusal: Refused }
		| { readonly kind: "prose"; readonly reason: string }
}

/** A refusal the types name at `at`. */
const namedAt = (at: AttachAt, refusal: Refused): AttachRefused => ({
	at,
	claim: { kind: "refusal", refusal }
})

/** What a refusal claims, as a note and a directive name it. */
const claimText = (refused: AttachRefused): string =>
	refused.claim.kind === "refusal" ? refused.claim.refusal : refused.claim.reason

/** What the engine proves of an attachment it admits, and of its nested one, and the records the types must infer. */
interface AttachAdmitted {
	readonly proved: Delivery
	readonly nested: Delivery | undefined
	readonly head: string
	readonly immediate: string
}

type AttachVerdict =
	| { readonly kind: "admitted"; readonly admitted: AttachAdmitted }
	| { readonly kind: "refused"; readonly refused: Arr.NonEmptyReadonlyArray<AttachRefused> }

/** A heading group's records, as ./heading.ts writes them, of the one rule `arm` builds. */
const ruleRecord = (
	q: QueryValue,
	heading: Parameters<typeof groupFields>[2]
): ReadonlyArray<readonly [string, string]> =>
	groupFields(defined(headingsOf(q.rows)[0], "a rule's one heading group"), q.heading, heading)

/** A child's rules: one, or two where it is a union. */
const rulesOf = (child: Child): ReadonlyArray<boolean> =>
	child.arms === "one" ? [false] : [false, true]

/**
 * The fields of the one rule `rule` builds over its parent's variables, built alone where `reach` attaches it, its
 * carriers decoding the fields `heading`, the child heading of the analyzed DAG's attachment, types.
 */
const capturedFields = (
	reach: (attach: (p: Readonly<Record<string, unknown>>) => QueryValue) => unknown,
	rule: (p: Readonly<Record<string, unknown>>) => (r: RuleValue) => unknown,
	heading: Parameters<typeof groupFields>[2]
): ReadonlyArray<readonly [string, string]> => {
	const captured: Array<QueryValue> = []
	reach((p) => {
		const q = queryOver(Deliver).rule(rule(p))
		captured.push(q)
		return q
	})
	return ruleRecord(defined(captured[0], "the rule the builder called"), heading)
}

/** How a read delivers an attachment: a snapshot read as stated, a read-back as readBack reads it. */
type Read = "snapshot" | "readBack"

/**
 * A record of `fields` with the attachment `name` of the child records `child` delivered as `stated` under `read`: a
 * snapshot read's arm narrows the field it names, Some where it holds the handle and None elsewhere.
 */
const attachedRecord = (
	fields: ReadonlyArray<readonly [string, string]>,
	name: string,
	stated: Stated,
	child: string,
	read: Read
): string => {
	const delivered = (d: Delivery): string => {
		switch (d) {
			case "array":
				return `ReadonlyArray<${child}>`
			case "option":
				return `Option.Option<${child}>`
			case "one":
				return child
		}
	}
	if (read === "readBack") {
		return recordType([...fields, [name, delivered(readBack(stated))]])
	}
	if (stated.kind !== "arm") {
		return recordType([...fields, [name, delivered(stated.kind)]])
	}
	const others = Arr.filter(["Automatic", "Manual"] as const, (h) => h !== stated.handle)
	const narrowed = (handle: string, d: string): string =>
		recordType([
			...Arr.map(
				fields,
				([field, type]) => [field, field === stated.field ? handle : type] as const
			),
			[name, d]
		])
	return Arr.join(
		[
			narrowed(jsonText(stated.handle), `Option.Some<${child}>`),
			narrowed(
				Arr.join(
					Arr.map(others, (h) => jsonText(h)),
					" | "
				),
				`Option.None<${child}>`
			)
		],
		" | "
	)
}

/** An attachment with the node of the analyzed DAG that delivers it. */
interface Analyzed {
	readonly attachment: Attachment
	readonly node: NodeOf<"Attach">
}

/**
 * The records of a snapshot read and of a read-back of a parent with the stated child, its nested attachment's
 * delivered within each of its records (see the header): each rule of a child built alone over its parent's variables.
 */
const recordsOf = (
	spec: AttachSpec,
	node: NodeOf<"Attach">,
	nested: Analyzed | undefined
): { readonly head: string; readonly immediate: string } => {
	const fields = ruleRecord(builtParent(spec.parent), node.parent.heading)
	const reachChild = (attach: (p: Readonly<Record<string, unknown>>) => QueryValue): unknown =>
		builtParent(spec.parent).attach("probe", attach, "array")
	const childFields = Arr.map(rulesOf(spec.child), (second) =>
		capturedFields(reachChild, (p) => childRule(spec.child, p, second), node.child.heading)
	)
	const inner =
		nested === undefined
			? undefined
			: {
					stated: nested.attachment.stated,
					records: Arr.join(
						Arr.map(rulesOf(nested.attachment.child), (second) =>
							recordType(
								capturedFields(
									(attach) =>
										reachChild((p) =>
											queryOver(Deliver)
												.rule(childRule(spec.child, p, false))
												.attach("probe", attach, "array")
										),
									(p) => childRule(nested.attachment.child, p, second),
									nested.node.child.heading
								)
							)
						),
						" | "
					)
				}
	const records = (read: Read): string => {
		const child = Arr.join(
			Arr.map(childFields, (f) =>
				inner === undefined
					? recordType(f)
					: attachedRecord(f, nestedName, inner.stated, inner.records, read)
			),
			" | "
		)
		return attachedRecord(fields, spec.name, spec.stated, child, read)
	}
	return { head: records("snapshot"), immediate: records("readBack") }
}

/** The refusal an engine reason is where the case's own refusal is the engine's: its name's, or its child's. */
const engineRefusal = (spec: AttachSpec, reason: CompileReason): AttachRefused | undefined => {
	const label = "at" in reason && "label" in reason.at ? reason.at.label : ""
	if (
		reason._tag === "MalformedDescription" &&
		Str.startsWith("Query.attach(")(label) &&
		Arr.some(spec.parent.head, (h) => h.name === spec.name)
	) {
		return namedAt("name", "a new field name for the attachment")
	}
	if (reason._tag === "UnsupportedOperation" && spec.child.arms === "apart") {
		return namedAt(
			"child",
			"an attached heterogeneous union; one attachment statement delivers one heading"
		)
	}
	if (reason._tag === "ForeignLevel" && spec.child.schema === "DeliverApart") {
		return { at: "child", claim: { kind: "prose", reason: foreignChild } }
	}
	return undefined
}

/** Why the types refuse a child over no level of its parent's schema: no child of that schema (types/query Child). */
const foreignChild = "an attachment child is a query over a level of the parent's schema"

/** The refusal the types name for a stated delivery the engine does not license, or an arm the law does not make. */
const claimRefusal = (spec: Attachment, proved: Delivery): Refused | undefined => {
	const stated = spec.stated
	switch (stated.kind) {
		case "array":
			return undefined
		case "option":
			return licenses(proved, "option")
				? undefined
				: "an Option needs a child the evidence proves at most one per parent"
		case "one":
			return licenses(proved, "one")
				? undefined
				: "the one child needs a child the evidence proves exactly one per parent"
		case "arm":
			return armClaim(spec, stated)
	}
}

const attachVerdict = (spec: AttachSpec): AttachVerdict => {
	const failed = (what: string): never => {
		throw new Error(
			`the engine refuses a drawn attachment for no reason of its own, a defect of the generator: ${what}\n${sourceOf(spec)}`
		)
	}
	const template = Result.flatMap(
		catchCompileError(() => builtAttached(spec)),
		(q) => compileTemplate(q, undefined, testCompile)
	)
	if (!template.ok) {
		const refused = engineRefusal(spec, template.error.reason)
		return refused === undefined
			? failed(messageOf(template.error))
			: { kind: "refused", refused: [refused] }
	}
	const nodes = topoOrder(template.value.analyzed)
	const node = attachNode(nodes, spec.name)
	const nested: Analyzed | undefined =
		spec.nested === undefined
			? undefined
			: { attachment: spec.nested, node: attachNode(nodes, nestedName) }
	const analyzed: ReadonlyArray<readonly [Analyzed, AttachAt]> = [
		[{ attachment: spec, node }, "child"],
		...(nested === undefined ? [] : [[nested, "nested"] as const])
	]
	const refused = Arr.flatMap(analyzed, ([a, at]): ReadonlyArray<AttachRefused> => {
		const claimed = claimRefusal(a.attachment, a.node.delivered)
		return claimed === undefined ? [] : [namedAt(at, claimed)]
	})
	if (Arr.isReadonlyArrayNonEmpty(refused)) {
		return { kind: "refused", refused }
	}
	for (const [a] of analyzed) {
		if (!licenses(a.node.delivered, deliveryOf(a.attachment.stated))) {
			return failed(`the law makes the child an arm the engine proves only as ${a.node.delivered}`)
		}
	}
	return {
		kind: "admitted",
		admitted: {
			proved: node.delivered,
			nested: nested?.node.delivered,
			...recordsOf(spec, node, nested)
		}
	}
}

/** The attachment named `name` among an analyzed DAG's nodes. */
const attachNode = (nodes: ReadonlyArray<RelNode>, name: string): NodeOf<"Attach"> =>
	Option.getOrThrowWith(
		Arr.findFirst(nodes, (n): n is NodeOf<"Attach"> => n.kind === "Attach" && n.name === name),
		() => new Error(`the analyzed query has no attachment ${name}`)
	)

/**
 * One attachment's statement, a line per argument and a nested attachment's within its child's, so each directive
 * `directives` places stands above the argument it is at.
 */
const linesOf = (
	spec: AttachSpec,
	i: number,
	directives: (at: AttachAt) => ReadonlyArray<string>
): ReadonlyArray<string> => {
	const above = (at: AttachAt, indent: string): ReadonlyArray<string> =>
		Arr.map(directives(at), (d) => `${indent}${d}`)
	return [
		`export const a${i} = ${parentSource(spec.parent)}.attach(`,
		...above("name", "\t"),
		`\t${jsonText(spec.name)},`,
		...above("child", "\t"),
		...(spec.nested === undefined
			? [`\t${childSource(spec.child)},`]
			: [
					`\t${childSource(spec.child)}.attach(`,
					`\t\t${jsonText(nestedName)},`,
					...above("nested", "\t\t"),
					`\t\t${childSource(spec.nested.child)},`,
					`\t\t${statedSource(spec.nested.stated)}`,
					"\t),"
				]),
		`\t${statedSource(spec.stated)}`,
		")"
	]
}

const sourceOf = (spec: AttachSpec): string =>
	Arr.join(
		linesOf(spec, 0, () => []),
		"\n"
	)

/** What an attachment case reached: its intent's proof, its shapes, its stated delivery and the verdict. */
export type AttachNote =
	| `${Delivery | "arm"} admitted`
	| `refused: ${Refused}`
	| "one into an ordinary relation"
	| "one into a closed relation"
	| "one through a composite containment"
	| "one by a reflexive count"
	| "a self-join parent"
	| "a child filter"
	| "an ordered child"
	| "a child taken once"
	| "a child of two rules"
	| "a derived parent"
	| "a nested attachment admitted"
	| "a nested attachment refused"
	| "a foreign child refused"

interface AttachCase {
	readonly spec: AttachSpec
	readonly verdict: AttachVerdict
	readonly notes: ReadonlySet<AttachNote>
}

const attachCaseGen: Gen<AttachCase> = (source) => {
	const spec = specGen(source)
	const verdict = attachVerdict(spec)
	const notes = new Set<AttachNote>()
	switch (verdict.kind) {
		case "refused":
			for (const refused of verdict.refused) {
				notes.add(
					refused.claim.kind === "refusal"
						? `refused: ${refused.claim.refusal}`
						: "a foreign child refused"
				)
				if (refused.at === "nested") {
					notes.add("a nested attachment refused")
				}
			}
			break
		case "admitted":
			notes.add(`${spec.stated.kind} admitted`)
			if (spec.nested !== undefined) {
				notes.add("a nested attachment admitted")
			}
			if (spec.stated.kind === "one") {
				notes.add(
					spec.child.head.kind === "count"
						? "one by a reflexive count"
						: spec.child.rel === "PlanBudget"
							? "one into a closed relation"
							: spec.child.rel === "Label"
								? "one through a composite containment"
								: "one into an ordinary relation"
				)
			}
			break
	}
	if (spec.parent.peer !== undefined) {
		notes.add("a self-join parent")
	}
	if (spec.child.filter !== undefined) {
		notes.add("a child filter")
	}
	if (spec.child.shape === "ordered") {
		notes.add("an ordered child")
	}
	if (spec.child.shape === "first") {
		notes.add("a child taken once")
	}
	if (spec.child.arms === "twice") {
		notes.add("a child of two rules")
	}
	if (spec.parent.rel === "AccountTally") {
		notes.add("a derived parent")
	}
	return { spec, verdict, notes }
}

/** The refusals the attachment population names, every one of which its witnesses reach. */
export const attachRefusals: Arr.NonEmptyReadonlyArray<Refused> = [
	"an Option needs a child the evidence proves at most one per parent",
	"the one child needs a child the evidence proves exactly one per parent",
	"an arm needs a child that is the arm of one handle of an alternatives law, keyed by the parent's key",
	"the arm's field is the parent's head field that holds its discriminator",
	"the arm's handle is one literal",
	"the arm's handle is the handle the child is the arm of",
	"a new field name for the attachment",
	"an attached heterogeneous union; one attachment statement delivers one heading"
]

/** The attachments the run's own stream draws, and the floor's witnesses. */
const attachCount = 200

const attachLabel = "types/evidence attachments"

export const attachWitnesses = () =>
	floorPopulation(attachLabel, attachCaseGen, attachCount, (c) => [...c.notes])

const attachCases = (seed: number): ReadonlyArray<AttachCase> => [
	...attachWitnesses().values,
	...sample(attachCaseGen, rotatingSeed(seed, floorSeed(attachLabel)), attachCount)
]

/**
 * The admitted cases whose read-back delivery the engine does not prove in the transaction context: none, since a
 * read inside a write transaction reads the one child and an arm as an Option, which the immediate evidence proves.
 */
export const transactionFaults = (seed: number): ReadonlyArray<string> =>
	Arr.flatMap(attachCases(seed), (c) => {
		if (c.verdict.kind !== "admitted") {
			return []
		}
		const template = Result.flatMap(
			catchCompileError(() => builtAttached(c.spec)),
			(q) => compileTemplate(q, undefined, { ...testCompile, context: "transaction" })
		)
		if (!template.ok) {
			return [
				`${sourceOf(c.spec)}\n  the transaction context refuses it: ${messageOf(template.error)}`
			]
		}
		const nodes = topoOrder(template.value.analyzed)
		const stated: ReadonlyArray<readonly [string, Stated]> = [
			[c.spec.name, c.spec.stated],
			...(c.spec.nested === undefined ? [] : [[nestedName, c.spec.nested.stated] as const])
		]
		return Arr.flatMap(stated, ([name, s]) => {
			const node = Arr.findFirst(
				nodes,
				(n): n is NodeOf<"Attach"> => n.kind === "Attach" && n.name === name
			)
			return Option.isSome(node) && licenses(node.value.delivered, readBack(s))
				? []
				: [
						`${sourceOf(c.spec)}\n  a read-back reads ${name} as ${readBack(s)}, which the transaction context does not prove`
					]
		})
	})

/** The attachment program's prelude (test/support/programs/attachments.ts), every name it reads. */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/attachments.ts"))

export const attachEntriesFrom = (entry: (path: string) => string): PreludeAt =>
	preludeFrom(prelude, entry)

/** The statements of one case: the attachment, under its refusal's directive at its line, or its records asserted. */
const attachBlock = (c: AttachCase, i: number): ReadonlyArray<string> => {
	switch (c.verdict.kind) {
		case "refused": {
			const refused = c.verdict.refused
			return [
				`/** The engine refuses the attachment: ${Arr.join(Arr.map(refused, claimText), "; ")}. */`,
				...linesOf(c.spec, i, (at) =>
					Arr.flatMap(refused, (r) =>
						r.at !== at
							? []
							: r.claim.kind === "refusal"
								? [`// @ts-expect-error -- refusal: ${r.claim.refusal}`]
								: [`// @ts-expect-error -- refused: ${r.claim.reason}`]
					)
				),
				""
			]
		}
		case "admitted":
			return [
				`/** The engine proves the child ${c.verdict.admitted.proved}${
					c.verdict.admitted.nested === undefined
						? ""
						: `, and the nested child ${c.verdict.admitted.nested}`
				}. */`,
				...linesOf(c.spec, i, () => []),
				`export type h${i} = Expect<Equals<HeadOf<typeof a${i}>, ${c.verdict.admitted.head}>>`,
				`export type m${i} = Expect<Equals<ImmediateHeadOf<typeof a${i}>, ${c.verdict.admitted.immediate}>>`,
				`export const b${i} = (changes: ChangeSet<typeof ${schemaName(c.spec.parent.rel)}, unknown, "Task">) => changes.read("rows", () => a${i})`,
				`export type r${i} = Expect<Equals<ReadsOf<ReturnType<typeof b${i}>>["rows"], ReadonlyArray<${c.verdict.admitted.immediate}>>>`,
				""
			]
	}
}

/** The attachment program over the run's cases, its imports the names its blocks read. */
export const attachModule = (entries: PreludeAt, seed: number): string => {
	const blocks = Arr.flatMap(attachCases(seed), attachBlock)
	const read = identifiers(Arr.join(blocks, "\n"))
	const relationsRead = Arr.filter(children, (rel) => read.has(rel))
	const body = Arr.join(
		[
			...(Arr.isReadonlyArrayNonEmpty(relationsRead)
				? [
						"/** The relations of Deliver the cases match. */",
						`const { ${Arr.join(relationsRead, ", ")} } = Deliver.relations`
					]
				: []),
			...(read.has("anyHandle")
				? [
						"/** An arm's handle spelled through a string, which the types refuse. */",
						"declare const anyHandle: string"
					]
				: []),
			...(read.has("Expect")
				? [
						"type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
						"type Expect<T extends true> = T"
					]
				: []),
			"",
			...blocks
		],
		"\n"
	)
	return preludeProgram(
		"// Generated by test/support/agreement/attachments.ts: the attachment agreement program.",
		entries,
		body
	)
}
