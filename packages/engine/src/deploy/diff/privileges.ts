/**
 * Privileges as a migration changes them: one privilege of one grantee on one object at a time.
 *
 * An installation states its privileges as GRANT statements, each of several privileges on several objects to several
 * grantees, and PostgreSQL holds them as one privilege of one grantee on one object (an ACL item's bit). A migration
 * grants what the target holds and the previous installation did not, and revokes what the previous installation held
 * and the target does not, each such unit alone (HeldPrivilege), so a grant both hold is neither revoked nor granted,
 * whatever else either states beside it, and a statement that changes one object's grants touches that object alone.
 */
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type {
	FunctionName,
	Grant,
	Grantee,
	GrantObjects,
	ObjectName,
	Privilege
} from "#compiler/sql/ast.ts"

/** One object a GRANT names: of a kind and one name, or the current database, the one object of its kind. */
export type GrantObject =
	| { readonly kind: "TABLE" | "SEQUENCE" | "DOMAIN" | "TYPE"; readonly name: ObjectName }
	| { readonly kind: "FUNCTION"; readonly name: FunctionName }
	| { readonly kind: "SCHEMA"; readonly name: string }
	| { readonly kind: "DATABASE" }

/** An object's key: its kind and its name's canonical text, a function's with its argument types. */
export const objectKey = (o: GrantObject): string =>
	o.kind === "DATABASE" ? "DATABASE" : `${o.kind}\u0000${canonicalTextOf(o.name)}`

/** One privilege of one grantee on one object, by its key, the unit a migration grants and revokes. */
export interface HeldPrivilege {
	readonly key: string
	readonly object: GrantObject
	readonly privilege: Privilege
	readonly grantee: Grantee
}

/** A grantee's key: a role's name, or PUBLIC. */
const granteeKey = (g: Grantee): string => (g.kind === "role" ? `role\u0000${g.name}` : "PUBLIC")

const heldKey = (object: GrantObject, privilege: Privilege, grantee: Grantee): string =>
	`${objectKey(object)}\u0001${privilege}\u0001${granteeKey(grantee)}`

/** The objects a GRANT names, one by one. */
const objectsOf = (on: GrantObjects): NonEmptyReadonlyArray<GrantObject> => {
	switch (on.kind) {
		case "TABLE":
		case "SEQUENCE":
		case "DOMAIN":
		case "TYPE": {
			const kind = on.kind
			const [first, ...rest] = on.names
			return [{ kind, name: first }, ...rest.map((name) => ({ kind, name }))]
		}
		case "FUNCTION": {
			const [first, ...rest] = on.names
			return [
				{ kind: "FUNCTION", name: first },
				...rest.map((name): GrantObject => ({ kind: "FUNCTION", name }))
			]
		}
		case "SCHEMA": {
			const [first, ...rest] = on.names
			return [
				{ kind: "SCHEMA", name: first },
				...rest.map((name): GrantObject => ({ kind: "SCHEMA", name }))
			]
		}
		case "DATABASE":
			return [{ kind: "DATABASE" }]
	}
}

/** The objects `objects` of the kind of `on`, named again as a GRANT names them: none where none is of that kind. */
const namedAs = (
	on: GrantObjects,
	objects: NonEmptyReadonlyArray<GrantObject>
): GrantObjects | undefined => {
	switch (on.kind) {
		case "TABLE":
		case "SEQUENCE":
		case "DOMAIN":
		case "TYPE": {
			const kind = on.kind
			const names = objects.flatMap((o) => (o.kind === kind ? [o.name] : []))
			return isNonEmpty(names) ? { kind, names } : undefined
		}
		case "FUNCTION": {
			const names = objects.flatMap((o) => (o.kind === "FUNCTION" ? [o.name] : []))
			return isNonEmpty(names) ? { kind: "FUNCTION", names } : undefined
		}
		case "SCHEMA": {
			const names = objects.flatMap((o) => (o.kind === "SCHEMA" ? [o.name] : []))
			return isNonEmpty(names) ? { kind: "SCHEMA", names } : undefined
		}
		case "DATABASE":
			return on
	}
}

/** Every privilege a GRANT states, one per grantee, privilege and object. */
export const heldOf = (g: Grant): ReadonlyArray<HeldPrivilege> =>
	g.to.flatMap((grantee) =>
		objectsOf(g.on).flatMap((object) =>
			g.privileges.map((privilege) => ({
				key: heldKey(object, privilege, grantee),
				object,
				privilege,
				grantee
			}))
		)
	)

/**
 * The GRANTs of exactly the privileges of `statements` that `kept` keeps, in the order the statements state them: a
 * statement that keeps every privilege it states as it is, so a draft from the empty snapshot runs the installation's
 * own statements; any other cut, for each of its grantees, to the objects that keep a privilege, those that keep the
 * same privileges named together, in the statement's order.
 */
export const cutGrants = (
	statements: ReadonlyArray<Grant>,
	kept: (h: HeldPrivilege) => boolean
): ReadonlyArray<Grant> =>
	statements.flatMap((g): ReadonlyArray<Grant> => (heldOf(g).every(kept) ? [g] : cut(g, kept)))

/** A statement cut to the privileges `kept` keeps of it, one statement per grantee and per set of privileges its
 * objects keep, in the statement's order. */
const cut = (g: Grant, kept: (h: HeldPrivilege) => boolean): ReadonlyArray<Grant> =>
	g.to.flatMap((grantee): ReadonlyArray<Grant> => {
		const groups = new Map<string, { privileges: Array<Privilege>; objects: Array<GrantObject> }>()
		for (const object of objectsOf(g.on)) {
			const privileges = g.privileges.filter((privilege) =>
				kept({ key: heldKey(object, privilege, grantee), object, privilege, grantee })
			)
			if (privileges.length === 0) {
				continue
			}
			const key = privileges.join("\u0000")
			const group = groups.get(key) ?? { privileges, objects: [] }
			group.objects.push(object)
			groups.set(key, group)
		}
		return [...groups.values()].flatMap(({ privileges, objects }): ReadonlyArray<Grant> => {
			const on = isNonEmpty(objects) ? namedAs(g.on, objects) : undefined
			return isNonEmpty(privileges) && on !== undefined
				? [{ kind: "grant", privileges, on, to: [grantee] }]
				: []
		})
	})
