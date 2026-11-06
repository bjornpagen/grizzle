import { array, element, type Gen, weighted } from "@grizzle/testing/gen"
import { Array as Arr, Option, Record as Rec } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import type { CompileReasonTag } from "#compiler/core/errors.ts"
import type { AuthoredExprDesc, MatchDesc, QueryDesc } from "#test/support/fixtures/ir/desc.ts"
import {
	descriptorOf,
	type DrawnSchema,
	drawnSchemaGen,
	type ColumnKind,
	familyOf,
	columnKinds,
	kindOf,
	relationAt,
	valueOf
} from "#test/unit/check/drawn.ts"
import {
	compute,
	eq,
	imported,
	lt,
	match,
	not,
	orderBy,
	param,
	queryDesc,
	ref,
	relationSource,
	rule,
	take,
	typedLit,
	varsAt
} from "#test/unit/check/dsl.ts"

/**
 * Queries that name parameters at every place a description may, over a drawn schema, and the checker's parameter rule
 * restated as a model: each query's own parameters are the names its rules, its take and its imports' bind maps use,
 * never an imported query's own; a parameter is of the type its declarations share, widened to their common type where
 * they differ only in a numeric typmod or a text refinement, and refused where they are of two families; a take's
 * parameter is declared integer; and a relational negation computed over a parameter its import binds to an outer
 * variable is refused.
 */

/** The names parameters take: few, so uses of one name meet within a query and across an import's scope. */
const paramNames = ["p", "q", "r"] as const
export type ParamName = (typeof paramNames)[number]

/** A use of a parameter: its name and the kind of the descriptor it declares. */
export interface ParamUse {
	readonly name: ParamName
	readonly kind: ColumnKind
}

/** A field a match binds: to the rule's variable of the field, or to a parameter. */
export interface Bound {
	readonly field: string
	readonly to: "var" | ParamUse
}

/**
 * `r.not` over a relation whose field `field`, an integer or a bigint, is bound to 1 plus a parameter of the field's
 * kind: a binding computed over a parameter.
 */
export interface Computed {
	readonly relation: number
	readonly field: string
	readonly use: ParamUse
}

/** `r.not` over a relation whose field is bound to a parameter. */
export interface Negated {
	readonly relation: number
	readonly field: string
	readonly use: ParamUse
}

/** What an import's bind map binds one of the imported query's parameters to. */
export type BindTo =
	| { readonly kind: "var"; readonly field: string }
	| { readonly kind: "param"; readonly use: ParamUse }
	| { readonly kind: "literal" }

/**
 * A query the root imports: one rule over its relation binding fields, each of its own parameters named once, and a
 * computed negation or none; matched or negated by the root, its every parameter bound by the bind map.
 */
export interface Import {
	readonly relation: number
	readonly bound: Arr.NonEmptyReadonlyArray<Bound>
	readonly computed: Computed | "none"
	readonly negated: boolean
	readonly bind: ReadonlyArray<{ readonly name: ParamName; readonly to: BindTo }>
}

/** A match of a relation binding its field `field` to the root's variable of the field `to`. */
export interface Joined {
	readonly relation: number
	readonly field: string
	readonly to: string
}

/** A comparison of a variable the root binds with a parameter. */
export interface Compared {
	readonly field: string
	readonly op: "eq" | "lt"
	readonly use: ParamUse
}

/**
 * The root rule: one match of its relation, comparisons, head parameters beside the variables it delivers, negations,
 * a computed negation, imports, and a take bounded by a parameter, over its order by the first variable it delivers,
 * or none.
 */
export interface ParamCase {
	readonly schema: DrawnSchema
	readonly relation: number
	readonly bound: Arr.NonEmptyReadonlyArray<Bound>
	/** Matches of a relation binding one of its fields to a variable the root's match binds: a join. */
	readonly joined: ReadonlyArray<Joined>
	readonly where: ReadonlyArray<Compared>
	readonly head: ReadonlyArray<ParamUse>
	readonly negated: ReadonlyArray<Negated>
	readonly computed: Computed | "none"
	readonly imports: ReadonlyArray<Import>
	readonly take: ParamName | "none"
}

/** A parameter's type by the model: a kind, or numeric of no typmod. */
export type ParamType = ColumnKind | "hull"

/** The rule a refusal enforces, by the model's own names. */
export type ParamRule =
	| "a variable bound to fields of two families"
	| "declarations of two families"
	| "a bound variable of another family"
	| "a computed negation over an outer variable"

/** What the model makes of a case: its own parameters by name and type, or a refusal for one of the reasons. */
export type ParamVerdict =
	| {
			readonly kind: "admitted"
			readonly params: ReadonlyMap<string, ParamType>
			/** Whether some parameter's declarations differ in a typmod or a refinement, so it widens. */
			readonly widened: boolean
	  }
	| {
			readonly kind: "refused"
			readonly reasons: Arr.NonEmptyReadonlyArray<CompileReasonTag>
			readonly rules: Arr.NonEmptyReadonlyArray<ParamRule>
	  }

/**
 * The type declarations of `kinds` share: their kind where all are one, their common type where they are of one family
 * of several kinds (numeric of no typmod, the wildcard text), none where they are of two families.
 */
const commonType = (kinds: Arr.NonEmptyReadonlyArray<ParamType>): ParamType | undefined => {
	const [first] = kinds
	if (Arr.every(kinds, (k) => k === first)) {
		return first
	}
	const family = (k: ParamType) => (k === "hull" ? "numeric" : familyOf(k))
	if (!Arr.every(kinds, (k) => family(k) === family(first))) {
		return undefined
	}
	switch (family(first)) {
		case "numeric":
			return "hull"
		case "text":
			return "prose"
		case "int4":
		case "int8":
		case "uuid":
		case "kind":
		case "qty":
			return undefined
	}
}

/**
 * The model: a variable two matches bind meets its fields only within one family, its typmods and refinements apart
 * (MalformedDescription); the root's own uses are its bindings', comparisons', head's, negations', computed negation's, its bind
 * maps' parameter terms', and its take's, declared integer; an import binding one of its parameters to a root parameter
 * adds that parameter's uses in the import, at their own declarations, to the root parameter's; one bound to a root
 * variable is refused where the variable's field is of another family than its uses (MalformedDescription), and where
 * a computed negation reads it (UnsupportedOperation).
 */
export const paramVerdict = (c: ParamCase): ParamVerdict => {
	const root = relationAt(c.schema, c.relation)
	const uses: Array<ParamUse> = [
		...Arr.flatMap(c.bound, (b) => (b.to === "var" ? [] : [b.to])),
		...Arr.map(c.where, (w) => w.use),
		...c.head,
		...Arr.map(c.negated, (n) => n.use),
		...(c.computed === "none" ? [] : [c.computed.use]),
		...(c.take === "none" ? [] : [{ name: c.take, kind: "int4" as const }])
	]
	const rules: Array<{ readonly reason: CompileReasonTag; readonly rule: ParamRule }> = []
	for (const j of c.joined) {
		const kind = kindOf(relationAt(c.schema, j.relation), j.field)
		if (familyOf(kind) !== familyOf(kindOf(root, j.to))) {
			rules.push({
				reason: "MalformedDescription",
				rule: "a variable bound to fields of two families"
			})
		}
	}
	for (const im of c.imports) {
		const own = (name: ParamName): ReadonlyArray<ParamUse> => [
			...Arr.flatMap(im.bound, (b) => (b.to !== "var" && b.to.name === name ? [b.to] : [])),
			...(im.computed !== "none" && im.computed.use.name === name ? [im.computed.use] : [])
		]
		for (const b of im.bind) {
			switch (b.to.kind) {
				case "param": {
					const to = b.to.use.name
					appendAll(uses, [b.to.use, ...Arr.map(own(b.name), (u) => ({ name: to, kind: u.kind }))])
					break
				}
				case "var": {
					const varKind = kindOf(root, b.to.field)
					if (Arr.some(own(b.name), (u) => familyOf(u.kind) !== familyOf(varKind))) {
						rules.push({
							reason: "MalformedDescription",
							rule: "a bound variable of another family"
						})
					}
					if (im.computed !== "none" && im.computed.use.name === b.name) {
						rules.push({
							reason: "UnsupportedOperation",
							rule: "a computed negation over an outer variable"
						})
					}
					break
				}
				case "literal":
					break
			}
		}
	}
	const params = new Map<string, ParamType>()
	let widened = false
	for (const name of paramNames) {
		const [first, ...rest] = Arr.filter(uses, (u) => u.name === name)
		if (first === undefined) {
			continue
		}
		widened ||= Arr.some(rest, (u) => u.kind !== first.kind)
		const t = commonType([first.kind, ...Arr.map(rest, (u) => u.kind)])
		if (t === undefined) {
			rules.push({ reason: "MalformedDescription", rule: "declarations of two families" })
		} else {
			params.set(name, t)
		}
	}
	const [refusal, ...more] = rules
	return refusal === undefined
		? { kind: "admitted", params, widened }
		: {
				kind: "refused",
				reasons: [refusal.reason, ...Arr.map(more, (r) => r.reason)],
				rules: [refusal.rule, ...Arr.map(more, (r) => r.rule)]
			}
}

/** A parameter reference declared at its use's kind. */
const paramOf = (use: ParamUse): AuthoredExprDesc => param(use.name, descriptorOf(use.kind))

/** The match of a relation binding `bound`, each variable named by its relation and field. */
const boundMatch = (relation: string, bound: ReadonlyArray<Bound>): MatchDesc =>
	match(
		relationSource(relation),
		Rec.fromEntries(
			Arr.map(bound, (b): readonly [string, AuthoredExprDesc] => [
				b.field,
				b.to === "var" ? ref(relation, b.field) : paramOf(b.to)
			])
		)
	)

const varsOf = (relation: string, bound: ReadonlyArray<Bound>) =>
	varsAt(
		relation,
		Arr.flatMap(bound, (b) => (b.to === "var" ? [b.field] : []))
	)

/** `r.not` over the relation, its integer field bound to 1 plus the parameter, typed at the field's kind. */
const computedNot = (s: DrawnSchema, n: Computed): AuthoredExprDesc => {
	const r = relationAt(s, n.relation)
	return not(relationSource(r.name), {
		[n.field]: compute(
			"add",
			typedLit(valueOf(n.use.kind), descriptorOf(n.use.kind)),
			paramOf(n.use)
		)
	})
}

/** An imported query: one rule over its relation, delivering its bound variables and the bound parameters' fields. */
const importedQuery = (s: DrawnSchema, im: Import): QueryDesc => {
	const r = relationAt(s, im.relation)
	return queryDesc(
		rule({
			vars: varsOf(r.name, im.bound),
			matches: [boundMatch(r.name, im.bound)],
			where: im.computed === "none" ? [] : [computedNot(s, im.computed)],
			head: Rec.fromEntries(
				Arr.flatMap(im.bound, (b) =>
					b.to === "var" ? [[b.field, ref(r.name, b.field)] as const] : []
				)
			),
			interiors: [],
			attach: []
		})
	)
}

/** The case's root query: its rule, ordered by its first delivered variable and bounded where its take is drawn. */
export const paramCaseDesc = (c: ParamCase): QueryDesc => {
	const r = relationAt(c.schema, c.relation)
	const bindOf = (im: Import) =>
		Rec.fromEntries(
			Arr.map(im.bind, (b): readonly [string, AuthoredExprDesc] => {
				switch (b.to.kind) {
					case "var":
						return [b.name, ref(r.name, b.to.field)]
					case "param":
						return [b.name, paramOf(b.to.use)]
					case "literal": {
						const [use] = Arr.flatMap(im.bound, (x) =>
							x.to !== "var" && x.to.name === b.name ? [x.to] : []
						)
						const kind = use?.kind ?? (im.computed === "none" ? "int4" : im.computed.use.kind)
						return [b.name, typedLit(valueOf(kind), descriptorOf(kind))]
					}
				}
			})
		)
	const head: Record<string, AuthoredExprDesc> = Rec.fromEntries(
		Arr.flatMap(c.bound, (b) => (b.to === "var" ? [[b.field, ref(r.name, b.field)] as const] : []))
	)
	for (const [i, use] of c.head.entries()) {
		head[`h${i}`] = paramOf(use)
	}
	const root = queryDesc(
		rule({
			vars: varsOf(r.name, c.bound),
			matches: [
				boundMatch(r.name, c.bound),
				...Arr.map(c.joined, (j) =>
					match(relationSource(relationAt(c.schema, j.relation).name), {
						[j.field]: ref(r.name, j.to)
					})
				),
				...Arr.flatMap(c.imports, (im) =>
					im.negated ? [] : [match(imported(importedQuery(c.schema, im), bindOf(im)), {})]
				)
			],
			where: [
				...Arr.map(c.where, (w) => (w.op === "eq" ? eq : lt)(ref(r.name, w.field), paramOf(w.use))),
				...Arr.map(c.negated, (n) => {
					const negated = relationAt(c.schema, n.relation)
					return not(relationSource(negated.name), { [n.field]: paramOf(n.use) })
				}),
				...(c.computed === "none" ? [] : [computedNot(c.schema, c.computed)]),
				...Arr.flatMap(c.imports, (im) =>
					im.negated ? [not(imported(importedQuery(c.schema, im), bindOf(im)), {})] : []
				)
			],
			head,
			interiors: [],
			attach: []
		})
	)
	const [first] = Arr.flatMap(c.bound, (b) => (b.to === "var" ? [b.field] : []))
	return c.take === "none" || first === undefined
		? root
		: take(orderBy(root, [first, "asc"]), c.take)
}

/** A kind of `kind`'s family: itself mostly, another of its family where it has one. */
const familyKindGen = (kind: ColumnKind): Gen<ColumnKind> => {
	const [first, ...rest] = Arr.filter(columnKinds, (k) => familyOf(k) === familyOf(kind))
	return weighted([
		[2, element([kind])],
		[1, element([first ?? kind, ...rest])]
	])
}

/**
 * The kind each name is planned at, which most of its uses declare a kind of the family of: uses of one name then
 * mostly meet in one family, and sometimes in two.
 */
type ParamPlan = ReadonlyMap<ParamName, ColumnKind>

const planGen: Gen<ParamPlan> = (source) =>
	new Map(Arr.map(paramNames, (name) => [name, source.draw(element(columnKinds))] as const))

/**
 * A use at a kind of `kind`'s family, named mostly by a name planned in that family, where one is, and otherwise by
 * any name.
 */
const useGen =
	(plan: ParamPlan, kind: ColumnKind): Gen<ParamUse> =>
	(source) => {
		const [planned, ...more] = Arr.filter(
			paramNames,
			(n) => familyOf(plan.get(n) ?? kind) === familyOf(kind)
		)
		const name =
			planned === undefined
				? source.draw(element(paramNames))
				: source.draw(
						weighted([
							[4, element([planned, ...more])],
							[1, element(paramNames)]
						])
					)
		return { name, kind: source.draw(familyKindGen(kind)) }
	}

/** A use of any name, at a kind of its planned family mostly and of any family sometimes. */
const freeUseGen =
	(plan: ParamPlan): Gen<ParamUse> =>
	(source) => {
		const name = source.draw(element(paramNames))
		const kind = source.draw(
			weighted([
				[4, element([plan.get(name) ?? "int4"])],
				[1, element(columnKinds)]
			])
		)
		return { name, kind: source.draw(familyKindGen(kind)) }
	}

/** The fields of a relation, each bound to its variable or to a parameter of its family, at least one. */
const boundGen =
	(s: DrawnSchema, plan: ParamPlan, relation: number): Gen<Arr.NonEmptyReadonlyArray<Bound>> =>
	(source) => {
		const r = relationAt(s, relation)
		const one = (field: string): Bound => ({
			field,
			to: source.draw(
				weighted([
					[1, element([true])],
					[2, element([false])]
				])
			)
				? source.draw(useGen(plan, kindOf(r, field)))
				: "var"
		})
		const [first, ...rest] = r.fields
		return [
			one(first.name),
			...Arr.flatMap(rest, (x) => (source.draw(element([true, false])) ? [one(x.name)] : []))
		]
	}

/** The integer fields of the schema, a computed negation's candidates. */
const integerFields = (
	s: DrawnSchema
): ReadonlyArray<{ readonly relation: number; readonly field: string }> =>
	Arr.flatMap(s.relations, (r, relation) =>
		Arr.flatMap(r.fields, (x) =>
			x.kind === "int4" || x.kind === "int8" ? [{ relation, field: x.name }] : []
		)
	)

const computedGen =
	(s: DrawnSchema, plan: ParamPlan): Gen<Computed | "none"> =>
	(source) => {
		const [first, ...rest] = integerFields(s)
		if (first === undefined || source.draw(element([true, false]))) {
			return "none"
		}
		const at = source.draw(element([first, ...rest]))
		const kind = kindOf(relationAt(s, at.relation), at.field)
		return { ...at, use: { name: source.draw(useGen(plan, kind)).name, kind } }
	}

/** An import: its own bindings and computed negation, each own parameter named once, and its bind map. */
const importGen =
	(s: DrawnSchema, plan: ParamPlan, rootVars: ReadonlyArray<string>): Gen<Import> =>
	(source) => {
		const relation = source.draw(element(Arr.map(s.relations, (_, i) => i)))
		const drawnBound = source.draw(boundGen(s, plan, relation))
		const named = new Set<ParamName>()
		const once = (b: Bound): Bound => {
			if (b.to === "var" || named.has(b.to.name)) {
				return b.to === "var" ? b : { field: b.field, to: "var" }
			}
			named.add(b.to.name)
			return b
		}
		const [first, ...rest] = Arr.map(drawnBound, once)
		const drawnComputed = source.draw(computedGen(s, plan))
		const computed =
			drawnComputed !== "none" && named.has(drawnComputed.use.name) ? "none" : drawnComputed
		if (computed !== "none") {
			named.add(computed.use.name)
		}
		const kindOfOwn = (name: ParamName): ColumnKind =>
			Option.getOrElse(
				Arr.findFirst(
					[
						...Arr.flatMap([first, ...rest], (b) => (b.to === "var" ? [] : [b.to])),
						...(computed === "none" ? [] : [computed.use])
					],
					(u) => u.name === name
				).pipe(Option.map((u) => u.kind)),
				() => "int4" as const
			)
		const bindTo =
			(name: ParamName): Gen<BindTo> =>
			(inner) => {
				const [v, ...vs] = rootVars
				return inner.draw(
					weighted<BindTo>([
						[2, (x) => ({ kind: "param", use: x.draw(useGen(plan, kindOfOwn(name))) })],
						[1, () => ({ kind: "literal" })],
						[
							v === undefined ? 1 : 2,
							(x) =>
								v === undefined
									? { kind: "literal" }
									: { kind: "var", field: x.draw(element([v, ...vs])) }
						]
					])
				)
			}
		return {
			relation,
			bound: [first, ...rest],
			computed,
			negated: source.draw(element([false, true])),
			bind: Arr.map([...named], (name) => ({ name, to: source.draw(bindTo(name)) }))
		}
	}

/** A parameter case over a drawn schema of one or two relations. */
export const paramCaseGen: Gen<ParamCase> = (source) => {
	const schema = source.draw(drawnSchemaGen(2, false))
	const plan = source.draw(planGen)
	const relation = source.draw(element(Arr.map(schema.relations, (_, i) => i)))
	const r = relationAt(schema, relation)
	const bound = source.draw(boundGen(schema, plan, relation))
	const rootVars = Arr.flatMap(bound, (b) => (b.to === "var" ? [b.field] : []))
	const [v, ...vs] = rootVars
	const joinedGen: Gen<Joined> = (inner) => {
		const to = inner.draw(element([v ?? "id", ...vs]))
		const at = inner.draw(element(Arr.map(schema.relations, (_, i) => i)))
		const family = familyOf(kindOf(r, to))
		const fields = relationAt(schema, at).fields
		const [same, ...sames] = Arr.filter(fields, (x) => familyOf(x.kind) === family)
		const field = inner.draw(
			same === undefined
				? element(fields)
				: weighted([
						[4, element([same, ...sames])],
						[1, element(fields)]
					])
		).name
		return { relation: at, field, to }
	}
	const negatedGen: Gen<Negated> = (inner) => {
		const at = inner.draw(element(Arr.map(schema.relations, (_, i) => i)))
		const field = inner.draw(element(relationAt(schema, at).fields)).name
		return {
			relation: at,
			field,
			use: inner.draw(useGen(plan, kindOf(relationAt(schema, at), field)))
		}
	}
	return {
		schema,
		relation,
		bound,
		joined: v === undefined ? [] : source.draw(array(joinedGen, { min: 0, max: 1 })),
		where:
			v === undefined
				? []
				: source.draw(
						array(
							(inner) => {
								const field = inner.draw(element([v, ...vs]))
								return {
									field,
									op: inner.draw(element(["eq", "lt"] as const)),
									use: inner.draw(useGen(plan, kindOf(r, field)))
								}
							},
							{ min: 0, max: 2 }
						)
					),
		head: source.draw(array(freeUseGen(plan), { min: 0, max: 2 })),
		negated: source.draw(array(negatedGen, { min: 0, max: 1 })),
		computed: source.draw(computedGen(schema, plan)),
		imports: source.draw(array(importGen(schema, plan, rootVars), { min: 0, max: 2 })),
		take:
			v === undefined
				? "none"
				: source.draw(
						weighted<ParamName | "none">([
							[1, element(paramNames)],
							[3, element(["none"] as const)]
						])
					)
	}
}

/** Where a case names parameters, how its imports bind them, and what the model made of them. */
export type ParamFeature =
	| ParamRule
	| "a parameter a match binds"
	| "a parameter a comparison reads"
	| "a head parameter"
	| "a negated source's parameter"
	| "a computed negation over its own parameter"
	| "a take's parameter"
	| "an import bound to a parameter"
	| "an import bound to a literal"
	| "an import bound to a variable"
	| "a negated import"
	| "one name in two scopes"
	| "a parameter widened"
	| "a variable joined across typmods or refinements"
	| "admitted"

export const paramFeatures = (c: ParamCase, v: ParamVerdict): ReadonlyArray<ParamFeature> => {
	const binds = Arr.flatMap(c.imports, (im) => im.bind)
	const rootNames = new Set<ParamName>([
		...Arr.flatMap(c.bound, (b) => (b.to === "var" ? [] : [b.to.name])),
		...Arr.map(c.where, (w) => w.use.name),
		...Arr.map(c.head, (h) => h.name),
		...Arr.map(c.negated, (n) => n.use.name),
		...(c.computed === "none" ? [] : [c.computed.use.name]),
		...(c.take === "none" ? [] : [c.take]),
		...Arr.flatMap(binds, (b) => (b.to.kind === "param" ? [b.to.use.name] : []))
	])
	const features: Array<ParamFeature> = []
	const when = (holds: boolean, feature: ParamFeature) => {
		if (holds) {
			features.push(feature)
		}
	}
	when(
		Arr.some(c.bound, (b) => b.to !== "var"),
		"a parameter a match binds"
	)
	when(c.where.length > 0, "a parameter a comparison reads")
	when(c.head.length > 0, "a head parameter")
	when(c.negated.length > 0, "a negated source's parameter")
	when(c.computed !== "none", "a computed negation over its own parameter")
	when(c.take !== "none", "a take's parameter")
	when(
		Arr.some(binds, (b) => b.to.kind === "param"),
		"an import bound to a parameter"
	)
	when(
		Arr.some(binds, (b) => b.to.kind === "literal"),
		"an import bound to a literal"
	)
	when(
		Arr.some(binds, (b) => b.to.kind === "var"),
		"an import bound to a variable"
	)
	when(
		Arr.some(c.imports, (im) => im.negated),
		"a negated import"
	)
	when(
		Arr.some(
			binds,
			(b) => rootNames.has(b.name) && (b.to.kind !== "param" || b.to.use.name !== b.name)
		),
		"one name in two scopes"
	)
	switch (v.kind) {
		case "admitted":
			features.push("admitted")
			when(
				Arr.some(
					c.joined,
					(j) =>
						kindOf(relationAt(c.schema, j.relation), j.field) !==
						kindOf(relationAt(c.schema, c.relation), j.to)
				),
				"a variable joined across typmods or refinements"
			)
			when(v.widened, "a parameter widened")
			break
		case "refused":
			appendAll(features, v.rules)
			break
	}
	return features
}
