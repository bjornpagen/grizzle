import { constant, element, type Gen, map, weighted, type Weighted } from "@grizzle/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { conversionOf, parseDeclaredName } from "#compiler/core/identity.ts"
import {
	type Admitted,
	admittedNames,
	catalogTypeNames,
	type IdentifierFeature,
	type IdentifierWeights,
	weightedNameGen
} from "#test/support/kernel/dict.ts"
import type {
	BaseSpec,
	Comparison,
	EntrySpec,
	FieldDomain,
	FieldSpec,
	InstallSpec,
	LawSpec,
	Occurrence,
	RoleSpec,
	Rule,
	SideSpec,
	Term
} from "#test/support/worlds/model/types.ts"

/**
 * Installations named from the kernel dictionary (kernel/dict.ts): each of a base's relations, closed rosters,
 * contracts and derived relations, and each role's query entries, keeps its name, takes a name of the whole dictionary,
 * its feature drawn by worldNameWeights, or takes the name of one of PostgreSQL's own types. Role views, context
 * policies, world bodies and claims SQL so meet aliases, digit boundaries, names at the identifier limit, reserved
 * words, plain words and the names pg_catalog's types and functions hold; a relation's or a derived relation's row
 * type, a roster's enum or a contract's domain named after a type shadows it where a path lists the installation's
 * schema first. A name never takes a conversion another name of its scope has: an object's scope is the base's objects,
 * contexts and check laws, and a query entry's is those and its role's other entries. The rename is a substitution over
 * the whole installation, the base's objects, its laws, its contexts' fields, its derived relations' rules and every
 * role's entries, writes and refreshes, so the model, the executor and the realities read the renamed names alike.
 */

/** A renaming of names: the name each one takes, itself where it keeps its own. */
type Renaming = (name: string) => string

const renamingOf =
	(table: ReadonlyMap<string, string>): Renaming =>
	(name) =>
		table.get(name) ?? name

const domainOf = (n: Renaming, domain: FieldDomain): FieldDomain => {
	switch (domain.kind) {
		case "handle":
			return { ...domain, closed: n(domain.closed) }
		case "contract":
			return { ...domain, name: n(domain.name) }
		case "uuid":
		case "text":
		case "integer":
		case "serial":
		case "boolean":
		case "span":
			return domain
	}
}

const fieldsOf = (
	n: Renaming,
	fields: Arr.NonEmptyReadonlyArray<FieldSpec>
): Arr.NonEmptyReadonlyArray<FieldSpec> =>
	Arr.map(fields, (f) => ({ ...f, domain: domainOf(n, f.domain) }))

const sideOf = (n: Renaming, side: SideSpec): SideSpec => ({ ...side, relation: n(side.relation) })

const lawOf = (n: Renaming, law: LawSpec): LawSpec => {
	switch (law.kind) {
		case "key":
		case "spanKey":
		case "check":
			return { ...law, relation: n(law.relation) }
		case "contained":
		case "covered":
			return { ...law, source: sideOf(n, law.source), target: sideOf(n, law.target) }
		case "alternatives":
			return {
				...law,
				relation: n(law.relation),
				closed: n(law.closed),
				arms: Rec.map(law.arms, (arm) => n(arm))
			}
	}
}

const termOf = (n: Renaming, term: Term): Term => {
	switch (term.kind) {
		case "handle":
			return { ...term, closed: n(term.closed) }
		case "var":
		case "literal":
		case "context":
			return term
	}
}

const occurrenceOf = (n: Renaming, o: Occurrence): Occurrence => ({
	source: o.source.kind === "context" ? o.source : { ...o.source, name: n(o.source.name) },
	fields: Rec.map(o.fields, (t) => termOf(n, t))
})

const comparisonOf = (n: Renaming, c: Comparison): Comparison => ({
	...c,
	left: termOf(n, c.left),
	right: termOf(n, c.right)
})

const ruleOf = (n: Renaming, rule: Rule): Rule => ({
	matches: Arr.map(rule.matches, (o) => occurrenceOf(n, o)),
	negations: Arr.map(rule.negations, (conjunction) =>
		Arr.map(conjunction, (o) => occurrenceOf(n, o))
	),
	comparisons: Arr.map(rule.comparisons, (c) => comparisonOf(n, c)),
	head: Rec.map(rule.head, (t) => termOf(n, t))
})

const rulesOf = (
	n: Renaming,
	rules: Arr.NonEmptyReadonlyArray<Rule>
): Arr.NonEmptyReadonlyArray<Rule> => Arr.map(rules, (r) => ruleOf(n, r))

const baseOf = (n: Renaming, base: BaseSpec): BaseSpec => ({
	...base,
	closed: Arr.map(base.closed, (c) => ({ ...c, name: n(c.name) })),
	relations: Arr.map(base.relations, (r) => ({
		...r,
		name: n(r.name),
		fields: fieldsOf(n, r.fields)
	})),
	laws: Arr.map(base.laws, (l) => lawOf(n, l)),
	contexts: Arr.map(base.contexts, (c) => ({ ...c, fields: fieldsOf(n, c.fields) })),
	derived: Arr.map(base.derived, (d) => ({ ...d, name: n(d.name), rules: rulesOf(n, d.rules) }))
})

const entryOf = (n: Renaming, entry: EntrySpec): EntrySpec => {
	switch (entry.kind) {
		case "whole":
			return { kind: "whole", relation: n(entry.relation) }
		case "query":
			return { kind: "query", rules: rulesOf(n, entry.rules) }
	}
}

/**
 * A role under the base's renaming `n` and its entries' renaming `e`: a whole entry keeps its relation's name, a query
 * entry takes the name `e` gives it, and the write and refresh lists follow their entries.
 */
const roleOf = (n: Renaming, e: Renaming, role: RoleSpec): RoleSpec => ({
	...role,
	entries: Rec.fromEntries(
		Arr.map(Rec.toEntries(role.entries), ([name, entry]) => [e(name), entryOf(n, entry)] as const)
	),
	write: Arr.map(role.write, e),
	refresh: Arr.map(role.refresh, e)
})

/** The base's objects a name names: its relations, rosters, contracts and derived relations, each once. */
const objectNames = (base: BaseSpec): ReadonlyArray<string> =>
	Arr.dedupe([
		...Arr.map(base.relations, (r) => r.name),
		...Arr.map(base.closed, (c) => c.name),
		...Arr.flatMap([...base.relations, ...base.contexts], (owner) =>
			Arr.flatMap(owner.fields, (f) => (f.domain.kind === "contract" ? [f.domain.name] : []))
		),
		...Arr.map(base.derived, (d) => d.name)
	])

/** Every name an installation declares: its base's objects' and its roles' entries'. */
const declaredNames = (install: InstallSpec): ReadonlyArray<string> => [
	...objectNames(install.base),
	...Arr.flatMap(install.roles, (r) => Rec.keys(r.entries))
]

/** The names of a base's scope that no rename takes: its contexts' and its check laws'. */
const fixedNames = (base: BaseSpec): ReadonlyArray<string> => [
	...Arr.map(base.contexts, (c) => c.name),
	...Arr.flatMap(base.laws, (l) => (l.kind === "check" ? [l.name] : []))
]

/** A declared name's identifier, by the naming door's rule; none for a name it refuses. */
const converted = (declared: string): ReadonlyArray<string> => {
	const parsed = parseDeclaredName(declared)
	return parsed.ok ? [conversionOf(parsed.value)] : []
}

/**
 * The weight of each identifier feature in a name an installation takes from the dictionary: aliases, names at the
 * identifier limit, reserved words and the catalog's type and function names twice as often as digit boundaries and
 * plain words. The rule admits no name past the limit, so that feature is never drawn.
 */
const worldNameWeights: IdentifierWeights = {
	alias: 2,
	"digit boundary": 1,
	"long, at the limit": 2,
	"long, past the limit": 0,
	"reserved word": 2,
	"catalog type": 2,
	plain: 1
}

/** The dictionary's names by their declared spelling. */
const dictionary: ReadonlyMap<string, Admitted> = new Map(
	Arr.map(admittedNames, (n) => [n.declared, n] as const)
)

/** The features the installations' names draw: each feature worldNameWeights weighs that the dictionary admits. */
export const drawnNameFeatures: ReadonlyArray<IdentifierFeature> = Arr.dedupe(
	Arr.flatMap(admittedNames, (n) => (worldNameWeights[n.feature] > 0 ? [n.feature] : []))
)

/**
 * The name `name` takes in a scope whose names convert to `taken`: its own, a dictionary name, or a PostgreSQL type's
 * name, each new name one converting to none of `taken`.
 */
const nameIn =
	(name: string, taken: ReadonlySet<string>): Gen<string> =>
	(source) => {
		const words = Arr.filter(admittedNames, (n) => !taken.has(n.converted))
		const types = Arr.filter(catalogTypeNames, (declared) =>
			Arr.every(converted(declared), (identifier) => !taken.has(identifier))
		)
		const kept: Weighted<string> = [4, constant(name)]
		const arms: Arr.NonEmptyReadonlyArray<Weighted<string>> = [
			kept,
			...(Arr.isReadonlyArrayNonEmpty(words)
				? [[2, map(weightedNameGen(worldNameWeights, words), (n) => n.declared)] as const]
				: []),
			...(Arr.isReadonlyArrayNonEmpty(types) ? [[1, element(types)] as const] : [])
		]
		return source.draw(weighted(arms))
	}

/**
 * The names `names` take in a scope whose other names convert to `taken`, one after another, each taking a conversion
 * no name before it took.
 */
const namesIn =
	(names: ReadonlyArray<string>, taken: ReadonlySet<string>): Gen<ReadonlyMap<string, string>> =>
	(source) => {
		const scope = new Set(taken)
		const table = new Map<string, string>()
		for (const name of names) {
			const to = source.draw(nameIn(name, scope))
			table.set(name, to)
			for (const identifier of converted(to)) {
				scope.add(identifier)
			}
		}
		return table
	}

/**
 * A role's query entries renamed under the base's renaming `n`, in a scope of the base's names, old and new, the
 * contexts' and the check laws' (`taken`) and the role's other entries; a whole entry keeps its relation's name.
 */
const roleNamed =
	(n: Renaming, taken: ReadonlySet<string>, role: RoleSpec): Gen<RoleSpec> =>
	(source) => {
		const listed = Rec.toEntries(role.entries)
		const queries = Arr.flatMap(listed, ([name, entry]) => (entry.kind === "query" ? [name] : []))
		const scope = new Set([
			...taken,
			...Arr.flatMap(listed, ([name, entry]) => converted(entry.kind === "whole" ? n(name) : name))
		])
		const table = source.draw(namesIn(queries, scope))
		return roleOf(n, (name) => table.get(name) ?? n(name), role)
	}

/**
 * `install` with every name drawn anew (nameIn), the base's objects first, then each role's query entries, in a scope
 * of every name the installation declares.
 */
const named =
	(install: InstallSpec): Gen<InstallSpec> =>
	(source) => {
		const objects = objectNames(install.base)
		const own = new Set(
			Arr.flatMap([...declaredNames(install), ...fixedNames(install.base)], converted)
		)
		const n = renamingOf(source.draw(namesIn(objects, own)))
		const taken = new Set([...own, ...Arr.flatMap(objects, (o) => converted(n(o)))])
		const [first, ...rest] = install.roles
		return {
			...install,
			base: baseOf(n, install.base),
			roles: [
				source.draw(roleNamed(n, taken, first)),
				...Arr.map(rest, (r) => source.draw(roleNamed(n, taken, r)))
			]
		}
	}

/** An installation of `installs`, or, as often, that installation with its names drawn from the dictionary. */
export const dictionaryNamed =
	(installs: Gen<InstallSpec>): Gen<InstallSpec> =>
	(source) => {
		const install = source.draw(installs)
		return source.draw(
			weighted<InstallSpec>([
				[1, constant(install)],
				[1, named(install)]
			])
		)
	}

/** The declared names of PostgreSQL's own types (kernel/dict.ts catalogTypeNames). */
const catalogTypes: ReadonlySet<string> = new Set(catalogTypeNames)

/**
 * Whether an installation names a base object or a role entry after a PostgreSQL type: the row type, enum or domain of
 * that name a path listing its schema first resolves the bare name to.
 */
export const namesCatalogType = (install: InstallSpec): boolean =>
	Arr.some(declaredNames(install), (name) => catalogTypes.has(name))

/** The conversions of every object, context and check-law name `bases` declare: the names a generator starts from. */
export const ownConversions = (bases: ReadonlyArray<BaseSpec>): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(bases, (base) =>
			Arr.flatMap([...objectNames(base), ...fixedNames(base)], converted)
		)
	)

/**
 * The dictionary features of the names an installation declares beyond `own`, the conversions of the names its
 * generator started from (ownConversions): each feature of a base object's or a role entry's name that is a dictionary
 * name converting to none of them.
 */
export const nameFeatures = (
	install: InstallSpec,
	own: ReadonlySet<string>
): ReadonlyArray<IdentifierFeature> =>
	Arr.dedupe(
		Arr.flatMap(declaredNames(install), (name) => {
			const admitted = dictionary.get(name)
			return admitted === undefined || own.has(admitted.converted) ? [] : [admitted.feature]
		})
	)
