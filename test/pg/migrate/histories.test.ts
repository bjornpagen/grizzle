import { layer } from "@effect/vitest"
import {
	type Machine,
	type Program,
	program,
	type Real,
	runProgram
} from "@grizzle/testing/commands"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, int, map } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { indices } from "#compiler/core/array.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { loginRoleExchange } from "#compiler/deploy/diff/diff.ts"
import { type Candidate, candidatesOf } from "#compiler/deploy/diff/plan.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import {
	carry,
	noExtras,
	type Renames,
	serialFields,
	typedValue,
	type Version,
	versionOf
} from "#test/pg/migrate-gen/support.ts"
import {
	apply,
	factSetOf,
	noFurther,
	openMigrator,
	rowsOf,
	sameCatalog
} from "#test/pg/migrate/support.ts"
import { assert, refusalLoc, refused, succeeded } from "#test/support/assert.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	type Previous
} from "#test/support/migrate/kit.ts"
import { choosable, decisionText, readsBack, review } from "#test/support/migrate/review.ts"
import { int4, int8, scalarOfSpec } from "#test/support/oracle/gen/domain.ts"
import type { LiteralRow, ValueFacts } from "#test/support/oracle/gen/facts.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import { planRealInstall, type RealInstallPlan } from "#test/support/oracle/install/real.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { type Built, buildInstall } from "#test/support/worlds/execute/build.ts"
import type {
	EntrySpec,
	FieldDomain,
	InstallSpec,
	LoginSpec,
	RelationSpec,
	RoleSpec,
	Rule
} from "#test/support/worlds/model/types.ts"

/** Rename histories on PostgreSQL 19, run as a commands program against a pure model of identity.
 *
 * The model holds the declared objects, and for each installed one the declaration it stands for (its origin): the
 * relations and their fields, among them a field of the closed relation Tier; Tier's handles; the context the worlds
 * read and its fields; the roles, each holding relations whole or entries over the context, a relation named by its
 * place; and the logins, each holding its roles. Each command is one schema edit:
 *
 * - a relation renamed, two relations' names swapped, a field renamed, a field renamed with its type changed, or a
 *   relation removed and one of its shape added under another name (a new identity, which the draft offers as a
 *   candidate the model keeps); programs chain them, so a rename followed by another is a chain A→B→C, and one back to
 *   an earlier name A→B→A;
 * - a closed handle renamed in place, or Tier's handles reordered, which rebuilds its enum;
 * - a login renamed, or renamed while its roles change (a role added to it, or taken from another login);
 * - an entry added to a role or removed from it, a field of the context renamed or added, or the context renamed;
 * - a login's and a role's names exchanged: one PostgreSQL role would turn from a login into a role, which the draft
 *   refuses by name (loginRoleExchange), at the PostgreSQL role of one of the two, applying nothing.
 *
 * Each step drafts the edit from the snapshot before (`grizzle generate`) and reviews it by the model's identity map:
 * each candidate chosen exactly when the removed and the added object are one declaration (a relation's rename by its
 * origin, a field's by its own, a field's rename nested in a relation's only under that relation's, a login's by its
 * origin), a decision the documented rules allow (`choosable`). It checks the decision reads back as made (the read-back
 * oracle), and migrates it with the runner, whose admission checks the catalog against the snapshot (drift). After
 * every step:
 *
 * - the installed catalog is a fresh install's of the step's version, its worlds included: roles, memberships, views,
 *   policies, functions and grants;
 * - every login is the PostgreSQL role its origin was installed as, and every role the one of its name: a login renamed
 *   keeps its password, and no role is created again;
 * - the facts written before the first step read back through the renamed objects: every relation of the step holds
 *   the rows the carry model of the model's identity map says, against a fresh install loaded with them.
 *
 * What a single-step suite cannot see, a rename that loses its identity across steps, fails here: the model says which
 * object is which, and PostgreSQL must agree. */
const declared = "History"
const relationPool = ["Alpha", "Beta", "Gamma", "Delta"] as const
const fieldPool = ["a", "b", "c", "d", "t"] as const
const handlePool = ["low", "high", "mid", "top"] as const
const claimPool = ["g", "h", "k"] as const
const contextPool = ["Session", "Caller", "Claims"] as const
/** The names of logins and roles, one PostgreSQL namespace (`<schema>__<name>`). */
const worldPool = [
	"desk",
	"kiosk",
	"editor",
	"viewer",
	"clerk",
	"porter",
	"scribe",
	"warden"
] as const
const entryPool = ["Seen", "Mine", "Ours", "Held"] as const

/** A declared field's type: integer (narrow), bigint (wide), or a handle of the closed relation Tier. */
type FieldType = "narrow" | "wide" | "tier"

/** A declared field: its origin, its name, and its type. */
interface FieldModel {
	readonly origin: string
	readonly name: string
	readonly type: FieldType
}

/** A declared relation: its origin, every name it has had in order (the last its own), and its fields beside its key
 * `id`. */
interface RelationModel {
	readonly origin: string
	readonly names: Arr.NonEmptyReadonlyArray<string>
	readonly fields: ReadonlyArray<FieldModel>
}

/** A handle of Tier, or a field of the context: its origin and its name. */
interface NamedModel {
	readonly origin: string
	readonly name: string
}

/** A role's entry, over the relation at a place of the model: the relation held whole under its own name, or the
 * query entry `name` of its rows whose `id` is the context's field of that origin. */
type EntryModel =
	| { readonly kind: "whole"; readonly relation: number }
	| {
			readonly kind: "query"
			readonly name: string
			readonly relation: number
			readonly claim: string
	  }

/** A role: its name, which it is never renamed from, and its entries. */
interface RoleModel {
	readonly name: string
	readonly entries: Arr.NonEmptyReadonlyArray<EntryModel>
}

/** A login: its origin, every name it has had in order (the last its own), and the roles it holds. */
interface LoginModel {
	readonly origin: string
	readonly names: Arr.NonEmptyReadonlyArray<string>
	readonly roles: Arr.NonEmptyReadonlyArray<string>
}

/** The model: the declared relations, Tier's handles, the context, the roles, each in exactly one login, the logins,
 * and how many origins it has made. */
interface Model {
	readonly relations: Arr.NonEmptyReadonlyArray<RelationModel>
	readonly tier: Arr.NonEmptyReadonlyArray<NamedModel>
	readonly context: {
		readonly name: string
		readonly claims: Arr.NonEmptyReadonlyArray<NamedModel>
	}
	readonly roles: Arr.NonEmptyReadonlyArray<RoleModel>
	readonly logins: Arr.NonEmptyReadonlyArray<LoginModel>
	readonly born: number
}

const nameOf = (r: RelationModel): string => Arr.lastNonEmpty(r.names)
const loginName = (l: LoginModel): string => Arr.lastNonEmpty(l.names)

const initial: Model = {
	relations: [
		{ origin: "R0", names: ["Alpha"], fields: [{ origin: "R0.a", name: "a", type: "narrow" }] },
		{
			origin: "R1",
			names: ["Beta"],
			fields: [
				{ origin: "R1.b", name: "b", type: "wide" },
				{ origin: "R1.c", name: "c", type: "narrow" },
				{ origin: "R1.t", name: "t", type: "tier" }
			]
		}
	],
	tier: [
		{ origin: "H0", name: "low" },
		{ origin: "H1", name: "high" }
	],
	context: { name: "Session", claims: [{ origin: "G0", name: "g" }] },
	roles: [
		{
			name: "editor",
			entries: [
				{ kind: "whole", relation: 0 },
				{ kind: "query", name: "Seen", relation: 1, claim: "G0" }
			]
		},
		{ name: "viewer", entries: [{ kind: "whole", relation: 1 }] }
	],
	logins: [
		{ origin: "L0", names: ["desk"], roles: ["editor"] },
		{ origin: "L1", names: ["kiosk"], roles: ["viewer"] }
	],
	born: 2
}

/** The `i`th of a model's list, which a generator drew a place in. */
const nth = <A>(xs: ReadonlyArray<A>, i: number, what: string): A => {
	const x = xs[i]
	if (x === undefined) {
		throw new Error(`no ${what} ${i} of ${xs.length}`)
	}
	return x
}

const freeOf = (pool: ReadonlyArray<string>, used: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.filter(pool, (n) => !used.includes(n))

/** The relation names no relation of the model has. */
const freeRelations = (m: Model): ReadonlyArray<string> =>
	freeOf(relationPool, Arr.map(m.relations, nameOf))

/** The field names a relation does not have. */
const freeFields = (r: RelationModel): ReadonlyArray<string> =>
	freeOf(
		fieldPool,
		Arr.map(r.fields, (f) => f.name)
	)

const freeHandles = (m: Model): ReadonlyArray<string> =>
	freeOf(
		handlePool,
		Arr.map(m.tier, (h) => h.name)
	)

const freeClaims = (m: Model): ReadonlyArray<string> =>
	freeOf(
		claimPool,
		Arr.map(m.context.claims, (c) => c.name)
	)

const freeContexts = (m: Model): ReadonlyArray<string> => freeOf(contextPool, [m.context.name])

/** The names no login and no role of the model has. */
const freeWorlds = (m: Model): ReadonlyArray<string> =>
	freeOf(worldPool, [...Arr.map(m.logins, loginName), ...Arr.map(m.roles, (r) => r.name)])

const replaced = (m: Model, at: number, r: RelationModel): Model => ({
	...m,
	relations: Arr.map(m.relations, (x, i) => (i === at ? r : x))
})

/** The name an entry has in its role: its relation's for a whole entry, its own for a query entry. */
const entryName = (m: Model, e: EntryModel): string => {
	switch (e.kind) {
		case "whole":
			return nameOf(nth(m.relations, e.relation, "relation"))
		case "query":
			return e.name
	}
}

/** The entries a role may take besides its own: each relation it does not hold whole, and a query entry of each
 * relation over each field of the context, under the first entry name it has not used. */
const entryOptions = (m: Model, r: RoleModel): ReadonlyArray<EntryModel> => {
	const wholes = Arr.flatMap(indices(m.relations.length), (p): ReadonlyArray<EntryModel> =>
		Arr.some(r.entries, (e) => e.kind === "whole" && e.relation === p)
			? []
			: [{ kind: "whole", relation: p }]
	)
	const name = Arr.findFirst(
		entryPool,
		(n) => !Arr.some(r.entries, (e) => e.kind === "query" && e.name === n)
	)
	const queries: ReadonlyArray<EntryModel> = Option.match(name, {
		onNone: () => [],
		onSome: (n) =>
			Arr.flatMap(indices(m.relations.length), (p) =>
				Arr.map(m.context.claims, (c): EntryModel => ({
					kind: "query",
					name: n,
					relation: p,
					claim: c.origin
				}))
			)
	})
	return [...wholes, ...queries]
}

/** What a login's rename also changes of its roles: a role added to it, holding one relation whole, or a role taken
 * from another login that keeps one. */
type RoleChange =
	| { readonly kind: "add"; readonly role: string; readonly relation: number }
	| { readonly kind: "take"; readonly role: string }

type Params = {
	readonly "rename a relation": { readonly at: number; readonly to: string }
	readonly "swap two relations' names": { readonly first: number; readonly second: number }
	readonly "rename a field": { readonly at: number; readonly field: number; readonly to: string }
	readonly "rename a field and change its type": {
		readonly at: number
		readonly field: number
		readonly to: string
	}
	readonly "remove a relation and add one of its shape": {
		readonly at: number
		readonly to: string
	}
	readonly "rename a closed handle": { readonly handle: number; readonly to: string }
	readonly "reorder the closed handles": { readonly swap: number }
	readonly "rename a login": { readonly login: number; readonly to: string }
	readonly "rename a login while its roles change": {
		readonly login: number
		readonly to: string
		readonly change: RoleChange
	}
	readonly "exchange a login's and a role's names": {
		readonly login: number
		readonly role: number
	}
	readonly "add an entry to a role": { readonly role: number; readonly entry: EntryModel }
	readonly "remove an entry from a role": { readonly role: number; readonly entry: number }
	readonly "rename a context field": { readonly claim: number; readonly to: string }
	readonly "add a context field": { readonly to: string }
	readonly "rename the context": { readonly to: string }
}

/** A relation and a free name, drawn. */
const relationAndName =
	(m: Model): Gen<{ readonly at: number; readonly to: string }> =>
	(source) => ({
		at: source.draw(int(0, m.relations.length - 1)),
		to: source.draw(element(nonEmptyList(freeRelations(m), "a free relation name")))
	})

/** Whether a field may be renamed with its type changed: an integer's, which the other integer type holds, never a
 * handle's. */
const retypable = (f: FieldModel): boolean => f.type !== "tier"

/** The relations with a field to rename, and, with `retype`, one whose type may change. */
const renamable = (m: Model, retype: boolean): ReadonlyArray<number> =>
	Arr.filter(
		indices(m.relations.length),
		(i) =>
			freeFields(nth(m.relations, i, "relation")).length > 0 &&
			Arr.some(nth(m.relations, i, "relation").fields, (f) => !retype || retypable(f))
	)

/** A relation, one of its fields, and a free field name, drawn; with `retype`, a field whose type may change. */
const fieldAndName =
	(
		m: Model,
		retype: boolean
	): Gen<{ readonly at: number; readonly field: number; readonly to: string }> =>
	(source) => {
		const at = source.draw(
			element(nonEmptyList(renamable(m, retype), "a relation with a field to rename"))
		)
		const r = nth(m.relations, at, "relation")
		const fields = Arr.filter(indices(r.fields.length), (k) =>
			retype ? retypable(nth(r.fields, k, "field")) : true
		)
		return {
			at,
			field: source.draw(element(nonEmptyList(fields, "a field to rename"))),
			to: source.draw(element(nonEmptyList(freeFields(r), "a free field name")))
		}
	}

const renamedField = (
	m: Model,
	p: { readonly at: number; readonly field: number; readonly to: string },
	retype: boolean
): Model => {
	const r = nth(m.relations, p.at, "relation")
	const flipped = (t: FieldType): FieldType =>
		t === "wide" ? "narrow" : t === "narrow" ? "wide" : t
	return replaced(m, p.at, {
		...r,
		fields: Arr.map(r.fields, (f, i) =>
			i === p.field ? { ...f, name: p.to, type: retype ? flipped(f.type) : f.type } : f
		)
	})
}

const renamedLogin = (m: Model, login: number, to: string): Model => ({
	...m,
	logins: Arr.map(m.logins, (l, k) => (k === login ? { ...l, names: Arr.append(l.names, to) } : l))
})

const changedRoles = (m: Model, login: number, change: RoleChange): Model => {
	switch (change.kind) {
		case "add": {
			const added: RoleModel = {
				name: change.role,
				entries: [{ kind: "whole", relation: change.relation }]
			}
			return {
				...m,
				roles: Arr.append(m.roles, added),
				logins: Arr.map(m.logins, (l, k) =>
					k === login ? { ...l, roles: Arr.append(l.roles, change.role) } : l
				)
			}
		}
		case "take":
			return {
				...m,
				logins: Arr.map(m.logins, (l, k) =>
					k === login
						? { ...l, roles: Arr.append(l.roles, change.role) }
						: {
								...l,
								roles: nonEmptyList(
									Arr.filter(l.roles, (r) => r !== change.role),
									"a login keeps a role"
								)
							}
				)
			}
	}
}

/** The model a login's and a role's names exchanged would declare: the login under the role's name, the role under
 * the login's. */
const exchanged = (m: Model, p: Params["exchange a login's and a role's names"]): Model => {
	const login = nth(m.logins, p.login, "login")
	const role = nth(m.roles, p.role, "role")
	const was = loginName(login)
	return {
		...m,
		roles: Arr.map(m.roles, (r, k) => (k === p.role ? { ...r, name: was } : r)),
		logins: Arr.map(m.logins, (l, k) => ({
			...l,
			names: k === p.login ? Arr.append(l.names, role.name) : l.names,
			roles: Arr.map(l.roles, (n) => (n === role.name ? was : n))
		}))
	}
}

const machine: Machine<Model, Params> = {
	initial,
	commands: {
		"rename a relation": {
			applies: (m) => freeRelations(m).length > 0,
			parameters: relationAndName,
			next: (m, p) => {
				const r = nth(m.relations, p.at, "relation")
				return replaced(m, p.at, { ...r, names: Arr.append(r.names, p.to) })
			}
		},
		"swap two relations' names": {
			applies: (m) => m.relations.length >= 2,
			parameters: (m) => map(int(1, m.relations.length - 1), (second) => ({ first: 0, second })),
			next: (m, p) => {
				const a = nth(m.relations, p.first, "relation")
				const b = nth(m.relations, p.second, "relation")
				return {
					...m,
					relations: Arr.map(m.relations, (x, i) =>
						i === p.first
							? { ...a, names: Arr.append(a.names, nameOf(b)) }
							: i === p.second
								? { ...b, names: Arr.append(b.names, nameOf(a)) }
								: x
					)
				}
			}
		},
		"rename a field": {
			applies: (m) => renamable(m, false).length > 0,
			parameters: (m) => fieldAndName(m, false),
			next: (m, p) => renamedField(m, p, false)
		},
		"rename a field and change its type": {
			applies: (m) => renamable(m, true).length > 0,
			parameters: (m) => fieldAndName(m, true),
			next: (m, p) => renamedField(m, p, true)
		},
		"remove a relation and add one of its shape": {
			applies: (m) => freeRelations(m).length > 0,
			parameters: relationAndName,
			next: (m, p) => {
				const r = nth(m.relations, p.at, "relation")
				const origin = `R${m.born}`
				return {
					...replaced(m, p.at, {
						origin,
						names: [p.to],
						fields: Arr.map(r.fields, (f) => ({ ...f, origin: `${origin}.${f.name}` }))
					}),
					born: m.born + 1
				}
			}
		},
		"rename a closed handle": {
			applies: (m) => freeHandles(m).length > 0,
			parameters: (m) => (source) => ({
				handle: source.draw(int(0, m.tier.length - 1)),
				to: source.draw(element(nonEmptyList(freeHandles(m), "a free handle name")))
			}),
			next: (m, p) => ({
				...m,
				tier: Arr.map(m.tier, (h, i) => (i === p.handle ? { ...h, name: p.to } : h))
			})
		},
		"reorder the closed handles": {
			applies: (m) => m.tier.length >= 2,
			parameters: (m) => map(int(1, m.tier.length - 1), (swap) => ({ swap })),
			next: (m, p) => {
				const first = Arr.headNonEmpty(m.tier)
				const other = nth(m.tier, p.swap, "handle")
				return {
					...m,
					tier: Arr.map(m.tier, (h, i) => (i === 0 ? other : i === p.swap ? first : h))
				}
			}
		},
		"rename a login": {
			applies: (m) => freeWorlds(m).length > 0,
			parameters: (m) => (source) => ({
				login: source.draw(int(0, m.logins.length - 1)),
				to: source.draw(element(nonEmptyList(freeWorlds(m), "a free login name")))
			}),
			next: (m, p) => renamedLogin(m, p.login, p.to)
		},
		"rename a login while its roles change": {
			applies: (m) => freeWorlds(m).length >= 2,
			parameters: (m) => (source) => {
				const login = source.draw(int(0, m.logins.length - 1))
				const free = nonEmptyList(freeWorlds(m), "a free login name")
				const to = source.draw(element(free))
				const relation = source.draw(int(0, m.relations.length - 1))
				const adds = Arr.map(
					Arr.filter(free, (n) => n !== to),
					(role): RoleChange => ({ kind: "add", role, relation })
				)
				const takes = Arr.flatMap(m.logins, (l, k): ReadonlyArray<RoleChange> =>
					k === login || l.roles.length < 2
						? []
						: Arr.map(l.roles, (role): RoleChange => ({ kind: "take", role }))
				)
				const change = source.draw(
					element(nonEmptyList([...adds, ...takes], "a change of the login's roles"))
				)
				return { login, to, change }
			},
			next: (m, p) => changedRoles(renamedLogin(m, p.login, p.to), p.login, p.change)
		},
		"exchange a login's and a role's names": {
			applies: () => true,
			parameters: (m) => (source) => ({
				login: source.draw(int(0, m.logins.length - 1)),
				role: source.draw(int(0, m.roles.length - 1))
			}),
			next: (m) => m
		},
		"add an entry to a role": {
			applies: (m) => Arr.some(m.roles, (r) => entryOptions(m, r).length > 0),
			parameters: (m) => (source) => {
				const open = Arr.filter(
					indices(m.roles.length),
					(i) => entryOptions(m, nth(m.roles, i, "role")).length > 0
				)
				const role = source.draw(element(nonEmptyList(open, "a role that may hold another entry")))
				return {
					role,
					entry: source.draw(
						element(
							nonEmptyList(
								entryOptions(m, nth(m.roles, role, "role")),
								"an entry the role may hold"
							)
						)
					)
				}
			},
			next: (m, p) => ({
				...m,
				roles: Arr.map(m.roles, (r, k) =>
					k === p.role ? { ...r, entries: Arr.append(r.entries, p.entry) } : r
				)
			})
		},
		"remove an entry from a role": {
			applies: (m) => Arr.some(m.roles, (r) => r.entries.length > 1),
			parameters: (m) => (source) => {
				const several = Arr.filter(
					indices(m.roles.length),
					(i) => nth(m.roles, i, "role").entries.length > 1
				)
				const role = source.draw(element(nonEmptyList(several, "a role of several entries")))
				return {
					role,
					entry: source.draw(int(0, nth(m.roles, role, "role").entries.length - 1))
				}
			},
			next: (m, p) => ({
				...m,
				roles: Arr.map(m.roles, (r, k) =>
					k === p.role
						? {
								...r,
								entries: nonEmptyList(
									Arr.filter(r.entries, (_, j) => j !== p.entry),
									"a role keeps an entry"
								)
							}
						: r
				)
			})
		},
		"rename a context field": {
			applies: (m) => freeClaims(m).length > 0,
			parameters: (m) => (source) => ({
				claim: source.draw(int(0, m.context.claims.length - 1)),
				to: source.draw(element(nonEmptyList(freeClaims(m), "a free context field name")))
			}),
			next: (m, p) => ({
				...m,
				context: {
					...m.context,
					claims: Arr.map(m.context.claims, (c, k) => (k === p.claim ? { ...c, name: p.to } : c))
				}
			})
		},
		"add a context field": {
			applies: (m) => freeClaims(m).length > 0,
			parameters: (m) =>
				map(element(nonEmptyList(freeClaims(m), "a free context field name")), (to) => ({ to })),
			next: (m, p) => ({
				...m,
				born: m.born + 1,
				context: {
					...m.context,
					claims: Arr.append(m.context.claims, { origin: `G${m.born}`, name: p.to })
				}
			})
		},
		"rename the context": {
			applies: (m) => freeContexts(m).length > 0,
			parameters: (m) =>
				map(element(nonEmptyList(freeContexts(m), "a free context name")), (to) => ({ to })),
			next: (m, p) => ({ ...m, context: { ...m.context, name: p.to } })
		}
	}
}

const handlesOf = (m: Model): Arr.NonEmptyReadonlyArray<string> => Arr.map(m.tier, (h) => h.name)

/** Tier's enum, of the model's handles in order. */
const tierType = (m: Model): ScalarType =>
	scalarOfSpec({ carrier: "enum", roster: { closed: "Tier", handles: handlesOf(m) } })

const scalarOf = (m: Model, f: FieldModel): ScalarType => {
	switch (f.type) {
		case "narrow":
			return int4
		case "wide":
			return int8
		case "tier":
			return tierType(m)
	}
}

/** The oracle schema of a model's relations, as the carry model and the rows read them: each keyed by `id`, with its
 * fields, beside Tier. */
const schemaOf = (m: Model): GenSchema => ({
	name: declared,
	relations: Arr.map(m.relations, (r) => ({
		name: nameOf(r),
		columns: [
			{ name: "id", type: int8 },
			...Arr.map(r.fields, (f) => ({ name: f.name, type: scalarOf(m, f) }))
		],
		primaryKey: ["id"],
		keys: [],
		mutable: false
	})),
	closed: [{ name: "Tier", handles: handlesOf(m), payload: [], rows: [] }],
	containments: []
})

const versionOfModel = (m: Model): Version => versionOf(schemaOf(m), noExtras)

const wide: FieldDomain = { kind: "integer", bits: 64 }

const domainOf = (m: Model, f: FieldModel): FieldDomain => {
	switch (f.type) {
		case "narrow":
			return { kind: "integer", bits: 32 }
		case "wide":
			return wide
		case "tier":
			return { kind: "handle", closed: "Tier", members: handlesOf(m) }
	}
}

const claimName = (m: Model, origin: string): string =>
	Option.getOrThrowWith(
		Arr.findFirst(m.context.claims, (c) => c.origin === origin),
		() => new Error(`the context has no field of the origin ${origin}`)
	).name

/** A query entry's rule: the rows of the relation whose `id` is the context's field. */
const seenRule = (relationName: string, context: string, claim: string): Rule => ({
	matches: [
		{
			source: { kind: "ordinary", name: relationName },
			fields: { id: { kind: "var", name: "x" } }
		},
		{ source: { kind: "context", name: context }, fields: { [claim]: { kind: "var", name: "x" } } }
	],
	negations: [],
	comparisons: [],
	head: { id: { kind: "var", name: "x" } }
})

const entrySpec = (m: Model, e: EntryModel): EntrySpec => {
	switch (e.kind) {
		case "whole":
			return { kind: "whole", relation: nameOf(nth(m.relations, e.relation, "relation")) }
		case "query":
			return {
				kind: "query",
				rules: [
					seenRule(
						nameOf(nth(m.relations, e.relation, "relation")),
						m.context.name,
						claimName(m, e.claim)
					)
				]
			}
	}
}

/** The worlds model's install description of a model: its base, its roles and its logins. */
const installOf = (m: Model): InstallSpec => ({
	base: {
		name: declared,
		closed: [{ name: "Tier", members: handlesOf(m) }],
		relations: Arr.map(m.relations, (r): RelationSpec => ({
			name: nameOf(r),
			fields: [
				{ name: "id", domain: wide },
				...Arr.map(r.fields, (f) => ({ name: f.name, domain: domainOf(m, f) }))
			],
			key: ["id"],
			mutability: "immutable"
		})),
		laws: [],
		contexts: [
			{
				name: m.context.name,
				claim: { kind: "top-level" },
				fields: Arr.map(m.context.claims, (c) => ({ name: c.name, domain: wide }))
			}
		],
		derived: []
	},
	roles: Arr.map(m.roles, (r): RoleSpec => ({
		name: r.name,
		entries: Rec.fromEntries(
			Arr.map(r.entries, (e) => [entryName(m, e), entrySpec(m, e)] as const)
		),
		write: [],
		refresh: []
	})),
	logins: Arr.map(m.logins, (l): LoginSpec => ({ name: loginName(l), roles: l.roles }))
})

/** A model's grizzle values, built through the public builders. */
const builtOf = (m: Model) => Effect.orDie(buildInstall(installOf(m), declared))

/** The installation plan of a version's built values under `schema`, owned by `owner`, with its logins' worlds. */
const planned = (built: Built, schema: string, owner: string): RealInstallPlan =>
	succeeded(
		planRealInstall(built.base, {
			installation: identity.schema(parsedSchemaName(schema)),
			owner,
			logins: Rec.values(built.logins),
			extensions: []
		}),
		"the installation of a version"
	)

const tableOf = (name: string): string => identifierOf(identity.table(parsedName(name)))
const columnOf = (name: string): string => identifierOf(identity.column(parsedName(name)))

/** The relation of a model a physical table is, by its name or the name the naming door sets it aside under. */
const relationOfTable = (m: Model, table: string): Option.Option<RelationModel> =>
	Arr.findFirst(
		m.relations,
		(r) =>
			tableOf(nameOf(r)) === table || identifierOf(identity.aside(tableOf(nameOf(r)))) === table
	)

const fieldOfColumn = (r: RelationModel, column: string): Option.Option<FieldModel> =>
	Arr.findFirst(r.fields, (f) => columnOf(f.name) === column)

/** The login of a model a PostgreSQL role is, by the plan it was installed by. */
const loginOfRole = (m: Model, plan: RealInstallPlan, role: string): Option.Option<LoginModel> =>
	Arr.findFirst(m.logins, (l) =>
		Option.exists(Rec.get(plan.logins, loginName(l)), (x) => x.role === role)
	)

/** A version of the model and the plan it is installed by. */
interface Installed {
	readonly model: Model
	readonly plan: RealInstallPlan
}

/** The candidates a reviewer who knows the model's identity map chooses: a relation's rename exactly when its two
 * relations are one declaration; a field's on a kept relation exactly when its two fields are; a field's nested in a
 * relation's exactly when that relation's is chosen and its two fields are one declaration; a login's exactly when its
 * two logins are. Tier is never renamed, so no type's rename is chosen. */
const identityChoice = (
	g: GenerateResult,
	before: Installed,
	after: Installed
): ReadonlySet<Candidate> => {
	const offered = candidatesOf(g.plan)
	const sameField = (
		was: Option.Option<RelationModel>,
		now: Option.Option<RelationModel>,
		removed: string,
		added: string
	): boolean =>
		Option.isSome(was) &&
		Option.isSome(now) &&
		Option.exists(fieldOfColumn(was.value, removed), (f) =>
			Option.exists(fieldOfColumn(now.value, added), (x) => x.origin === f.origin)
		)
	const roots = Arr.filter(offered, (c): boolean => {
		switch (c.kind) {
			case "relation":
				return Option.exists(relationOfTable(before.model, c.removed.name), (r) =>
					Option.exists(relationOfTable(after.model, c.added.name), (x) => x.origin === r.origin)
				)
			case "field":
				return sameField(
					relationOfTable(before.model, c.relation.name),
					relationOfTable(after.model, c.relation.name),
					c.removed,
					c.added
				)
			case "login":
				return Option.exists(loginOfRole(before.model, before.plan, c.removed), (l) =>
					Option.exists(loginOfRole(after.model, after.plan, c.added), (x) => x.origin === l.origin)
				)
			case "type":
			case "nested field":
				return false
		}
	})
	const nested = Arr.filter(
		offered,
		(c) =>
			c.kind === "nested field" &&
			roots.includes(c.parent) &&
			sameField(
				relationOfTable(before.model, c.parent.removed.name),
				relationOfTable(after.model, c.parent.added.name),
				c.removed,
				c.added
			)
	)
	return new Set([...roots, ...nested])
}

/** Whether two decisions hold the same candidates. */
const sameDecision = (a: ReadonlySet<Candidate>, b: ReadonlySet<Candidate>): boolean =>
	a.size === b.size && Arr.every([...a], (c) => b.has(c))

/** The renames the model's identity map makes between two of its states, by declared names, for the carry model. */
const identityRenames = (before: Model, after: Model): Renames => {
	const relations = new Map<string, string>()
	const columns = new Map<string, string>()
	for (const r of after.relations) {
		const was = Arr.findFirst(before.relations, (x) => x.origin === r.origin)
		if (Option.isNone(was)) {
			continue
		}
		if (nameOf(was.value) !== nameOf(r)) {
			relations.set(nameOf(r), nameOf(was.value))
		}
		for (const f of r.fields) {
			const field = Arr.findFirst(was.value.fields, (x) => x.origin === f.origin)
			if (Option.isSome(field)) {
				columns.set(`${nameOf(r)}.${f.name}`, field.value.name)
			}
		}
	}
	return { relations, columns }
}

/** One row per relation of the first model, each integer distinct, each handle Tier's last. */
const firstFacts = (m: Model): ValueFacts => {
	let n = 100n
	const last = Arr.lastNonEmpty(m.tier).name
	return Rec.fromEntries(
		Arr.map(
			m.relations,
			(r) =>
				[
					nameOf(r),
					[
						[
							{ kind: "int", value: n++ },
							...Arr.map(r.fields, (f): TypedLiteral =>
								f.type === "tier" ? { kind: "enum", handle: last } : { kind: "int", value: n++ }
							)
						] satisfies LiteralRow
					]
				] as const
		)
	)
}

/** The PostgreSQL role of each login and each role of a version, by what the model says each is: a login by its
 * origin, a role by its name. */
const worldRoles = (m: Model, plan: RealInstallPlan): ReadonlyMap<string, string> =>
	new Map(
		Arr.flatMap(m.logins, (l) => {
			const installed = Option.getOrThrowWith(
				Rec.get(plan.logins, loginName(l)),
				() => new Error(`the plan installs no login ${loginName(l)}`)
			)
			return [
				[`login ${l.origin}`, installed.role] as const,
				...Arr.map(
					l.roles,
					(r) =>
						[
							`role ${r}`,
							Option.getOrThrowWith(
								Rec.get(installed.roles, r),
								() => new Error(`the login ${loginName(l)} holds no role ${r}`)
							).role
						] as const
				)
			]
		})
	)

type Feature =
	| "a relation renamed"
	| "two relations' names swapped"
	| "a field renamed"
	| "a field renamed with its type changed"
	| "a relation removed and one of its shape added"
	| "a closed handle renamed"
	| "the closed handles reordered"
	| "a login renamed"
	| "a login renamed while its roles change"
	| "a login's and a role's names exchanged, refused"
	| "an entry added to a role"
	| "an entry removed from a role"
	| "a context field renamed"
	| "a context field added"
	| "the context renamed"
	| "a chain of renames"
	| "a relation renamed back"
	| "a world entry over a renamed relation"
	| "a rename chosen by identity"
	| "a login's rename chosen by identity"
	| "a candidate kept by identity"

const featureOf: { readonly [K in keyof Params]: Feature } = {
	"rename a relation": "a relation renamed",
	"swap two relations' names": "two relations' names swapped",
	"rename a field": "a field renamed",
	"rename a field and change its type": "a field renamed with its type changed",
	"remove a relation and add one of its shape": "a relation removed and one of its shape added",
	"rename a closed handle": "a closed handle renamed",
	"reorder the closed handles": "the closed handles reordered",
	"rename a login": "a login renamed",
	"rename a login while its roles change": "a login renamed while its roles change",
	"exchange a login's and a role's names": "a login's and a role's names exchanged, refused",
	"add an entry to a role": "an entry added to a role",
	"remove an entry from a role": "an entry removed from a role",
	"rename a context field": "a context field renamed",
	"add a context field": "a context field added",
	"rename the context": "the context renamed"
}

/** The system a program runs against: one schema, its owner, the folders applied so far, the snapshot they reached and
 * the plan that installed it, the rows the model expects there, how many drafts it made, and the PostgreSQL role's
 * OID of every login and role the model has held, by what the model says each is. */
interface History {
	readonly schema: string
	readonly owner: string
	folders: Array<{
		readonly name: string
		readonly metaText: string
		readonly files: ReadonlyArray<{ readonly name: string; readonly text: string }>
	}>
	previous: Previous
	plan: RealInstallPlan
	rows: ValueFacts
	steps: number
	readonly oids: Map<string, string>
}

/** Every login of a version is the PostgreSQL role its origin was first installed as, and every role the one of its
 * name: the OID each had stays its OID. */
const sameWorlds = (h: History, m: Model, plan: RealInstallPlan, what: string) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		for (const [who, role] of worldRoles(m, plan)) {
			const rows = yield* substrate.admin.queryValues(
				"SELECT r.oid::text FROM pg_catalog.pg_roles AS r WHERE r.rolname = $1::text",
				[role]
			)
			const [oid] = Arr.flatMap(rows, (row) => {
				const x = row[0]
				return typeof x === "string" ? [x] : []
			})
			assert.ok(oid !== undefined, `${what}: the ${who} is installed as no PostgreSQL role`)
			const was = h.oids.get(who)
			if (was === undefined) {
				h.oids.set(who, oid)
			} else {
				assert.equal(oid, was, `${what}: the ${who} is another PostgreSQL role than it was`)
			}
		}
	})

/** What a step notes of the decision made by identity. */
const noteDecision = (
	g: GenerateResult,
	chosen: ReadonlySet<Candidate>,
	note: (f: Feature) => void
): void => {
	if (chosen.size > 0) {
		note("a rename chosen by identity")
	}
	if (Arr.some([...chosen], (c) => c.kind === "login")) {
		note("a login's rename chosen by identity")
	}
	if (candidatesOf(g.plan).length > chosen.size) {
		note("a candidate kept by identity")
	}
}

/** One step on PostgreSQL: the edit from `before` to `after` drafted, reviewed by identity, read back, migrated, then
 * the logins and roles against their OIDs, the catalog against a fresh install, and the rows against the carry model. */
const step = (h: History, before: Model, after: Model, note: (f: Feature) => void) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const m = yield* openMigrator(substrate, substrate.owner)
			const built = yield* builtOf(after)
			const v = versionOfModel(after)
			const plan = planned(built, h.schema, h.owner)
			h.steps++
			const g = succeeded(
				generate({
					previous: h.previous,
					installation: plan.installation,
					name: `step_${h.steps}`,
					timestamp: draftedAt(h.steps),
					workload: noWorkload
				}),
				`step ${h.steps}`
			)
			const chosen = identityChoice(g, { model: before, plan: h.plan }, { model: after, plan })
			assert.ok(
				Arr.some(choosable(g), (d) => sameDecision(d, chosen)),
				`step ${h.steps}: the decision by identity, ${decisionText(chosen)}, is none the documented rules allow`
			)
			const reviewed = review(g, {
				chosen,
				losses: "written",
				value: typedValue({ plan, version: v })
			})
			if (Result.isFailure(reviewed)) {
				return assert.fail(
					`step ${h.steps}: ${decisionText(new Set(reviewed.failure.candidates))} decide one statement`
				)
			}
			assert.deepEqual(
				readsBack(g, chosen, reviewed.success.files),
				[],
				`step ${h.steps}: the review by identity reads back as made`
			)
			noteDecision(g, chosen, note)
			if (g.change !== "none") {
				h.folders.push({
					name: g.folder.name,
					metaText: g.folder.metaText,
					files: reviewed.success.files
				})
			}
			yield* apply(m, { snapshot: g.snapshot, folders: [...h.folders] }, noFurther)
			h.previous = fromSnapshot(g.snapshot)
			h.plan = plan
			yield* sameWorlds(h, after, plan, `step ${h.steps}`)
			const model = carry(
				versionOfModel(before),
				v,
				h.rows,
				identityRenames(before, after),
				serialFields(v)
			)
			h.rows = model.expected
			const fresh = yield* substrate.schema({ create: false, label: "histories_fresh" })
			const freshPlan = planned(built, fresh, h.owner)
			yield* transaction(substrate.admin, freshPlan.sql)
			yield* sameCatalog(plan.installation, freshPlan.installation, `step ${h.steps}`)
			const loaded = factStatements(freshPlan, factSetOf(v, model.expected))
			if (!loaded.ok) {
				return assert.fail(loaded.error.message)
			}
			yield* transaction(substrate.admin, loaded.value)
			const migratedRows = yield* rowsOf(m, plan, v, h.schema, model.numbered)
			const freshRows = yield* rowsOf(m, freshPlan, v, fresh, model.numbered)
			assert.deepEqual(
				migratedRows,
				freshRows,
				`step ${h.steps}: the rows read through the renamed objects are not the model's`
			)
		})
	)

/** A login's and a role's names exchanged: the draft is refused by name, at the PostgreSQL role of one of the two, and
 * nothing is applied, so the model and the system stay where they were. */
const exchange = (h: History, before: Model, p: Params["exchange a login's and a role's names"]) =>
	Effect.gen(function* () {
		const built = yield* builtOf(exchanged(before, p))
		const plan = planned(built, h.schema, h.owner)
		h.steps++
		const error = refused(
			generate({
				previous: h.previous,
				installation: plan.installation,
				name: `step_${h.steps}`,
				timestamp: draftedAt(h.steps),
				workload: noWorkload
			}),
			"UnsupportedOperation",
			`step ${h.steps}: a login's and a role's names exchanged are drafted`
		)
		const reason = error.reason
		assert.ok(
			reason._tag === "UnsupportedOperation" && reason.capability === loginRoleExchange,
			`step ${h.steps}: the exchange is refused as another unsupported change`
		)
		const roles = worldRoles(before, h.plan)
		const login = nth(before.logins, p.login, "login")
		const role = nth(before.roles, p.role, "role")
		const named = Arr.flatMap([`login ${login.origin}`, `role ${role.name}`], (who) =>
			Option.toArray(Option.fromUndefinedOr(roles.get(who)))
		)
		const label = refusalLoc(error).label
		assert.ok(
			Arr.some(named, (r) => Str.includes(r)(label)),
			`step ${h.steps}: the refusal names neither the login nor the role exchanged`
		)
	})

/** What a step notes of the history it extends: a chain of renames, a relation renamed back, and an entry over a
 * relation it renames. */
const noteHistory = (before: Model, after: Model, note: (f: Feature) => void): void => {
	for (const r of after.relations) {
		if (r.names.length > 2) {
			note("a chain of renames")
		}
		if (r.names.length > 1 && Arr.some(Arr.initNonEmpty(r.names), (n) => n === nameOf(r))) {
			note("a relation renamed back")
		}
	}
	const renamed = Arr.filter(indices(after.relations.length), (p) => {
		const was = nth(before.relations, p, "relation")
		const now = nth(after.relations, p, "relation")
		return was.origin === now.origin && nameOf(was) !== nameOf(now)
	})
	if (Arr.some(after.roles, (r) => Arr.some(r.entries, (e) => renamed.includes(e.relation)))) {
		note("a world entry over a renamed relation")
	}
}

/** What a step of a history fails with: a migrating step's error; an exchange fails none. */
type StepError = Effect.Error<ReturnType<typeof step>>

const real = (
	h: History,
	note: (f: Feature) => void
): Real<Model, Params, StepError, Substrate> => {
	const run =
		<K extends keyof Params>(command: K) =>
		(_: Params[K], before: Model, after: Model) => {
			note(featureOf[command])
			noteHistory(before, after, note)
			return step(h, before, after, note)
		}
	return {
		"rename a relation": run("rename a relation"),
		"swap two relations' names": run("swap two relations' names"),
		"rename a field": run("rename a field"),
		"rename a field and change its type": run("rename a field and change its type"),
		"remove a relation and add one of its shape": run("remove a relation and add one of its shape"),
		"rename a closed handle": run("rename a closed handle"),
		"reorder the closed handles": run("reorder the closed handles"),
		"rename a login": run("rename a login"),
		"rename a login while its roles change": run("rename a login while its roles change"),
		"exchange a login's and a role's names": (p, before) => {
			note(featureOf["exchange a login's and a role's names"])
			return exchange(h, before, p)
		},
		"add an entry to a role": run("add an entry to a role"),
		"remove an entry from a role": run("remove an entry from a role"),
		"rename a context field": run("rename a context field"),
		"add a context field": run("add a context field"),
		"rename the context": run("rename the context")
	}
}

/** A history: the first version installed with its facts, then the program's steps, each against the model. */
const history = (steps: Program<Params>, note: (f: Feature) => void) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const owner = substrate.owner.role
			const schema = yield* substrate.schema({ create: false, label: "histories" })
			const m = yield* openMigrator(substrate, substrate.owner)
			const built = yield* builtOf(initial)
			const v = versionOfModel(initial)
			const plan = planned(built, schema, owner)
			const first = succeeded(
				generate({
					previous: fromEmpty,
					installation: plan.installation,
					name: "step_0",
					timestamp: draftedAt(0),
					workload: noWorkload
				}),
				"the first version"
			)
			const folders = [
				{ name: first.folder.name, metaText: first.folder.metaText, files: first.folder.files }
			]
			yield* apply(m, { snapshot: first.snapshot, folders: [...folders] }, noFurther)
			const facts = firstFacts(initial)
			const loaded = factStatements(plan, factSetOf(v, facts))
			if (!loaded.ok) {
				return assert.fail(loaded.error.message)
			}
			yield* transaction(substrate.admin, loaded.value)
			const h: History = {
				schema,
				owner,
				folders,
				previous: fromSnapshot(first.snapshot),
				plan,
				rows: facts,
				steps: 0,
				oids: new Map()
			}
			yield* sameWorlds(h, initial, plan, "the first version")
			yield* runProgram(machine, real(h, note), steps)
		})
	)

layer(Substrate.layer)("rename histories on PostgreSQL", (it) => {
	it.effect(
		"every step of a rename history migrates to a fresh install's catalog, its worlds included, every login and role keeps its PostgreSQL role, and the rows follow the model's identity map",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/migrate/histories",
						draw: drawn(program(machine, { min: 1, max: 5 })),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a relation renamed",
								"two relations' names swapped",
								"a field renamed",
								"a field renamed with its type changed",
								"a relation removed and one of its shape added",
								"a closed handle renamed",
								"the closed handles reordered",
								"a login renamed",
								"a login renamed while its roles change",
								"a login's and a role's names exchanged, refused",
								"an entry added to a role",
								"an entry removed from a role",
								"a context field renamed",
								"a context field added",
								"the context renamed",
								"a chain of renames",
								"a relation renamed back",
								"a world entry over a renamed relation",
								"a rename chosen by identity",
								"a login's rename chosen by identity",
								"a candidate kept by identity"
							],
							{ cases: 24, sense: notesOnly }
						),
						kept: [],
						runs: 4,
						shrink: { kind: "bounded", candidates: 60 },
						concurrency: 1,
						steerEvery: 4,
						caseHang: Duration.minutes(10)
					},
					(steps, c) => history(steps, (f) => c.note(f))
				)
			)
	)
})
