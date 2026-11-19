/** What the properties of hold.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { UnheldWhy } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { noClock } from "#compiler/ir/clock.ts"
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
import { defined, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
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

export const drawnGen: Gen<Drawn> = (source) => {
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
export const whyField = (why: UnheldWhy): string | undefined => {
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
export const isBody = (relation: string): relation is "Step" | "Claim" =>
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

export const modelOf = (d: Drawn): Model => {
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
		...installOptions(owned),
		levels: [identity.schema(parsedSchemaName(schemaName))]
	})
).names

const artifacts = succeeded(testArtifacts(Units, testCompile))

/** The drawn ChangeSet compiled over the units' checked schema, at read committed. */
export const compiledOf = (d: Drawn) =>
	compileWrite(checking(Units), descOf(changeOf(d)), {
		names,
		reads: names,
		claims: { kind: "every" },
		world: { kind: "reality" },
		laws: artifacts.laws,
		derived: artifacts.derived,
		level: "readCommitted",
		clock: noClock
	})

/** Every object a statement names, schema and name, as its text prints them. */
export const objectsOf = (statement: ArtifactStatement): ReadonlyArray<string> => {
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

export const tableOf = (relation: string): string => {
	const table = names.relation(relation)
	return `${table.schema}.${table.name}`
}

export type HoldFeature =
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
