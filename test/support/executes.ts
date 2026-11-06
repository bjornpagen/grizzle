import { array, element, type Gen, subset } from "@grizzle/testing/gen"
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
 * - A selected containment `contained(on(S, ref), on(select(T, (t) => t.eq(t.sel, constant)), "id"))` places T's
 *   constant on S as a generated law column typed by sel's domain, a roster's or a set's, so S's table casts into a
 *   domain none of S's fields is typed by.
 * - A check over a set field compares it with a set value, `ne(field, Bits.of(roster, handles))`, a literal cast into
 *   the set's domain; over a closed id it compares with a handle.
 */
type RosterName = "Flag" | "Kind"
type RelationName = "Item" | "Part" | "Note"
type RoleName = "clerk" | "keeper"

/** A field's kind: a closed id, a set, the contract Count over integer, a plain integer, or a uuid that refers. */
type FieldKind = "code" | "set" | "count" | "plain" | "ref"

export interface FieldSketch {
	readonly name: string
	readonly kind: FieldKind
	readonly roster: RosterName
}

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
			readonly selector: FieldSketch
			readonly handle: string
	  }
	| {
			readonly kind: "check"
			readonly relation: RelationName
			readonly field: FieldSketch
			readonly handles: Arr.NonEmptyReadonlyArray<string>
	  }

/** A role: the relations it holds whole, which it reads, and those of them it writes. */
interface RoleSketch {
	readonly name: RoleName
	readonly holds: Arr.NonEmptyReadonlyArray<RelationName>
	readonly writes: ReadonlyArray<RelationName>
}

export interface ExecutesWorld {
	readonly rosters: ReadonlyArray<{
		readonly name: RosterName
		readonly handles: Arr.NonEmptyReadonlyArray<string>
	}>
	readonly relations: Arr.NonEmptyReadonlyArray<RelationSketch>
	readonly laws: ReadonlyArray<LawSketch>
	readonly roles: Arr.NonEmptyReadonlyArray<RoleSketch>
}

const rosterNames: Arr.NonEmptyReadonlyArray<RosterName> = ["Flag", "Kind"]
const relationNames: Arr.NonEmptyReadonlyArray<RelationName> = ["Item", "Part", "Note"]
const roleNames: Arr.NonEmptyReadonlyArray<RoleName> = ["clerk", "keeper"]
const handleNames: Arr.NonEmptyReadonlyArray<string> = ["red", "blue", "green"]
const fieldKinds: Arr.NonEmptyReadonlyArray<FieldKind> = ["code", "set", "count", "plain", "ref"]

/** The fields of a relation: one to four, each a drawn kind over a drawn roster, named for its kind and position. */
const fieldsGen =
	(rosters: Arr.NonEmptyReadonlyArray<RosterName>): Gen<ReadonlyArray<FieldSketch>> =>
	(source) =>
		Arr.map(
			source.draw(
				array((s) => ({ kind: s.draw(element(fieldKinds)), roster: s.draw(element(rosters)) }), {
					min: 1,
					max: 4
				})
			),
			(f, i): FieldSketch => ({ name: `${f.kind}${i}`, kind: f.kind, roster: f.roster })
		)

/**
 * A world: one or two rosters of two or three handles; one to three relations; laws drawn among those the relations
 * admit, a selected containment from each relation's refs into another relation selected by a closed id or a set,
 * and checks over the sets and closed ids; one or two roles, each holding a drawn subset of the relations whole and
 * writing a drawn subset of those, none included, so a role writes a relation whose laws cast into a domain no
 * relation it holds is typed by.
 */
export const executesWorldGen: Gen<ExecutesWorld> = (source) => {
	const rosters = Arr.map(source.draw(subset(rosterNames, { min: 1, max: 2 })), (name) => ({
		name,
		handles: nonEmpty(
			source.draw(subset(handleNames, { min: 2, max: 3 })),
			"a roster of two or three handles"
		)
	}))
	const rosterList = nonEmpty(
		Arr.map(rosters, (r) => r.name),
		"one roster at least"
	)
	const handlesOf = (roster: RosterName): Arr.NonEmptyReadonlyArray<string> =>
		defined(
			Option.getOrUndefined(Arr.findFirst(rosters, (r) => r.name === roster)),
			`the roster ${roster}`
		).handles
	const relations = nonEmpty(
		Arr.map(source.draw(subset(relationNames, { min: 1, max: 3 })), (name) => ({
			name,
			fields: source.draw(fieldsGen(rosterList))
		})),
		"one relation at least"
	)
	const selectors = (t: RelationSketch): ReadonlyArray<FieldSketch> =>
		Arr.filter(t.fields, (f: FieldSketch) => f.kind === "code" || f.kind === "set")
	const selected: ReadonlyArray<
		Omit<Extract<LawSketch, { readonly kind: "selected" }>, "kind" | "handle">
	> = Arr.flatMap(relations, (s: RelationSketch) =>
		Arr.flatMap(
			Arr.filter(s.fields, (f: FieldSketch) => f.kind === "ref"),
			(ref: FieldSketch) =>
				Arr.flatMap(
					Arr.filter(relations, (t: RelationSketch) => t.name !== s.name),
					(t: RelationSketch) =>
						Arr.map(selectors(t), (selector: FieldSketch) => ({
							source: s.name,
							ref: ref.name,
							target: t.name,
							selector
						}))
				)
		)
	)
	const checked = Arr.flatMap(relations, (r) =>
		Arr.map(
			Arr.filter(r.fields, (f) => f.kind === "code" || f.kind === "set"),
			(field) => ({ relation: r.name, field })
		)
	)
	const laws: Array<LawSketch> = []
	for (const s of source.draw(subset(selected, { min: 0, max: selected.length }))) {
		laws.push({
			kind: "selected",
			...s,
			handle: source.draw(element(handlesOf(s.selector.roster)))
		})
	}
	for (const c of source.draw(subset(checked, { min: 0, max: checked.length }))) {
		laws.push({
			kind: "check",
			...c,
			handles: nonEmpty(
				source.draw(subset(handlesOf(c.field.roster), { min: 1, max: 2 })),
				"a check's handles"
			)
		})
	}
	const roles = nonEmpty(
		Arr.map(source.draw(subset(roleNames, { min: 1, max: 2 })), (name) => {
			const holds = nonEmpty(
				source.draw(
					subset(
						Arr.map(relations, (r) => r.name),
						{ min: 1, max: relations.length }
					)
				),
				"a role holds a relation at least"
			)
			return { name, holds, writes: source.draw(subset(holds, { min: 0, max: holds.length })) }
		}),
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
	const constantOf = (f: FieldSketch, handles: Arr.NonEmptyReadonlyArray<string>) =>
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
	const s = schema(name, declared, statements, [])
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
