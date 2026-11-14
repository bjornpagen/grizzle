/**
 * A write over a retirable unit holds every group it touches before it touches it (write/hold/stated.ts heldUnits,
 * write/schedule/plan.ts placeHolds, write/hold/statement.ts buildHold): a ChangeSet that reads or writes a body, or
 * reads the header's retirement field, at a group it does not state is refused when it compiles (UnheldGroup); one that
 * states every group it touches calls the unit's hold once, before every statement that names a body's table, with
 * every member slot of a body and every parameter that states a group.
 *
 * The box, constructed: a unit of Root (its retirement field `retired`), Step and Claim, both grouped by `root`, Claim
 * contained in Step; Other and Seen beside it. One stratum of one to three members drawn from: Root inserted from an
 * array; Step or Claim inserted, put or deleted from an array; Step inserted from a query over Other whose head binds
 * `root` to the parameter `g`, to a variable a conjunct pins to `g`, or to Other's id; Other inserted from a query that
 * matches Step with `root` bound to `g`, pinned to `g`, joined to Other's id, or left out; Seen inserted from a query that
 * matches Root binding its retirement field, at `g` or at Other's id, or not binding it; and a read-back of Step at `g`,
 * of Step joined to Other, of Step's added delta (where at most one member writes Step: a delta two statements make is
 * no read-back's, ReadBackCrossesStatements), or none.
 *
 * Oracle: the rule restated over the drawing. Each member and read-back touches the unit or not, and states the groups
 * it touches or not: an array of a body states them; a query states them where `root`, Root's `id` for its retirement
 * field, is bound to `g` or pinned to it; a delta reads nothing stored; Root and Other written touch nothing. The
 * ChangeSet is refused exactly where some touch is unstated, naming one of them (its relation and why); otherwise it
 * holds exactly where something touches the unit, in one statement whose placeholders are each body array's member slot
 * and `g` where a parameter states a group, before every statement that names Step's or Claim's table, and no member
 * slot of a body any other statement reads is missing from it. Where it inserts Root, Root's insert precedes the hold,
 * so the group it creates is open when the hold locks it (write/frontend/schedule.ts UnitOrder); but where a member
 * reads Root's retirement field, that read sees the stratum's starting state, so it runs before Root's insert, and the
 * hold, before it, precedes Root's insert too.
 *
 * Features: refused unbound, refused written, refused for a retirement read; held by a body array, by `g`, by a pinned
 * variable, for a retirement read, for a read-back; held after Root's insert; held before Root's insert, for a
 * retirement read; nothing held.
 *
 * Plants: ~/.cache/grizzle-release/RETIRE2/plants: hold-omitted (no hold placed) and hold-after (the hold placed after
 * the first statement that touches the unit); ~/.cache/grizzle-release/TREEORACLE/plants: hold-header-unordered (no
 * edge from a header's insertion to the statements touching its unit) and fence-by-target-column (the fence's law found
 * by a foreign key referencing the retirement field, which a unit of two bodies installs none of).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import type { UnheldWhy } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { pg, retirement } from "#compiler/public/fields.ts"
import { contained, on, relation, retirable, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import type { ObjectName } from "#compiler/sql/ast.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import type { DeltaValue } from "#compiler/write/delta/source.ts"
import type { WriteNames } from "#compiler/write/insert/statement.ts"
import type { ArtifactStatement } from "#compiler/write/program/artifact.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking, owning } from "#test/support/policy.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"

const Root = relation("Root", { id: pg.integer, retired: retirement }, ["id"])
const Step = relation("Step", { root: pg.integer, step: pg.integer }, ["root", "step"])
const Claim = relation("Claim", { root: pg.integer, step: pg.integer, attempt: pg.integer }, [
	"root",
	"step",
	"attempt"
])
const Other = relation("Other", { id: pg.integer, v: pg.integer }, ["id"])
const Seen = relation("Seen", { id: pg.integer, open: pg.boolean }, ["id"])
const schemaName = "hold_units"
const Units = schema(
	schemaName,
	[Root, Step, Claim, Other, Seen],
	[
		retirable(Root, [on(Step, "root"), on(Claim, "root")]),
		contained(on(Claim, "root", "step"), on(Step, "root", "step"))
	]
)

/** How a query binds a group field: to `g`, to a variable a conjunct pins to `g`, to Other's id, or not at all. */
type Bind = "param" | "pinned" | "joined" | "unbound"

/** One member of the drawn stratum. */
type Member =
	| { readonly kind: "header" }
	| {
			readonly kind: "body"
			readonly relation: "Step" | "Claim"
			readonly op: "insert" | "put" | "delete"
	  }
	| { readonly kind: "written"; readonly bind: Exclude<Bind, "unbound"> }
	| { readonly kind: "read"; readonly bind: Bind }
	| { readonly kind: "retirement"; readonly bind: "param" | "joined" | "none" }

/** The read-back: Step at `g`, Step joined to Other, Step's added delta, or none. */
type ReadBack = "param" | "joined" | "delta" | "none"

interface Drawn {
	readonly members: Arr.NonEmptyReadonlyArray<Member>
	readonly readBack: ReadBack
}

const memberGen: Gen<Member> = (source) => {
	const kind = source.draw(element(["header", "body", "written", "read", "retirement"] as const))
	switch (kind) {
		case "header":
			return { kind }
		case "body":
			return {
				kind,
				relation: source.draw(element(["Step", "Claim"] as const)),
				op: source.draw(element(["insert", "put", "delete"] as const))
			}
		case "written":
			return { kind, bind: source.draw(element(["param", "pinned", "joined"] as const)) }
		case "read":
			return { kind, bind: source.draw(element(["param", "pinned", "joined", "unbound"] as const)) }
		case "retirement":
			return { kind, bind: source.draw(element(["param", "joined", "none"] as const)) }
	}
}

/** Whether a member writes Step: a delta of Step two of a stratum's statements make is no read-back's to read
 * (ReadBackCrossesStatements), so the read-back of Step's added delta is drawn only beside one such member at most. */
const writesStep = (m: Member): boolean =>
	m.kind === "written" || (m.kind === "body" && m.relation === "Step")

const anyReadBack = ["param", "joined", "delta", "none"] as const
const stateReadBack = ["param", "joined", "none"] as const

const drawnGen: Gen<Drawn> = (source) => {
	const [first, ...rest] = source.draw(array(memberGen, { min: 1, max: 3 }))
	const members: Arr.NonEmptyReadonlyArray<Member> = [defined(first, "a member"), ...rest]
	return {
		members,
		readBack: source.draw(
			Arr.filter(members, writesStep).length > 1 ? element(stateReadBack) : element(anyReadBack)
		)
	}
}

/** The variables of `relation` under one scope `name`, a rule's one scope of that name: each field's, by its name. */
const scopeOf = (relation: unknown, name: string) => {
	const vars = varsOver(relation, name)
	return (field: string) => defined(vars[field], `the variable ${name}.${field}`)
}

/** A rule over the units' schema, built through the untyped core since its matches are drawn. */
const ruleOver = (rule: (r: RuleValue) => FinishedValue) => queryOver(Units).rule(rule)

/** Step inserted from Other's rows, its `root` bound as `bind` says. */
const writtenQuery = (bind: Exclude<Bind, "unbound">) =>
	ruleOver((r) => {
		const other = scopeOf(Other, "other")
		const id = other("id")
		const value = other("v")
		const matched = r.match(Other, { id, v: value })
		switch (bind) {
			case "param":
				return matched.find({ root: r.param("g", pg.integer), step: value })
			case "pinned":
				return matched.where(r.eq(id, r.param("g", pg.integer))).find({ root: id, step: value })
			case "joined":
				return matched.find({ root: id, step: value })
		}
	})

/** Other inserted from Step's rows, Step's `root` bound as `bind` says. */
const readQuery = (bind: Bind) =>
	ruleOver((r) => {
		const stepOf = scopeOf(Step, "step")
		const root = stepOf("root")
		const step = stepOf("step")
		switch (bind) {
			case "param":
				return r.match(Step, { root: r.param("g", pg.integer), step }).find({ id: step, v: step })
			case "pinned":
				return r
					.match(Step, { root, step })
					.where(r.eq(root, r.param("g", pg.integer)))
					.find({ id: step, v: step })
			case "joined": {
				const id = scopeOf(Other, "other")("id")
				return r
					.match(Other, { id, v: step })
					.match(Step, { root: id, step })
					.find({ id: step, v: id })
			}
			case "unbound":
				return r.match(Step, { step }).find({ id: step, v: step })
		}
	})

/** Seen inserted from Root's rows, its retirement field bound or not, its key as `bind` says. */
const retirementQuery = (bind: "param" | "joined" | "none") =>
	ruleOver((r) => {
		const rootOf = scopeOf(Root, "root")
		const id = rootOf("id")
		const retired = rootOf("retired")
		switch (bind) {
			case "param":
				return r
					.match(Root, { id: r.param("g", pg.integer), retired })
					.find({ id: r.param("g", pg.integer), open: retired })
			case "joined": {
				const value = scopeOf(Other, "other")("v")
				return r
					.match(Other, { id, v: value })
					.match(Root, { id, retired })
					.find({ id, open: retired })
			}
			case "none":
				return r.match(Root, { id }).find({ id, open: r.param("open", pg.boolean) })
		}
	})

/** The read-back of `drawn`, none where it draws none. */
const readBackQuery = (readBack: Exclude<ReadBack, "none">) => (d: DeltaValue) =>
	ruleOver((r) => {
		const stepOf = scopeOf(Step, "step")
		const root = stepOf("root")
		const step = stepOf("step")
		switch (readBack) {
			case "param":
				return r.match(Step, { root: r.param("g", pg.integer), step }).find({ step })
			case "joined": {
				const id = scopeOf(Other, "other")("id")
				return r.match(Other, { id, v: step }).match(Step, { root: id, step }).find({ step })
			}
			case "delta":
				return r.match(d.added(Step), { root, step }).find({ step })
		}
	})

const relationOf = (name: "Step" | "Claim") => (name === "Step" ? Step : Claim)

/** The drawn ChangeSet, built through the untyped core since its members are drawn. */
const changeOf = (d: Drawn): ChangeSetValue => {
	const written = Arr.reduce(d.members, ChangeSet.empty(Units), (cs, m): ChangeSetValue => {
		switch (m.kind) {
			case "header":
				return cs.insert(Root, [])
			case "body":
				return cs[m.op](relationOf(m.relation), [])
			case "written":
				return cs.insert(Step, writtenQuery(m.bind))
			case "read":
				return cs.insert(Other, readQuery(m.bind))
			case "retirement":
				return cs.insert(Seen, retirementQuery(m.bind))
		}
	})
	return d.readBack === "none" ? written : written.read("r", readBackQuery(d.readBack))
}

/** The field an UnheldGroup's reason names, none for one that names no field. */
const whyField = (why: UnheldWhy): string | undefined => {
	switch (why.kind) {
		case "unbound":
		case "written":
		case "drawn":
			return why.field
		case "derived":
		case "entry":
		case "filter":
		case "family":
		case "nested":
			return undefined
	}
}

/** A body of the unit, by its declared name. */
const isBody = (relation: string): relation is "Step" | "Claim" =>
	relation === "Step" || relation === "Claim"

/** A touch of the unit the rule refuses: its relation, why and the field it names. */
interface Unstated {
	readonly relation: "Step" | "Root"
	readonly why: UnheldWhy["kind"]
	readonly field: string
}

/** The model of a drawing: the touches it does not state, and what states the ones it does. */
interface Model {
	readonly unstated: ReadonlyArray<Unstated>
	readonly touches: boolean
	readonly byParam: boolean
	readonly slots: ReadonlySet<"Step" | "Claim">
	readonly header: HeaderPlace
}

/**
 * Where Root's insert stands against the hold: none inserted; before the hold; or after it, where a member reads Root's
 * retirement field, a read of the stratum's starting state that runs before Root's insert and after the hold.
 */
type HeaderPlace = "none" | "beforeHold" | "afterHold"

const modelOf = (d: Drawn): Model => {
	const unstated: Array<Unstated> = []
	let touches = false
	let byParam = false
	const slots = new Set<"Step" | "Claim">()
	const bound = (bind: Bind, relation: "Step" | "Root", field: string, why: UnheldWhy["kind"]) => {
		touches = true
		if (bind === "param" || bind === "pinned") {
			byParam = true
		} else {
			unstated.push({ relation, why, field })
		}
	}
	for (const m of d.members) {
		switch (m.kind) {
			case "header":
				break
			case "body":
				touches = true
				slots.add(m.relation)
				break
			case "written":
				bound(m.bind, "Step", "root", "written")
				break
			case "read":
				bound(m.bind, "Step", "root", "unbound")
				break
			case "retirement":
				if (m.bind !== "none") {
					bound(m.bind, "Root", "id", "unbound")
				}
				break
		}
	}
	if (d.readBack === "param" || d.readBack === "joined") {
		bound(d.readBack, "Step", "root", "unbound")
	}
	return {
		unstated,
		touches,
		byParam,
		slots,
		header: !Arr.some(d.members, (m) => m.kind === "header")
			? "none"
			: Arr.some(d.members, (m) => m.kind === "retirement" && m.bind !== "none")
				? "afterHold"
				: "beforeHold"
	}
}

const owned = owning(Units)
const names: WriteNames = succeeded(
	compileInstallation(owned, {
		...installOptions(owned, "owner"),
		levels: [identity.schema(parsedSchemaName(schemaName))]
	})
).names
const artifacts = succeeded(testArtifacts(Units, testCompile))

const compiled = (d: Drawn) =>
	compileWrite(checking(Units), descOf(changeOf(d)), {
		names,
		reads: names,
		claims: { kind: "every" },
		world: { kind: "reality" },
		laws: artifacts.laws,
		derived: artifacts.derived,
		level: "readCommitted"
	})

/** Every object a statement names, schema and name, as its text prints them. */
const objectsOf = (statement: ArtifactStatement): ReadonlyArray<string> => {
	const named: Array<string> = []
	transformStatement(statement.ast, {
		...identityHooks,
		objectName: (name: ObjectName) => {
			named.push(`${name.schema}.${name.name}`)
			return name
		}
	})
	return named
}

const tableOf = (relation: string): string => {
	const table = names.relation(relation)
	return `${table.schema}.${table.name}`
}

type HoldFeature =
	| "refused: unbound"
	| "refused: written"
	| "refused: a retirement read"
	| "held by a body array"
	| "held by g"
	| "held by a pinned variable"
	| "held for a retirement read"
	| "held for a read-back"
	| "held after Root's insert"
	| "held before Root's insert, for a retirement read"
	| "nothing held"

describe("a write over a retirable unit", () => {
	it.effect(
		"is refused at a group it does not state, and otherwise holds every group it touches before it touches it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/hold",
						draw: drawn(drawnGen),
						literal: Formatter.format,
						coverage: required<HoldFeature>(
							[
								"refused: unbound",
								"refused: written",
								"refused: a retirement read",
								"held by a body array",
								"held by g",
								"held by a pinned variable",
								"held for a retirement read",
								"held for a read-back",
								"held after Root's insert",
								"held before Root's insert, for a retirement read",
								"nothing held"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: { kind: "specification", name: "the hold rule restated over the drawing" }
					},
					(d, c) =>
						Effect.sync(() => {
							const model = modelOf(d)
							const program = compiled(d)
							if (Arr.isReadonlyArrayNonEmpty(model.unstated)) {
								if (program.ok) {
									return assert.fail(
										`compiled, as the model holds an unstated touch: ${Formatter.format(model.unstated)}`
									)
								}
								const reason = program.error.reason
								if (reason._tag !== "UnheldGroup") {
									return assert.fail(`refused as ${reason._tag}, not UnheldGroup`)
								}
								assert.equal(reason.header, "Root")
								const why = reason.why
								const field = whyField(why)
								assert.ok(
									Arr.some(
										model.unstated,
										(u) => u.relation === reason.relation && u.why === why.kind && u.field === field
									),
									`${reason.relation} ${why.kind} ${String(field)} is one of ${Formatter.format(model.unstated)}`
								)
								c.note(
									reason.relation === "Root"
										? "refused: a retirement read"
										: why.kind === "written"
											? "refused: written"
											: "refused: unbound"
								)
								return
							}
							const artifact = succeeded(program, "the ChangeSet compiles").artifact
							const statements = artifact.statements
							const holds = Arr.filter(statements, (s) => s.step.kind === "hold")
							if (!model.touches) {
								assert.deepEqual(holds, [], "nothing touches the unit, so nothing holds it")
								c.note("nothing held")
								return
							}
							assert.equal(holds.length, 1, "one hold of the unit")
							const hold = defined(holds[0], "the hold")
							assert.ok(
								hold.step.kind === "hold" && hold.step.header === "Root",
								"the hold of Root's unit"
							)
							const bodies = [tableOf("Step"), tableOf("Claim")]
							const touching = Arr.filter(statements, (s) =>
								Arr.some(objectsOf(s), (o) => bodies.includes(o))
							)
							for (const s of touching) {
								assert.ok(
									hold.index < s.index,
									`the hold at ${hold.index} precedes statement ${s.index}, which names a body's table`
								)
							}
							if (model.header !== "none") {
								const root = tableOf("Root")
								const inserted = Arr.filter(
									statements,
									(s) => s.step.kind === "write" && s.step.relation === "Root"
								)
								assert.ok(Arr.isReadonlyArrayNonEmpty(inserted), `Root's insert (${root})`)
								for (const s of inserted) {
									assert.equal(
										s.index < hold.index,
										model.header === "beforeHold",
										`Root's insert at ${s.index} ${model.header === "beforeHold" ? "precedes" : "follows"} the hold at ${hold.index} (${root})`
									)
								}
								c.note(
									model.header === "beforeHold"
										? "held after Root's insert"
										: "held before Root's insert, for a retirement read"
								)
							}
							const slots = hold.spec.paramSlots
							const params = Arr.dedupe(
								Arr.flatMap(slots, (s): ReadonlyArray<string> =>
									s.kind === "scalar" ? [s.param] : []
								)
							)
							assert.deepEqual(params, model.byParam ? ["g"] : [], "the parameters stating a group")
							const members = new Set(
								Arr.flatMap(slots, (s) => (s.kind === "member" ? [s.slot] : []))
							)
							assert.deepEqual(
								Arr.sort(
									Arr.dedupe(
										Arr.flatMap(slots, (s): ReadonlyArray<string> =>
											s.kind === "member" ? [s.relation] : []
										)
									),
									Order.String
								),
								Arr.sort([...model.slots], Order.String),
								"the body arrays stating a group"
							)
							for (const s of statements) {
								for (const slot of s.spec.paramSlots) {
									if (slot.kind === "member" && isBody(slot.relation)) {
										assert.ok(
											members.has(slot.slot),
											`statement ${s.index} reads ${slot.relation}'s slot ${slot.slot}, which the hold reads`
										)
									}
								}
							}
							if (model.slots.size > 0) {
								c.note("held by a body array")
							}
							if (
								Arr.some(
									d.members,
									(m) => (m.kind === "read" || m.kind === "written") && m.bind === "pinned"
								)
							) {
								c.note("held by a pinned variable")
							}
							if (model.byParam) {
								c.note("held by g")
							}
							if (Arr.some(d.members, (m) => m.kind === "retirement" && m.bind === "param")) {
								c.note("held for a retirement read")
							}
							if (d.readBack === "param") {
								c.note("held for a read-back")
							}
						})
				)
			)
	)
})
