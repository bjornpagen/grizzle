import { array, element, type Gen, subset, weighted } from "@grizzle/testing/gen"
import { Array as Arr, Option, Record as Rec } from "effect"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { Bits, bits, closedId, contract, pg, uuid } from "#compiler/public/fields.ts"
import { check, closed, contained, login, on, relation, select } from "#compiler/public/schema.ts"
import { schema } from "#compiler/schema/schema.ts"
import { role } from "#compiler/schema/world.ts"
import type { Expr, SqlStatement } from "#compiler/sql/ast.ts"
import {
	type AstHooks,
	identityHooks,
	transformExpr,
	transformStatement
} from "#compiler/sql/transform.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { defined, nonEmpty } from "#test/support/assert.ts"

/**
 * Worlds for the EXECUTE grants of roles (physical/ddl/roles.ts roleExecutes): rosters, sets over them, a contract,
 * relations whose fields are typed by their domains, laws whose CHECKs and generated columns cast into those domains,
 * and roles that hold drawn relations whole and write drawn ones of them.
 *
 * - A selected containment `contained(on(S, ref), on(select(T, (t) => t.eq(t.selector, constant)), "id"))` places T's
 *   constant on S as a generated law column of the selector's base type: a closed id's is smallint and its handle an
 *   integer literal, and a set's is the set's bits domain, its value a literal cast into that domain. A role that
 *   writes S and holds no relation with a set over the selector's roster holds no USAGE on that domain, so only S's
 *   cast reaches the live-codes constant its CHECK calls.
 * - A check over a set field compares it with a set value, `ne(field, Bits.of(roster, handles))`, a literal cast into
 *   the field's own domain; over a closed id it compares with a handle.
 */
type RosterName = "Flag" | "Kind"
type RelationName = "Item" | "Part" | "Note"
type RoleName = "clerk" | "keeper"

/** A field over a roster: a closed id or a set, the kinds a selector and a check read. */
interface RosterField {
	readonly name: string
	readonly kind: "code" | "set"
	readonly roster: RosterName
}

/** A field: one over a roster, the contract Count over integer, a plain integer, or the uuid a selected containment
 * refers by. */
export type FieldSketch =
	| RosterField
	| { readonly name: string; readonly kind: "count" | "plain" | "ref" }

interface RelationSketch {
	readonly name: RelationName
	readonly fields: ReadonlyArray<FieldSketch>
}

/** A law of the world: a containment into a target selected by a constant, or a row check over a set or a closed id. */
type LawSketch =
	| {
			readonly kind: "selected"
			readonly source: RelationName
			readonly ref: string
			readonly target: RelationName
			readonly selector: RosterField
			readonly handle: string
	  }
	| {
			readonly kind: "check"
			readonly relation: RelationName
			readonly field: RosterField
			readonly handles: Arr.NonEmptyReadonlyArray<string>
	  }

/** A selected containment of the world. */
type SelectedLaw = Extract<LawSketch, { readonly kind: "selected" }>

/** A role: the relations it holds whole, which it reads, and those of them it writes. */
interface RoleSketch {
	readonly name: RoleName
	readonly holds: Arr.NonEmptyReadonlyArray<RelationName>
	readonly writes: ReadonlyArray<RelationName>
}

/** A roster: its name and its handles. */
interface RosterSketch {
	readonly name: RosterName
	readonly handles: Arr.NonEmptyReadonlyArray<string>
}

export interface ExecutesWorld {
	readonly rosters: Arr.NonEmptyReadonlyArray<RosterSketch>
	readonly relations: Arr.NonEmptyReadonlyArray<RelationSketch>
	readonly laws: ReadonlyArray<LawSketch>
	readonly roles: Arr.NonEmptyReadonlyArray<RoleSketch>
}

const rosterNames: Arr.NonEmptyReadonlyArray<RosterName> = ["Flag", "Kind"]
const relationNames: Arr.NonEmptyReadonlyArray<RelationName> = ["Item", "Part", "Note"]
const roleNames: Arr.NonEmptyReadonlyArray<RoleName> = ["clerk", "keeper"]
const handleNames: Arr.NonEmptyReadonlyArray<string> = ["red", "blue", "green"]
const rosterKinds: Arr.NonEmptyReadonlyArray<RosterField["kind"]> = ["code", "set"]

/** The kinds of a relation's own fields: every kind but a ref, which a selected containment brings. */
type OwnKind = Exclude<FieldSketch["kind"], "ref">

const ownKinds: Arr.NonEmptyReadonlyArray<OwnKind> = ["code", "set", "count", "plain"]

/** A relation's own field as drawn, before its name: its kind, and a roster for a kind over one. */
type OwnFieldDraw =
	| { readonly kind: RosterField["kind"]; readonly roster: RosterName }
	| { readonly kind: Exclude<OwnKind, RosterField["kind"]> }

/** An own field of a drawn kind, a closed id or a set over a drawn roster. */
const ownFieldGen =
	(rosters: Arr.NonEmptyReadonlyArray<RosterName>): Gen<OwnFieldDraw> =>
	(source) => {
		const kind = source.draw(element(ownKinds))
		switch (kind) {
			case "code":
			case "set":
				return { kind, roster: source.draw(element(rosters)) }
			case "count":
			case "plain":
				return { kind }
		}
	}

/** A relation's own fields: one to four, named for their kind and position. */
const fieldsGen =
	(rosters: Arr.NonEmptyReadonlyArray<RosterName>): Gen<ReadonlyArray<FieldSketch>> =>
	(source) =>
		Arr.map(source.draw(array(ownFieldGen(rosters), { min: 1, max: 4 })), (f, i): FieldSketch => ({
			...f,
			name: `${f.kind}${i}`
		}))

/** A selected containment as drawn: the two relations it joins, its selector's kind and roster, and the handle it
 * selects. */
interface SelectedDraw {
	readonly source: RelationName
	readonly target: RelationName
	readonly kind: RosterField["kind"]
	readonly roster: RosterName
	readonly handle: string
}

/** A selected containment between one of `pairs`, by a closed id or a set over a drawn roster equal to a drawn handle. */
const selectedGen =
	(
		pairs: Arr.NonEmptyReadonlyArray<{
			readonly source: RelationName
			readonly target: RelationName
		}>,
		rosters: Arr.NonEmptyReadonlyArray<RosterSketch>
	): Gen<SelectedDraw> =>
	(source) => {
		const pair = source.draw(element(pairs))
		const kind = source.draw(element(rosterKinds))
		const roster = source.draw(element(rosters))
		return { ...pair, kind, roster: roster.name, handle: source.draw(element(roster.handles)) }
	}

/** A role that holds a drawn subset of `relations` whole and writes a drawn subset of those, none included. */
const holdingRoleGen =
	(name: RoleName, relations: Arr.NonEmptyReadonlyArray<RelationName>): Gen<RoleSketch> =>
	(source) => {
		const holds = nonEmpty(
			source.draw(subset(relations, { min: 1, max: relations.length })),
			"a role holds a relation at least"
		)
		return { name, holds, writes: source.draw(subset(holds, { min: 0, max: holds.length })) }
	}

/** A role that holds and writes one selected containment's source alone, and reads none of its targets. */
const sourceWriterGen =
	(name: RoleName, sources: Arr.NonEmptyReadonlyArray<RelationName>): Gen<RoleSketch> =>
	(source) => {
		const only = source.draw(element(sources))
		return { name, holds: [only], writes: [only] }
	}

/** The handles of the roster `roster` of `rosters`. */
const handlesOf = (
	rosters: ExecutesWorld["rosters"],
	roster: RosterName
): Arr.NonEmptyReadonlyArray<string> =>
	defined(
		Option.getOrUndefined(Arr.findFirst(rosters, (r) => r.name === roster)),
		`the roster ${roster}`
	).handles

/**
 * A world: one or two rosters of two or three handles; two or three relations of their own fields; one or two selected
 * containments between them, each bringing its own fields, a ref on its source and its selector on its target; checks
 * over the sets and closed ids; one or two roles, each holding a drawn subset of the relations whole and writing a drawn
 * subset of those, none included, or writing one containment's source alone. A source writer of a containment selected
 * by a set that holds no other set over its roster writes a cast into a domain it holds no USAGE on, which only its
 * table's casts reach.
 */
export const executesWorldGen: Gen<ExecutesWorld> = (source) => {
	const rosters = nonEmpty(
		Arr.map(source.draw(subset(rosterNames, { min: 1, max: 2 })), (name): RosterSketch => ({
			name,
			handles: nonEmpty(
				source.draw(subset(handleNames, { min: 2, max: 3 })),
				"a roster of two or three handles"
			)
		})),
		"one roster at least"
	)
	const rosterList = Arr.map(rosters, (r) => r.name)
	const own = nonEmpty(
		Arr.map(source.draw(subset(relationNames, { min: 2, max: 3 })), (name) => ({
			name,
			fields: source.draw(fieldsGen(rosterList))
		})),
		"two relations at least"
	)
	const relationList = Arr.map(own, (r) => r.name)
	const pairs = nonEmpty(
		Arr.flatMap(relationList, (s) =>
			Arr.flatMap(relationList, (t) => (s === t ? [] : [{ source: s, target: t }]))
		),
		"two relations make a pair"
	)
	const selected = Arr.map(
		nonEmpty(
			source.draw(array(selectedGen(pairs, rosters), { min: 1, max: 2 })),
			"one selected containment at least"
		),
		(d, i): SelectedLaw => ({
			kind: "selected",
			source: d.source,
			ref: `ref${i}`,
			target: d.target,
			selector: { name: `selector${i}`, kind: d.kind, roster: d.roster },
			handle: d.handle
		})
	)
	const relations = Arr.map(own, (r) => ({
		name: r.name,
		fields: [
			...r.fields,
			...Arr.flatMap(selected, (l): ReadonlyArray<FieldSketch> =>
				l.source === r.name ? [{ name: l.ref, kind: "ref" }] : []
			),
			...Arr.flatMap(selected, (l): ReadonlyArray<FieldSketch> =>
				l.target === r.name ? [l.selector] : []
			)
		]
	}))
	const checked = Arr.flatMap(relations, (r) =>
		Arr.flatMap(r.fields, (field) =>
			field.kind === "code" || field.kind === "set" ? [{ relation: r.name, field }] : []
		)
	)
	const laws: Array<LawSketch> = [...selected]
	for (const c of source.draw(subset(checked, { min: 0, max: checked.length }))) {
		laws.push({
			kind: "check",
			...c,
			handles: nonEmpty(
				source.draw(subset(handlesOf(rosters, c.field.roster), { min: 1, max: 2 })),
				"a check's handles"
			)
		})
	}
	const sources = Arr.map(selected, (l) => l.source)
	const roles = nonEmpty(
		Arr.map(source.draw(subset(roleNames, { min: 1, max: 2 })), (name) =>
			source.draw(
				weighted([
					[1, holdingRoleGen(name, relationList)],
					[1, sourceWriterGen(name, sources)]
				])
			)
		),
		"one role at least"
	)
	return { rosters, relations, laws, roles }
}

/** The contract every count field is typed by: an integer above zero. */
const Count = contract("Count", pg.integer, (x) => x.gt(0))

/**
 * The world built through the public builders under the declared name `name`: its schema and its login `desk`, whose
 * roles hold their drawn relations whole and write their drawn ones.
 */
export const buildExecutesWorld = (w: ExecutesWorld, name: string) => {
	const rosters = new Map(Arr.map(w.rosters, (r) => [r.name, closed(r.name, r.handles)] as const))
	const rosterOf = (n: RosterName) => defined(rosters.get(n), `the roster ${n}`)
	const descriptor = (f: FieldSketch): FieldBase => {
		switch (f.kind) {
			case "code":
				return closedId(rosterOf(f.roster))
			case "set":
				return bits(rosterOf(f.roster))
			case "count":
				return Count
			case "plain":
				return pg.integer
			case "ref":
				return uuid
		}
	}
	const relations = new Map(
		Arr.map(w.relations, (r) => {
			const fields: Record<string, FieldBase> = { id: uuid }
			for (const f of r.fields) {
				fields[f.name] = descriptor(f)
			}
			return [r.name, relation(r.name, fields, ["id"])] as const
		})
	)
	const relationOf = (n: RelationName) => defined(relations.get(n), `the relation ${n}`)
	const constantOf = (f: RosterField, handles: Arr.NonEmptyReadonlyArray<string>) =>
		f.kind === "set" ? Bits.of(rosterOf(f.roster), handles) : rosterOf(f.roster).handle(handles[0])
	const statements = Arr.map(w.laws, (law, i) => {
		switch (law.kind) {
			case "selected":
				return contained(
					on(relationOf(law.source), law.ref),
					on(
						select(relationOf(law.target), (t) =>
							t.eq(
								defined(t[law.selector.name], `the selector ${law.selector.name}`),
								constantOf(law.selector, [law.handle])
							)
						),
						"id"
					)
				)
			case "check":
				return check(`Check${i}`, relationOf(law.relation), (r) =>
					r.ne(
						defined(r[law.field.name], `the checked field ${law.field.name}`),
						constantOf(law.field, law.handles)
					)
				)
		}
	})
	const declared = {
		...Rec.fromEntries(Arr.map([...rosters], ([n, r]) => [n, r] as const)),
		...Rec.fromEntries(Arr.map([...relations], ([n, r]) => [n, r] as const))
	}
	const s = schema(name, Rec.values(declared), statements, [])
	const roles = Arr.map(w.roles, (r) =>
		role(s, r.name, Rec.fromEntries(Arr.map(r.holds, (n) => [n, relationOf(n)] as const)), {
			write: [...r.writes],
			refresh: []
		})
	)
	return { schema: s, rosters, relations, login: login(s, "desk", roles) }
}

/** The installed role of a world's role, as the installation names it. */
export const installedRole = (
	i: Installation,
	name: RoleName
): { readonly role: string; readonly schema: string } =>
	defined(
		Option.getOrUndefined(
			Arr.findFirst(
				Arr.flatMap(i.worlds, (l) => l.roles),
				(r) => r.name === name
			)
		),
		`the installed role ${name}`
	)

/** The constants an installation creates, by name: the functions of no argument a statement may call. */
export const constantsOf = (i: Installation): ReadonlySet<string> =>
	new Set(Arr.flatMap(i.statements, (s) => (s.kind === "createConstant" ? [s.name.name] : [])))

/** The constants `role` is granted EXECUTE on. */
export const grantedConstants = (i: Installation, role: string): ReadonlySet<string> => {
	const constants = constantsOf(i)
	return new Set(
		Arr.flatMap(i.statements, (s) =>
			s.kind === "grant" &&
			s.on.kind === "FUNCTION" &&
			Arr.some(s.privileges, (p) => p === "EXECUTE") &&
			Arr.some(s.to, (g) => g.kind === "role" && g.name === role)
				? Arr.flatMap(s.on.names, (n) => (constants.has(n.name) ? [n.name] : []))
				: []
		)
	)
}

/** The tables `role` writes: those it holds INSERT on, or UPDATE or INSERT on any column of. */
const writtenTables = (i: Installation, role: string): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(i.statements, (s): ReadonlyArray<string> => {
			if (
				s.kind === "grant" &&
				s.on.kind === "TABLE" &&
				Arr.some(s.privileges, (p) => p === "INSERT" || p === "UPDATE") &&
				Arr.some(s.to, (g) => g.kind === "role" && g.name === role)
			) {
				return Arr.map(s.on.names, (n) => n.name)
			}
			return s.kind === "grantColumns" &&
				s.to === role &&
				(s.privilege === "INSERT" || s.privilege === "UPDATE")
				? [s.table.name]
				: []
		})
	)

/**
 * Which casts a reachability follows: every type a statement names, or none a written table's statements name, which
 * reaches only what the role's own statements and its columns' domains do.
 */
type Follow = "every type" | "no written table's types"

/**
 * The constants `role`'s statements evaluate, restated over the installation's statements: from every statement on a
 * table it writes (its CREATE TABLE, every ALTER TABLE and every CREATE INDEX on it), its views, its policies'
 * predicates, the domains it holds USAGE on and every closed relation's constants, each constant a statement calls and
 * each domain it names (a column's type, a cast's or a literal's), and through each, a constant's body and a domain's
 * base type and CHECKs.
 */
export const reachableConstants = (
	i: Installation,
	installed: { readonly role: string; readonly schema: string },
	follow: Follow
): ReadonlySet<string> => {
	const schema = i.names.schema
	const constants = new Map(
		Arr.flatMap(i.statements, (s) =>
			s.kind === "createConstant" ? [[s.name.name, s] as const] : []
		)
	)
	const domains = new Map(
		Arr.flatMap(i.statements, (s) => (s.kind === "createDomain" ? [[s.name.name, s] as const] : []))
	)
	const reached = new Set<string>()
	const seenDomains = new Set<string>()
	const pending: Array<SqlStatement> = []
	const constant = (name: string): void => {
		const statement = constants.get(name)
		if (statement === undefined || reached.has(name)) {
			return
		}
		reached.add(name)
		pending.push(statement)
	}
	const domain = (name: string): void => {
		const statement = domains.get(name)
		if (statement === undefined || seenDomains.has(name)) {
			return
		}
		seenDomains.add(name)
		pending.push(statement)
	}
	const hooks = (types: boolean): AstHooks => ({
		...identityHooks,
		functionRef: (fn) => {
			if (fn.schema === schema) {
				constant(fn.name)
			}
			return fn
		},
		typeRef: (type) => {
			if (types && type.kind === "named" && type.schema === schema) {
				domain(type.name)
			}
			return type
		}
	})
	const written = writtenTables(i, installed.role)
	const onWritten = Arr.filter(
		i.statements,
		(s) =>
			(s.kind === "createTable" || s.kind === "alterTable" || s.kind === "createIndex") &&
			s.table.schema === schema &&
			written.has(s.table.name)
	)
	const views = Arr.filter(
		i.statements,
		(s) => s.kind === "createView" && s.name.schema === installed.schema
	)
	const predicates: ReadonlyArray<Expr> = Arr.flatMap(i.statements, (s) =>
		s.kind === "createPolicy" && s.role === installed.role ? [s.filter] : []
	)
	for (const s of i.statements) {
		if (
			s.kind === "grant" &&
			s.on.kind === "DOMAIN" &&
			Arr.some(s.to, (g) => g.kind === "role" && g.name === installed.role)
		) {
			for (const d of s.on.names) {
				domain(d.name)
			}
		}
	}
	for (const r of Rec.values(i.owned.relations)) {
		if (r.kind === "closedRelation") {
			for (const f of i.names.closed(r.name).functions) {
				constant(f.name)
			}
		}
	}
	const every = hooks(true)
	for (const s of onWritten) {
		transformStatement(s, hooks(follow === "every type"))
	}
	for (const s of views) {
		transformStatement(s, every)
	}
	for (const p of predicates) {
		transformExpr(p, every)
	}
	for (let s = pending.pop(); s !== undefined; s = pending.pop()) {
		transformStatement(s, every)
	}
	return reached
}
