import { array, boolean, element, type Gen, int, map, span } from "@grizzle/testing/gen"
import type { Source } from "@grizzle/testing/source"
import { keep, type Swarm, swarm, swarmChoice, weightOf } from "@grizzle/testing/swarm"
import { Array as Arr, Option, Record as Rec } from "effect"
import { valueText } from "#test/support/laws/model.ts"
import {
	closedField,
	fieldsOfSource,
	isIntegerDomain,
	knownNonEmpty,
	pooled,
	sameDomain
} from "#test/support/worlds/generate/domain.ts"
import { classifyEntry, literalDefault } from "#test/support/worlds/model/host.ts"
import type {
	BaseSpec,
	ComparisonOp,
	ContextSpec,
	EntrySpec,
	FieldDomain,
	FieldSpec,
	HostValue,
	InstallSpec,
	LoginSpec,
	Occurrence,
	RoleSpec,
	Rule,
	Term
} from "#test/support/worlds/model/types.ts"

/**
 * The forms an installation may take, each a swarm feature: a case turns a random subset on, so features that crowd
 * others out are left out of some installations and the rest combine.
 */
const installFeatures = [
	"whole",
	"query",
	"ordinary-source",
	"closed-source",
	"derived-source",
	"second-rule",
	"head",
	"head-claimed",
	"head-literal",
	"literal",
	"handle-term",
	"claimed",
	"claim-term",
	"free",
	"omitted",
	"alias",
	"compare",
	"exists",
	"absent",
	"absent-second",
	"closed-filter",
	"derived-filter",
	"context-filter",
	"negated-contexts",
	"foreign-head",
	"head-alias",
	"refresh",
	"two-logins",
	"read-beside-write",
	"serial-head"
] as const

type InstallFeature = (typeof installFeatures)[number]

/** Whether a swarm turns a feature on at all. */
const on = (drawn: Swarm<InstallFeature>, feature: InstallFeature): boolean =>
	weightOf(drawn, feature) > 0

/** The pool index a literal or a constant head field takes its value at. */
const poolIndex = int(0, 15)

/** The names roles and logins take, in order: none is a relation's name in any base the worlds suites declare. */
export const roleNames = ["alpha", "beta", "gamma"] as const
const loginNames = ["web", "ops"] as const

const comparisonOps: Arr.NonEmptyReadonlyArray<ComparisonOp> = ["<", "<=", "=", "<>", ">=", ">"]

const bit = (mask: number, i: number): boolean => (mask & (1 << i)) !== 0

/** The items whose positions the mask's bits name. */
const byBits = <A>(items: ReadonlyArray<A>, mask: number): ReadonlyArray<A> =>
	Arr.flatMap(items, (item: A, i: number): ReadonlyArray<A> => (bit(mask, i) ? [item] : []))

const isInteger = isIntegerDomain

/** A context field a field of `domain` may be equated to. */
interface ClaimSite {
	readonly context: ContextSpec
	readonly field: string
}

const claimSites = (base: BaseSpec, domain: FieldDomain): ReadonlyArray<ClaimSite> =>
	Arr.flatMap(base.contexts, (context) =>
		Arr.map(
			Arr.filter(context.fields, (f) => sameDomain(f.domain, domain)),
			(f) => ({ context, field: f.name })
		)
	)

/** A field of another relation-valued source whose domain is a source field's: what `exists`, `absent` and a foreign head read. */
interface Link {
	readonly from: string
	readonly relation: string
	readonly to: string
	/** The linked source's other fields, which a foreign head or a second negated binding may take. */
	readonly others: ReadonlyArray<FieldSpec>
}

const linksOf = (
	base: BaseSpec,
	source: string,
	fields: ReadonlyArray<FieldSpec>,
	targets: ReadonlyArray<string>
): ReadonlyArray<Link> =>
	Arr.flatMap(fields, (f: FieldSpec) =>
		Arr.flatMap(
			Arr.filter(targets, (r: string) => r !== source),
			(relation: string): ReadonlyArray<Link> => {
				const theirs = fieldsOfSource(base, relation)
				const meeting: ReadonlyArray<FieldSpec> = Arr.filter(theirs, (g: FieldSpec) =>
					sameDomain(g.domain, f.domain)
				)
				return Arr.map(meeting, (g: FieldSpec): Link => ({
					from: f.name,
					relation,
					to: g.name,
					others: Arr.filter(theirs, (h) => h.name !== g.name)
				}))
			}
		)
	)

const variable = (name: string): Term => ({ kind: "var", name })
/** The kind of a relation-valued source of the base, by its name: an ordinary relation, a closed roster, a derived one. */
const sourceKind = (base: BaseSpec, name: string): "ordinary" | "closed" | "derived" =>
	Arr.some(base.closed, (c) => c.name === name)
		? "closed"
		: Arr.some(base.derived, (d) => d.name === name)
			? "derived"
			: "ordinary"

const relationOccurrence = (
	base: BaseSpec,
	name: string,
	fields: Readonly<Record<string, Term>>
): Occurrence => ({
	source: { kind: sourceKind(base, name), name },
	fields
})

const contextOccurrence = (name: string, fields: Readonly<Record<string, Term>>): Occurrence => ({
	source: { kind: "context", name },
	fields
})

/** The variable a field of the source binds. */
const own = (field: string): string => `v_${field}`

/** What an entry's every rule shares: the source, its fields, the head fields, and the foreign head's link. */
interface EntryPlan {
	readonly source: string
	readonly fields: ReadonlyArray<FieldSpec>
	readonly head: ReadonlySet<string>
	readonly foreign: { readonly link: Link; readonly field: FieldSpec } | undefined
	readonly ordinary: boolean
}

/** A comparison of an integer or roster field the rule binds with a pool constant, kept when the swarm keeps it. */
type Comparison = Rule["comparisons"][number]

/**
 * One rule over the plan's source: its occurrence first, every field drawn into the head as it binds it, claimed by a
 * context field, as a literal, or (outside the head) fixed to a literal, claimed, free, omitted or aliased to an earlier
 * field of its domain; then the filters the swarm keeps. Every variable a head, a comparison or a negation reads is
 * bound by a positive match, every equated pair shares a domain and every literal is a pool value, so the rule is one
 * the host model's ruleFaults admits. A constant of a roster's field is its typed handle in a head, and in an
 * occurrence or a comparison its JavaScript value or, under `handle-term`, its typed handle, which also stands first.
 */
const resolveRule =
	(base: BaseSpec, plan: EntryPlan, drawn: Swarm<InstallFeature>): Gen<Rule> =>
	(source) => {
		const negated = base.contexts.length > 0 && source.draw(keep(drawn, "negated-contexts"))
		/** A constant met in an occurrence or a comparison: a roster's member as its typed handle under `handle-term`. */
		const constantOf = (at: Source, domain: FieldDomain, value: HostValue): Term =>
			domain.kind === "handle" && at.draw(keep(drawn, "handle-term"))
				? { kind: "handle", closed: domain.closed, member: valueText(value) }
				: { kind: "literal", value }
		const terms = new Map<string, Term>()
		const head: Array<readonly [string, Term]> = []
		const matches: Array<Occurrence> = []
		const negations: Array<Arr.NonEmptyReadonlyArray<Occurrence>> = []
		const claimed = new Set<string>()
		const bindClaim = (site: ClaimSite, term: Term): void => {
			const occurrence = contextOccurrence(site.context.name, { [site.field]: term })
			if (negated) {
				negations.push([occurrence])
			} else {
				matches.push(occurrence)
			}
		}
		const useField = (f: FieldSpec, i: number): void => {
			const sites = plan.ordinary ? claimSites(base, f.domain) : []
			const [site, ...moreSites] = sites
			const claim = site === undefined ? undefined : source.draw(element([site, ...moreSites]))
			if (plan.head.has(f.name)) {
				const value = pooled(f.domain, source.draw(poolIndex))
				/**
				 * A constant head field: a roster's typed handle, its type carried by the value; else a plain literal, which
				 * grizzle types by its JavaScript value, so none of a value that has no default type (a span).
				 */
				const constant: Term | undefined =
					f.domain.kind === "handle"
						? { kind: "handle", closed: f.domain.closed, member: valueText(value) }
						: literalDefault(value) === undefined
							? undefined
							: { kind: "literal", value }
				const use = source.draw(
					swarmChoice<InstallFeature, "head" | "head-claimed" | "head-literal">(drawn, [
						"head",
						...(claim === undefined ? [] : (["head-claimed"] as const)),
						...(constant === undefined ? [] : (["head-literal"] as const))
					])
				)
				terms.set(f.name, variable(own(f.name)))
				if (use === "head-literal" && constant !== undefined) {
					head.push([f.name, constant])
					return
				}
				head.push([f.name, variable(own(f.name))])
				if (use === "head-claimed" && claim !== undefined) {
					bindClaim(claim, variable(own(f.name)))
				}
				return
			}
			const earlier = Arr.filter(
				plan.fields.slice(0, i),
				(g) => sameDomain(g.domain, f.domain) && terms.get(g.name)?.kind === "var"
			)
			const [alias, ...moreAliases] = earlier
			const use = source.draw(
				swarmChoice<InstallFeature, "literal" | "claimed" | "free" | "omitted" | "alias">(drawn, [
					"literal",
					...(claim === undefined ? [] : (["claimed"] as const)),
					"free",
					"omitted",
					...(alias === undefined ? [] : (["alias"] as const))
				])
			)
			switch (use) {
				case "literal":
					terms.set(f.name, constantOf(source, f.domain, pooled(f.domain, source.draw(poolIndex))))
					return
				case "claimed": {
					if (claim === undefined) {
						return
					}
					if (source.draw(keep(drawn, "claim-term"))) {
						terms.set(f.name, { kind: "context", context: claim.context.name, field: claim.field })
						return
					}
					const name = negated ? own(f.name) : `c_${claim.context.name}_${claim.field}`
					terms.set(f.name, variable(name))
					if (negated || !claimed.has(name)) {
						claimed.add(name)
						bindClaim(claim, variable(name))
					}
					return
				}
				case "free":
					terms.set(f.name, variable(own(f.name)))
					return
				case "omitted":
					return
				case "alias": {
					const of = alias === undefined ? undefined : source.draw(element([alias, ...moreAliases]))
					const term = of === undefined ? undefined : terms.get(of.name)
					if (term !== undefined) {
						terms.set(f.name, term)
					}
					return
				}
			}
		}
		for (const [i, f] of plan.fields.entries()) {
			useField(f, i)
		}
		const compared = Arr.filter(
			plan.fields,
			(f) =>
				(isInteger(f.domain) || f.domain.kind === "handle") && terms.get(f.name)?.kind === "var"
		)
		const [firstCompared, ...moreCompared] = compared
		const comparison: Gen<ReadonlyArray<Comparison>> = (inner) => {
			if (firstCompared === undefined || !inner.draw(keep(drawn, "compare"))) {
				return []
			}
			const f = inner.draw(element([firstCompared, ...moreCompared]))
			const bound = terms.get(f.name) ?? variable(own(f.name))
			const constant = constantOf(inner, f.domain, pooled(f.domain, inner.draw(poolIndex)))
			const op = inner.draw(element(comparisonOps))
			return constant.kind === "handle" && inner.draw(boolean)
				? [{ left: constant, op, right: bound }]
				: [{ left: bound, op, right: constant }]
		}
		const comparisons = plan.ordinary
			? Arr.flatten(source.draw(array(comparison, { min: 0, max: 2 })))
			: []
		const ordinaryNames = Arr.map(base.relations, (r) => r.name)
		const termOf = (field: string): Term => {
			const known = terms.get(field)
			if (known !== undefined) {
				return known
			}
			const made = variable(own(field))
			terms.set(field, made)
			return made
		}
		if (plan.foreign !== undefined) {
			const { link, field } = plan.foreign
			const w = `w_${field.name}`
			matches.push(
				relationOccurrence(base, link.relation, {
					[link.to]: termOf(link.from),
					[field.name]: variable(w)
				})
			)
			head.push([`${field.name}_via`, variable(w)])
		}
		const links = plan.ordinary ? linksOf(base, plan.source, plan.fields, ordinaryNames) : []
		const [link, ...moreLinks] = links
		if (link !== undefined && source.draw(keep(drawn, "exists"))) {
			const l = source.draw(element([link, ...moreLinks]))
			matches.push(relationOccurrence(base, l.relation, { [l.to]: termOf(l.from) }))
		}
		if (link !== undefined && source.draw(keep(drawn, "absent"))) {
			const l = source.draw(element([link, ...moreLinks]))
			const fields: Record<string, Term> = { [l.to]: termOf(l.from) }
			const bound = Arr.filter([...terms], ([, t]) => t.kind === "var")
			const seconds = Arr.flatMap(l.others, (h) =>
				Arr.flatMap(bound, ([name, t]) => {
					const field = Arr.findFirst(plan.fields, (f) => f.name === name)
					return Option.isSome(field) && sameDomain(field.value.domain, h.domain)
						? [[h.name, t] as const]
						: []
				})
			)
			const [second, ...moreSeconds] = seconds
			if (second !== undefined && source.draw(keep(drawn, "absent-second"))) {
				const [h, t] = source.draw(element([second, ...moreSeconds]))
				fields[h] = t
			}
			negations.push([relationOccurrence(base, l.relation, fields)])
		}
		const [roster, ...moreRosters] = base.closed
		if (roster !== undefined && source.draw(keep(drawn, "closed-filter"))) {
			const c = source.draw(element([roster, ...moreRosters]))
			matches.push(
				relationOccurrence(base, c.name, {
					[closedField]: { kind: "literal", value: source.draw(element(c.members)) }
				})
			)
		}
		const derivedLinks = plan.ordinary
			? linksOf(
					base,
					plan.source,
					plan.fields,
					Arr.map(base.derived, (d) => d.name)
				)
			: []
		const [derivedLink, ...moreDerived] = derivedLinks
		if (derivedLink !== undefined && source.draw(keep(drawn, "derived-filter"))) {
			const l = source.draw(element([derivedLink, ...moreDerived]))
			matches.push(relationOccurrence(base, l.relation, { [l.to]: termOf(l.from) }))
		}
		const [context, ...moreContexts] = base.contexts
		if (context !== undefined && source.draw(keep(drawn, "context-filter"))) {
			const c = source.draw(element([context, ...moreContexts]))
			if (source.draw(boolean)) {
				negations.push([contextOccurrence(c.name, {})])
			} else {
				matches.push(contextOccurrence(c.name, {}))
			}
		}
		return {
			matches: [relationOccurrence(base, plan.source, Rec.fromEntries(terms)), ...matches],
			negations,
			comparisons,
			head: Rec.fromEntries(head)
		}
	}

/** A query entry over a source the swarm allows: an ordinary relation, a closed roster or a derived relation. */
const resolveEntry =
	(base: BaseSpec, drawn: Swarm<InstallFeature>): Gen<EntrySpec> =>
	(source) => {
		const kind = source.draw(
			swarmChoice<InstallFeature, "ordinary-source" | "closed-source" | "derived-source">(drawn, [
				"ordinary-source",
				...(base.closed.length > 0 ? (["closed-source"] as const) : []),
				...(base.derived.length > 0 ? (["derived-source"] as const) : [])
			])
		)
		const names =
			kind === "closed-source"
				? Arr.map(base.closed, (c) => c.name)
				: kind === "derived-source"
					? Arr.map(base.derived, (d) => d.name)
					: Arr.map(base.relations, (r) => r.name)
		/**
		 * The serial-head arm, over an ordinary relation holding serial fields: a head of exactly its serial fields, every
		 * other field fixed or omitted, so the entry's every carried field is serial and a generated addition through it
		 * carries none, the unit relation.
		 */
		const serialSources = Arr.filter(
			base.relations,
			(r) => kind === "ordinary-source" && Arr.some(r.fields, (f) => f.domain.kind === "serial")
		)
		const serialHead =
			Arr.isReadonlyArrayNonEmpty(serialSources) && source.draw(keep(drawn, "serial-head"))
				? Arr.map(serialSources, (r) => r.name)
				: undefined
		const sourceName = source.draw(
			element(serialHead ?? knownNonEmpty(names, "the sources of a kind"))
		)
		const fields = fieldsOfSource(base, sourceName)
		const ordinary = kind === "ordinary-source"
		const links = ordinary
			? linksOf(
					base,
					sourceName,
					fields,
					Arr.map(base.relations, (r) => r.name)
				)
			: []
		const foreignOptions = Arr.flatMap(links, (link) =>
			Arr.map(link.others, (field) => ({ link, field }))
		)
		const [firstForeign, ...moreForeign] = foreignOptions
		const foreign =
			firstForeign !== undefined && source.draw(keep(drawn, "foreign-head"))
				? source.draw(element([firstForeign, ...moreForeign]))
				: undefined
		const chosen = new Set(
			Arr.map(
				serialHead === undefined
					? byBits(fields, source.draw(int(0, 0xff)))
					: Arr.filter(fields, (f) => f.domain.kind === "serial"),
				(f) => f.name
			)
		)
		const [first] = fields
		if (chosen.size === 0 && foreign === undefined && first !== undefined) {
			chosen.add(first.name)
		}
		const plan: EntryPlan = { source: sourceName, fields, head: chosen, foreign, ordinary }
		const rules: Arr.NonEmptyReadonlyArray<Rule> = source.draw(keep(drawn, "second-rule"))
			? [source.draw(resolveRule(base, plan, drawn)), source.draw(resolveRule(base, plan, drawn))]
			: [source.draw(resolveRule(base, plan, drawn))]
		const aliased = Arr.findFirst(fields, (f) => chosen.has(f.name))
		if (
			Option.isSome(aliased) &&
			source.draw(keep(drawn, "head-alias")) &&
			Arr.every(rules, (r) => r.head[aliased.value.name]?.kind === "var")
		) {
			const name = aliased.value.name
			const again = (r: Rule): Rule => {
				const term = r.head[name]
				return term === undefined ? r : { ...r, head: { ...r.head, [`${name}_again`]: term } }
			}
			const [r0, ...rest] = rules
			return { kind: "query", rules: [again(r0), ...Arr.map(rest, again)] }
		}
		return { kind: "query", rules }
	}

/** Every relation a role may hold whole: the base's ordinary, derived and closed relations. */
const wholeCandidates = (base: BaseSpec): ReadonlyArray<string> => [
	...Arr.map(base.relations, (r) => r.name),
	...Arr.map(base.derived, (d) => d.name),
	...Arr.map(base.closed, (c) => c.name)
]

/** A query entry's name: none is a relation of the base, so a role's whole entries and query entries never meet. */
const queryName = (base: BaseSpec, i: number): string => {
	const taken = new Set(wholeCandidates(base))
	let name = `View${i}`
	while (taken.has(name)) {
		name = `${name}x`
	}
	return name
}

/** A role: its entries, its write list of writable entries at most one per relation, its refresh list. */
const resolveRole =
	(base: BaseSpec, name: string, drawn: Swarm<InstallFeature>): Gen<RoleSpec> =>
	(source) => {
		const wholes = on(drawn, "whole")
			? byBits(wholeCandidates(base), source.draw(int(0, 0xffff)))
			: []
		const queries = on(drawn, "query")
			? Arr.map(
					source.draw(array(resolveEntry(base, drawn), { min: 0, max: 3 })),
					(q, i) => [queryName(base, i), q] as const
				)
			: []
		const listed: ReadonlyArray<readonly [string, EntrySpec]> = [
			...Arr.map(wholes, (relation) => [relation, { kind: "whole", relation }] as const),
			...queries
		]
		const [firstRelation] = base.relations
		const entries: ReadonlyArray<readonly [string, EntrySpec]> =
			listed.length > 0
				? listed
				: [[firstRelation.name, { kind: "whole", relation: firstRelation.name }]]
		const classes = Arr.map(entries, ([entry, spec]) => ({
			entry,
			class: classifyEntry(base, spec)
		}))
		const writable = Arr.flatMap(classes, (c) =>
			c.class.kind === "writable" ? [{ entry: c.entry, target: c.class.target }] : []
		)
		const writes = source.draw(int(0, 0xffff))
		const targets = new Set<string>()
		const write: Array<string> = []
		for (const [i, w] of writable.entries()) {
			if (bit(writes, i) && !targets.has(w.target)) {
				targets.add(w.target)
				write.push(w.entry)
			}
		}
		const derivedHeld = Arr.flatMap(entries, ([entry, spec]) =>
			spec.kind === "whole" && Arr.some(base.derived, (d) => d.name === spec.relation)
				? [entry]
				: []
		)
		const refresh = on(drawn, "refresh") ? byBits(derivedHeld, source.draw(int(0, 0xff))) : []
		/**
		 * Beside each query entry it writes, the role reads the entry's target whole, so a fact of the target outside the
		 * entry is one the role sees through another entry: a write meeting it at a key is refused on a fact the role holds.
		 */
		const beside: ReadonlyArray<readonly [string, EntrySpec]> = on(drawn, "read-beside-write")
			? Arr.flatMap(writable, (w): ReadonlyArray<readonly [string, EntrySpec]> =>
					write.includes(w.entry) &&
					Arr.some(entries, ([entry, spec]) => entry === w.entry && spec.kind === "query") &&
					!Arr.some(entries, ([, spec]) => spec.kind === "whole" && spec.relation === w.target)
						? [[w.target, { kind: "whole", relation: w.target }]]
						: []
				)
			: []
		return { name, entries: Rec.fromEntries([...entries, ...beside]), write, refresh }
	}

/** The logins of the roles: one holding them all, or two splitting them by drawn bits, neither empty. */
const resolveLogins =
	(
		roles: Arr.NonEmptyReadonlyArray<RoleSpec>,
		drawn: Swarm<InstallFeature>
	): Gen<Arr.NonEmptyReadonlyArray<LoginSpec>> =>
	(source) => {
		const names = Arr.map(roles, (r) => r.name)
		if (names.length < 2 || !on(drawn, "two-logins")) {
			return [{ name: loginNames[0], roles: knownNonEmpty(names, "the roles") }]
		}
		const second = byBits(names, source.draw(int(0, 7)))
		const ops =
			second.length === 0
				? names.slice(-1)
				: second.length === names.length
					? names.slice(1)
					: second
		const web = Arr.filter(names, (r) => !ops.includes(r))
		return [
			{ name: loginNames[0], roles: knownNonEmpty(web, "the first login's roles") },
			{ name: loginNames[1], roles: knownNonEmpty(ops, "the second login's roles") }
		]
	}

/**
 * The installations of a base, each one grizzle builds: roles of whole entries and query entries (one or two rules
 * over one source; each field in the head, claimed, fixed to a literal, free, omitted, aliased, or in the head as a
 * literal; filters of comparisons, matches and negations of linked relations, closed rosters, derived relations and
 * contexts; contexts matched or negated), write lists of writable entries at most one per relation, a written query
 * entry's target held whole beside it, refresh lists of the derived relations a role holds whole, and one or two logins,
 * every role in exactly one. A case draws its swarm first, then one to three roles under it, each in its own span.
 */
export const installGen =
	(base: BaseSpec): Gen<InstallSpec> =>
	(source) => {
		const drawn = source.draw(swarm(installFeatures))
		const roleAt = (i: number): Gen<RoleSpec> =>
			span("element", resolveRole(base, roleNames[i] ?? `role${i}`, drawn))
		const roles = source.draw(
			span("array", (inner): Arr.NonEmptyReadonlyArray<RoleSpec> => {
				const count = inner.draw(int(1, 3))
				const first = inner.draw(roleAt(0))
				const rest: Array<RoleSpec> = []
				for (let i = 1; i < count; i += 1) {
					rest.push(inner.draw(roleAt(i)))
				}
				return [first, ...rest]
			})
		)
		return { base, roles, logins: source.draw(resolveLogins(roles, drawn)) }
	}

/** The write-list kinds an installation grizzle refuses at build carries. */
export type InstallKind = "install:unwritable-write" | "install:two-writes-one-relation"

/** Every write-list kind, each once: a kind the union adds is a compile error here until it is listed. */
const installKindOf: { readonly [K in InstallKind]: K } = {
	"install:unwritable-write": "install:unwritable-write",
	"install:two-writes-one-relation": "install:two-writes-one-relation"
}

/** Every write-list kind an installation grizzle refuses at build carries. */
export const plantedKinds: ReadonlyArray<InstallKind> = Rec.values(installKindOf)

/** A name for a planted entry: none of the role's entries, nor any relation of the base. */
const freshName = (base: BaseSpec, role: RoleSpec, stem: string): string => {
	const taken = new Set([...wholeCandidates(base), ...Rec.keys(role.entries)])
	let name = stem
	while (taken.has(name)) {
		name = `${name}x`
	}
	return name
}

/** A planted rule's variable for a field, spelled apart from the lawful rules' own. */
const plantedVariable = (name: string): Term => ({ kind: "var", name: `v_${name}` })

/**
 * A role with a defect planted beside its lawful entries, grizzle refusing the installation that holds it: an entry the
 * writable rule refuses in its write list (a query over the base's first relation whose head names one field twice,
 * the aliasing grizzle refuses), or a second writable entry over a relation it writes (the relation whole, and a query
 * selecting every field of it).
 */
const planted = (base: BaseSpec, role: RoleSpec, kind: InstallKind): RoleSpec => {
	const [relation] = base.relations
	const [field] = relation.fields
	switch (kind) {
		case "install:unwritable-write": {
			const name = freshName(base, role, "Aliased")
			const entry: EntrySpec = {
				kind: "query",
				rules: [
					{
						matches: [
							{
								source: { kind: "ordinary", name: relation.name },
								fields: { [field.name]: plantedVariable(field.name) }
							}
						],
						negations: [],
						comparisons: [],
						head: {
							[field.name]: plantedVariable(field.name),
							[`${field.name}_again`]: plantedVariable(field.name)
						}
					}
				]
			}
			return { ...role, entries: { ...role.entries, [name]: entry }, write: [...role.write, name] }
		}
		case "install:two-writes-one-relation": {
			const name = freshName(base, role, "Twin")
			const every = Rec.fromEntries(
				Arr.map(relation.fields, (f) => [f.name, plantedVariable(f.name)] as const)
			)
			const entry: EntrySpec = {
				kind: "query",
				rules: [
					{
						matches: [{ source: { kind: "ordinary", name: relation.name }, fields: every }],
						negations: [],
						comparisons: [],
						head: every
					}
				]
			}
			return {
				...role,
				entries: {
					...role.entries,
					[relation.name]: { kind: "whole", relation: relation.name },
					[name]: entry
				},
				write: [...Arr.filter(role.write, (w) => w !== relation.name), relation.name, name]
			}
		}
	}
}

/** An installation grizzle refuses at build for the write-list kind `kind`: its first role with the defect planted. */
export const plantedInstall = (install: InstallSpec, kind: InstallKind): InstallSpec => {
	const [first, ...rest] = install.roles
	return { ...install, roles: [planted(install.base, first, kind), ...rest] }
}

/**
 * The installations of a base grizzle refuses at build, by the write-list kind each carries: a lawful installation
 * (installGen) whose first role has the defect planted, so every one is of its kind by construction.
 */
export const plantedInstallGen = (base: BaseSpec, kind: InstallKind): Gen<InstallSpec> =>
	map(installGen(base), (install) => plantedInstall(install, kind))
