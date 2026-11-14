import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import { CompileError, type UnheldWhy } from "#compiler/core/errors.ts"
import type { ParamId, StoredRelationName } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { compareStrings, mapInput } from "#compiler/core/order.ts"
import type {
	BindingsDesc,
	ExprDesc,
	HeadTermDesc,
	QueryDesc,
	QueryStageDesc,
	RuleDesc,
	SourceDesc
} from "#compiler/ir/desc.ts"
import type { LawField } from "#compiler/ir/law.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { WriteFrontend } from "#compiler/write/frontend/compile.ts"
import { familyNodeRelations } from "#compiler/write/frontend/schedule.ts"
import type { RelationInput } from "#compiler/write/insert/input.ts"

/** The stored relations reading `relation` in `world` reads: in a role's program, a world relation's definition's (its
 * view's), a relation it holds whole itself; in reality's, the relation itself, a derived relation's view changing
 * only at its refresh. */
export const storedReads = (
	world: CheckedSchema["world"],
	relation: string
): ReadonlyArray<string> => {
	if (world.kind === "reality") {
		return [relation]
	}
	const held = world.role.relations[relation]
	return held === undefined || held.kind === "whole" ? [relation] : held.reads
}

/**
 * A retirable unit as a write holds it (schema/own.ts, the retirable statement): its header, its key's fields in key
 * order, which type the hold function's arrays (physical/ddl/retire.ts), its retirement field, and each body relation
 * with its group, in the key's order.
 */
export interface WriteUnit {
	readonly header: StoredRelationName
	readonly key: NonEmptyReadonlyArray<LawField>
	readonly lifecycle: string
	readonly bodies: ReadonlyMap<string, NonEmptyReadonlyArray<GroupField>>
}

/** A field of a body that names one field of its header's key, `key`; or of the header, that key field itself. */
export interface GroupField {
	readonly field: string
	readonly key: LawField
}

/**
 * Where a hold reads groups a call states, by key field in key order: the rows of a member slot of a body, at its
 * group's fields; or one row of the call's scalar parameters.
 */
export type StatedGroups =
	| {
			readonly kind: "slot"
			readonly input: RelationInput
			readonly group: NonEmptyReadonlyArray<GroupField>
	  }
	| { readonly kind: "params"; readonly params: NonEmptyReadonlyArray<StatedParam> }

/** A scalar parameter that states a key field of a group: the key field, the parameter's id and its declared type. */
export interface StatedParam {
	readonly key: LawField
	readonly id: ParamId
	readonly type: ScalarType
}

/**
 * A unit a write holds: the unit, the relations of it the write touches, each body it reads or writes and the header
 * where it reads its retirement field, and every source of the groups it states, each once.
 */
export interface HeldUnit {
	readonly unit: WriteUnit
	readonly observed: ReadonlySet<string>
	readonly stated: NonEmptyReadonlyArray<StatedGroups>
}

/**
 * What a relation of a unit is, by its name: its header, or a body; with the group a match of it binds where it touches
 * the unit, a body's group or, for the header's retirement field, its key.
 */
type UnitPlace = {
	readonly kind: "header" | "body"
	readonly relation: string
	readonly unit: WriteUnit
	readonly group: NonEmptyReadonlyArray<GroupField>
}

/** A side's terms as field names, each a field term: ownership admits a retirable statement's sides so. */
const sideFields = (
	side: {
		readonly terms: NonEmptyReadonlyArray<{ readonly kind: string; readonly field: string }>
	},
	what: string
): NonEmptyReadonlyArray<string> =>
	mapNonEmpty(side.terms, (t) => {
		if (t.kind !== "field") {
			throw defect(`${what}'s side reads fields alone`)
		}
		return t.field
	})

/**
 * Every unit the write's schema declares whose relations its law model holds, each relation of one by its name: a
 * model that holds a body holds its header, which the body's fence reads.
 */
const unitPlaces = (frontend: WriteFrontend): ReadonlyMap<string, UnitPlace> => {
	const places = new Map<string, UnitPlace>()
	for (const s of frontend.schema.owned.statements) {
		if (s.kind !== "retirable") {
			continue
		}
		const header = frontend.laws.relations.get(s.header.relation)?.relation
		if (header === undefined) {
			if (s.bodies.some((body) => frontend.laws.relations.has(body.relation))) {
				throw defect(
					`the law model holds retirable ${s.header.relation}'s header beside its bodies, whose fence reads it`
				)
			}
			continue
		}
		const key = mapNonEmpty(sideFields(s.header, "a retirable header"), (name) => {
			const field = header.fields.find((f) => f.name === name)
			if (field === undefined) {
				throw defect(`${header.name} holds its retirable key field ${name}`)
			}
			return field
		})
		const bodies = new Map(
			s.bodies.map(
				(body) =>
					[
						body.relation,
						mapNonEmpty(sideFields(body, "a retirable body"), (field, at): GroupField => ({
							field,
							key: defined(key[at], "a retirable body's group as wide as its header's key")
						}))
					] as const
			)
		)
		const unit: WriteUnit = { header: header.name, key, lifecycle: s.lifecycle, bodies }
		places.set(header.name, {
			kind: "header",
			relation: header.name,
			unit,
			group: mapNonEmpty(key, (k): GroupField => ({ field: k.name, key: k }))
		})
		for (const [relation, group] of bodies) {
			places.set(relation, { kind: "body", relation, unit, group })
		}
	}
	return places
}

/** A rule's variables each a conjunct of its where equates to a parameter, by name, with that parameter's name. */
const pinnedOf = (rule: RuleDesc): ReadonlyMap<string, string> => {
	const pinned = new Map<string, string>()
	const conjunct = (e: ExprDesc): void => {
		if (e.kind === "and") {
			for (const a of e.args) {
				conjunct(a)
			}
			return
		}
		if (e.kind !== "compare" || e.op !== "eq") {
			return
		}
		if (e.left.kind === "var" && e.right.kind === "param") {
			pinned.set(e.left.var, e.right.name)
		} else if (e.left.kind === "param" && e.right.kind === "var") {
			pinned.set(e.right.var, e.left.name)
		}
	}
	for (const w of rule.where) {
		conjunct(w)
	}
	return pinned
}

/** The parameter `term` names in a rule whose pinned variables are `pinned`: a parameter, or a pinned variable's. */
const paramOfTerm = (
	term: ExprDesc | HeadTermDesc | undefined,
	pinned: ReadonlyMap<string, string>
): string | undefined => {
	if (term === undefined) {
		return undefined
	}
	if (term.kind === "param") {
		return term.name
	}
	return term.kind === "var" ? pinned.get(term.var) : undefined
}

/** The groups a write states and the relations of each unit it touches, gathered as it is walked. */
class Gathered {
	readonly #units = new Map<
		string,
		{
			readonly unit: WriteUnit
			readonly observed: Set<string>
			readonly stated: Array<StatedGroups>
		}
	>()
	readonly #slots = new Set<ParamId>()
	readonly #tuples = new Set<string>()

	#entry(unit: WriteUnit) {
		const known = this.#units.get(unit.header)
		if (known !== undefined) {
			return known
		}
		const stated: Array<StatedGroups> = []
		const fresh = { unit, observed: new Set<string>(), stated }
		this.#units.set(unit.header, fresh)
		return fresh
	}

	/** `relation` of `unit` touched, its groups stated elsewhere. */
	observe(unit: WriteUnit, relation: string): void {
		this.#entry(unit).observed.add(relation)
	}

	/** `relation` of `unit` touched at the groups `stated` states. */
	state(unit: WriteUnit, relation: string, stated: StatedGroups): void {
		const entry = this.#entry(unit)
		entry.observed.add(relation)
		if (stated.kind === "slot") {
			if (this.#slots.has(stated.input.slot)) {
				return
			}
			this.#slots.add(stated.input.slot)
		} else {
			const key = `${unit.header} ${stated.params.map((p) => p.id).join(" ")}`
			if (this.#tuples.has(key)) {
				return
			}
			this.#tuples.add(key)
		}
		entry.stated.push(stated)
	}

	/** Every unit touched, by its header's name, with the groups stated: each touched unit states one at least. */
	held(): ReadonlyArray<HeldUnit> {
		return [...this.#units.values()]
			.toSorted(mapInput(compareStrings, (u: { readonly unit: WriteUnit }) => u.unit.header))
			.map(({ unit, observed, stated }): HeldUnit => {
				if (!isNonEmpty(stated)) {
					throw defect(
						`a group stated for every relation of retirable ${unit.header} the write touches: a family statement's rows are its slots'`
					)
				}
				return { unit, observed, stated }
			})
	}
}

/**
 * The retirable units a write touches and the groups it states of each (HeldUnit), which its hold locks before the
 * first statement that touches the unit (write/schedule/plan.ts placeHolds); or the UnheldGroup of a touch at a group
 * it does not state.
 *
 * A write touches a unit where a statement of it reads or writes a body, or reads the header's retirement field, its
 * group's state; a header's other fields never change, so reading them or inserting a header touches nothing. It
 * states the groups that:
 *
 * - a member slot of a body states, every slot of it, an insertion's, a put's, a deletion's, a family edit's and a
 *   nested write's: its facts' group fields, which every key of a body holds (schema/own.ts checkUnits), so each
 *   statement over the slot reads and writes rows of those groups alone; one whose facts leave a group field for its
 *   sequence to draw states none (`drawn`), nor does a slot stated in a query entry's words (`entry`), and the rows a
 *   nested write nests under an owner outside the unit state none (`nested`);
 * - a rule that matches a body, of a query member or a read-back, at every nesting, binds by its group fields: each
 *   bound in the match to a parameter, or to a variable a conjunct of the rule's where equates to one, which is one
 *   group, the parameters' (`unbound` otherwise); so does a match of the header that binds its retirement field, by the
 *   header's key; a body or a retirement field read through a role's query entry, an imported query or a live derived
 *   relation's definition states none (`derived`), and a materialized derived relation's rows change only at its
 *   refresh, so reading it touches nothing;
 * - a query member that writes a body states the group its head binds to parameters the same way (`written`
 *   otherwise);
 * - a family statement over a body reads and writes rows under the owners its stratum's slots name, of the groups they
 *   state, where every family the body is a member of is owned by a body of its unit (`family` otherwise); a query
 *   entry's filter reads at the row it checks, and so states nothing of a body it reads (`filter`).
 *
 * A delta of a body is the call's own rows, and reads nothing stored.
 */
export const heldUnits = (frontend: WriteFrontend): ReadonlyArray<HeldUnit> => {
	const places = unitPlaces(frontend)
	if (places.size === 0) {
		return []
	}
	const gathered = new Gathered()
	const changeSet = SourceLoc("ChangeSet", [])
	const refuse = (at: SourceLoc, place: UnitPlace, why: UnheldWhy): never => {
		throw new Refusal(
			CompileError.make({
				_tag: "UnheldGroup",
				at,
				relation: place.relation,
				header: place.unit.header,
				why
			})
		)
	}
	const world = frontend.schema.world
	/** The declared parameter `name` as it states `key`, a scalar one: a group is one value of each key field. */
	const paramOf = (key: LawField, name: string | undefined): StatedParam | undefined => {
		const decl = name === undefined ? undefined : frontend.params.find((p) => p.name === name)
		return decl === undefined || decl.kind === "relation"
			? undefined
			: { key, id: decl.id, type: decl.type }
	}
	/** The relation of a unit a match of `s` with `bindings` reads: a body, or a header whose retirement field it binds. */
	const touchOf = (s: SourceDesc, bindings: BindingsDesc): UnitPlace | undefined => {
		if (s.kind !== "relation") {
			return undefined
		}
		const place = places.get(s.name)
		return place?.kind === "body" ||
			(place?.kind === "header" && Object.hasOwn(bindings, place.unit.lifecycle))
			? place
			: undefined
	}
	/**
	 * The first relation of a unit `query` touches, a definition no parameter of the ChangeSet binds: a body it
	 * matches, or a header whose retirement field it binds, through its imports.
	 */
	const definitionTouch = (query: QueryDesc): UnitPlace | undefined => {
		const touches: Array<UnitPlace> = []
		const source = (s: SourceDesc, bindings: BindingsDesc): void => {
			if (s.kind === "query") {
				walk(s.query)
				return
			}
			const touch = touchOf(s, bindings)
			if (touch !== undefined) {
				touches.push(touch)
			}
		}
		const walk = (q: QueryDesc): void => {
			stageRules(q.stage, (r) => {
				for (const m of r.matches) {
					source(m.source, m.bindings)
				}
				for (const e of [...r.where, ...Object.values(r.head)]) {
					absents(e, source)
				}
			})
		}
		walk(query)
		return touches[0]
	}
	/** The base relation the ChangeSet's world reads as `name`, or the touch of the query entry it reads through. */
	const resolved = (
		name: string
	):
		| { readonly kind: "base"; readonly relation: string }
		| { readonly kind: "through"; readonly touch: UnitPlace | undefined } => {
		if (world.kind !== "role") {
			return { kind: "base", relation: name }
		}
		const entry = world.role.relations[name]
		if (entry === undefined) {
			return { kind: "through", touch: undefined }
		}
		return entry.kind === "whole"
			? { kind: "base", relation: entry.relation.name }
			: { kind: "through", touch: definitionTouch(entry.query) }
	}
	/** A match of `s` with `bindings` in a rule whose pinned variables are `pinned`, read by the member or read-back at
	 * `at`. */
	const matched = (
		at: SourceLoc,
		s: SourceDesc,
		bindings: BindingsDesc,
		pinned: ReadonlyMap<string, string>
	): void => {
		if (s.kind === "query") {
			const touch = definitionTouch(s.query)
			if (touch !== undefined) {
				refuse(at, touch, { kind: "derived", through: "an imported query" })
			}
			return
		}
		if (s.kind !== "relation") {
			return
		}
		const read = resolved(s.name)
		if (read.kind === "through") {
			if (read.touch !== undefined) {
				refuse(at, read.touch, { kind: "derived", through: s.name })
			}
			return
		}
		const place = touchOf({ kind: "relation", name: read.relation }, bindings)
		if (place === undefined) {
			return
		}
		const params = mapNonEmpty(
			place.group,
			(g) =>
				paramOf(g.key, paramOfTerm(bindings[g.field], pinned)) ??
				refuse(at, place, { kind: "unbound", field: g.field })
		)
		gathered.state(place.unit, place.relation, { kind: "params", params })
	}
	/** Every rule of `query`, read by the member or read-back at `at`. */
	const readQuery = (at: SourceLoc, query: QueryDesc): void => {
		stageRules(query.stage, (r) => {
			const pinned = pinnedOf(r)
			for (const m of r.matches) {
				matched(at, m.source, m.bindings, pinned)
			}
			for (const e of [...r.where, ...Object.values(r.head)]) {
				absents(e, (source, bindings) => matched(at, source, bindings, pinned))
			}
		})
	}
	/** The base relation a member names, and the query entry it writes it through, if any; none for a name the
	 * world writes not, which the front end has refused. */
	const writtenBy = (
		name: string
	): { readonly relation: string; readonly entry: string | undefined } | undefined => {
		if (world.kind !== "role") {
			return { relation: name, entry: undefined }
		}
		const w = world.writes.get(name)
		if (w === undefined) {
			return undefined
		}
		return w.kind === "whole"
			? { relation: w.relation.name, entry: undefined }
			: { relation: w.writable.target.name, entry: name }
	}
	for (const stratum of frontend.desc.strata) {
		for (const member of stratum.members) {
			const written = writtenBy(member.relation)
			const place = written === undefined ? undefined : places.get(written.relation)
			if (written?.entry !== undefined && place?.kind === "body") {
				refuse(member.loc, place, { kind: "entry", entry: written.entry })
			}
			if (member.member.kind !== "query") {
				continue
			}
			readQuery(member.loc, member.member.query)
			if (place?.kind !== "body") {
				continue
			}
			for (const tuple of headTuples(member.member.query.stage, place.group)) {
				const params = mapNonEmpty(
					tuple,
					(one) =>
						paramOf(one.group.key, one.param) ??
						refuse(member.loc, place, { kind: "written", field: one.group.field })
				)
				gathered.state(place.unit, place.relation, { kind: "params", params })
			}
		}
	}
	for (const read of frontend.desc.reads) {
		readQuery(childLoc(changeSet, "reads", read.name), read.query)
	}
	/** Where a refusal over a slot of `relation` points: the first member writing it, or the ChangeSet. */
	const memberAt = (relation: string): SourceLoc =>
		frontend.desc.strata
			.flatMap((s) => s.members)
			.find((m) => writtenBy(m.relation)?.relation === relation)?.loc ?? changeSet
	for (const group of frontend.slots) {
		const relation = group.relation.name
		const place = places.get(relation)
		for (const input of group.inputs) {
			if (input.kind === "nested") {
				for (const reached of input.reached.keys()) {
					const inner = places.get(reached)
					if (inner?.kind !== "body") {
						continue
					}
					if (place?.kind !== "body" || place.unit !== inner.unit) {
						refuse(memberAt(relation), inner, { kind: "nested", owner: relation })
					}
					gathered.observe(inner.unit, reached)
				}
			}
			if (place?.kind !== "body") {
				continue
			}
			if (group.facts.stated.kind === "entry") {
				refuse(memberAt(relation), place, { kind: "entry", entry: relation })
			}
			for (const slot of input.kind === "classed"
				? [input.complete, input.generated]
				: [input.slot]) {
				const lacking = place.group.find((g) => !slot.input.stated.some((c) => c.name === g.field))
				if (lacking !== undefined) {
					refuse(memberAt(relation), place, { kind: "drawn", field: lacking.field })
				}
				gathered.state(place.unit, relation, {
					kind: "slot",
					input: slot.input,
					group: place.group
				})
			}
		}
	}
	for (const stratum of frontend.ir.strata) {
		for (const action of stratum.actions) {
			const entry = action.info.entry
			if (entry.kind !== "entry" || entry.entry.filter.kind === "none") {
				continue
			}
			const touch = definitionTouch(entry.entry.filter.query)
			if (touch !== undefined) {
				refuse(memberAt(action.relation), touch, { kind: "filter", entry: entry.entry.entry })
			}
		}
		for (const { node } of stratum.family) {
			for (const relation of familyNodeRelations(node)) {
				const place = places.get(relation)
				if (place?.kind !== "body") {
					continue
				}
				const outside = frontend.laws.families.find(
					(f) => f.member.name === relation && places.get(f.owner.name)?.unit !== place.unit
				)
				if (outside !== undefined) {
					refuse(memberAt(relation), place, {
						kind: "family",
						family: `${outside.id.owner}.${outside.id.count}`
					})
				}
				gathered.observe(place.unit, relation)
			}
		}
	}
	return gathered.held()
}

/**
 * Each rule of a stage, at every arm of its rules, union and recursion, and of each rule's interiors and attachments,
 * given to `rule`, each with its own where.
 */
const stageRules = (stage: QueryStageDesc, rule: (r: RuleDesc) => void): void => {
	const each = (r: RuleDesc): void => {
		rule(r)
		for (const i of r.interiors) {
			for (const arm of i.arms) {
				each(arm)
			}
		}
		for (const a of r.attach) {
			stageRules(a.child.stage, rule)
		}
	}
	switch (stage.kind) {
		case "rules":
			for (const arm of stage.arms) {
				each(arm)
			}
			return
		case "recursive":
			for (const arm of [...stage.recursive.base, ...stage.recursive.rec]) {
				each(arm)
			}
			return
		case "union":
			stageRules(stage.input, rule)
			for (const arm of stage.arms) {
				each(arm)
			}
			return
		case "attach":
			stageRules(stage.input, rule)
			stageRules(stage.attach.child.stage, rule)
			return
		case "named":
		case "order":
		case "take":
		case "approx":
			stageRules(stage.input, rule)
	}
}

/** Each relational negation in `e`, at any depth, given to `source` with its bindings. */
const absents = (
	e: ExprDesc | HeadTermDesc,
	source: (s: SourceDesc, bindings: BindingsDesc) => void
): void => {
	const walk = (x: ExprDesc | HeadTermDesc): void => {
		switch (x.kind) {
			case "absent":
				source(x.source, x.bindings)
				for (const b of Object.values(x.bindings)) {
					walk(b)
				}
				return
			case "aggregate":
				if (x.fn !== "count") {
					walk(x.arg)
				}
				return
			case "producer":
				for (const a of x.args) {
					walk(a)
				}
				return
			case "compute":
			case "and":
			case "or":
			case "closedAt":
			case "closedRow":
			case "closedHas":
				for (const a of x.args) {
					walk(a)
				}
				return
			case "cast":
			case "base":
			case "not":
			case "in":
				walk(x.arg)
				return
			case "cond":
				walk(x.pred)
				walk(x.onTrue)
				walk(x.onFalse)
				return
			case "when":
				walk(x.subject)
				walk(x.proved)
				walk(x.otherwise)
				return
			case "compare":
			case "allen":
				walk(x.left)
				walk(x.right)
				return
			case "between":
				walk(x.arg)
				walk(x.low)
				walk(x.high)
				return
			case "pointIn":
				walk(x.point)
				walk(x.span)
				return
			case "param":
			case "var":
			case "field":
			case "value":
			case "parent":
			case "literal":
				return
		}
	}
	walk(e)
}

/**
 * The group each row a query's stage delivers is written at, one tuple per arm: per group field of the body it writes,
 * in order, the parameter the arm's head binds it to, a parameter or a variable its where pins to one; none where no
 * parameter names it. An arm of a recursion or a union delivers rows as any arm does; an order, a take, an approximation
 * and a name keep only rows of their input's arms.
 */
const headTuples = (
	stage: QueryStageDesc,
	group: NonEmptyReadonlyArray<GroupField>
): ReadonlyArray<
	NonEmptyReadonlyArray<{ readonly group: GroupField; readonly param: string | undefined }>
> => {
	const arm = (r: RuleDesc) => {
		const pinned = pinnedOf(r)
		return mapNonEmpty(group, (g) => ({ group: g, param: paramOfTerm(r.head[g.field], pinned) }))
	}
	switch (stage.kind) {
		case "rules":
			return stage.arms.map(arm)
		case "recursive":
			return [...stage.recursive.base, ...stage.recursive.rec].map(arm)
		case "union":
			return [...headTuples(stage.input, group), ...stage.arms.map(arm)]
		case "attach":
		case "named":
		case "order":
		case "take":
		case "approx":
			return headTuples(stage.input, group)
	}
}
