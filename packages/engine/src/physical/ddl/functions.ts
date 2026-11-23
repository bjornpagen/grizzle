import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type { FunctionNullInput, FunctionVolatility } from "#compiler/core/function.ts"
import { type Identity, identifierOf, identity } from "#compiler/core/identity.ts"
import { compareStrings } from "#compiler/core/order.ts"
import {
	type FieldDesc,
	type FunctionTypeDesc,
	type HeadingDesc,
	nullInputOf
} from "#compiler/ir/desc.ts"
import { baseTypeRef, type RowAttribute, type RowType, rowTypeOf } from "#compiler/ir/physical.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { enforcement, type Node } from "#compiler/physical/obligations/graph.ts"
import type { OwnedFunction } from "#compiler/schema/function-own.ts"
import {
	type CreateDeclaredFunction,
	type DeclaredNullInput,
	type DeclaredVolatility,
	declaredBody,
	type FunctionName,
	type FunctionParam,
	type TypeRef
} from "#compiler/sql/ast.ts"
import { arrayOf, functionNameOf } from "#compiler/sql/build.ts"
import { typeOnSearchPath } from "#compiler/sql/print.ts"
import { installationTypes } from "#compiler/sql/type-schemas.ts"

/**
 * The installation's declared functions (schema/function.ts fn): each a SECURITY DEFINER function of its level's
 * schema, the row types its headings install as, and the installation's function owner, which owns every one of them.
 *
 * - The function owner (identity.functionOwner): CREATE ROLE <owner> NOLOGIN, granted to the migration identity WITH
 *   INHERIT TRUE, SET TRUE (sql/ast.ts AdoptRole), which hands each function to it and replaces or drops each later as
 *   a member of its owner, and USAGE on every level's schema, where its functions call each other and name their row
 *   types: it holds no privilege on any table or view, so a declared function, which runs as its owner, reads no
 *   relation, and a body that reads one fails as it runs, 42501 permission denied, wherever it is called.
 * - Each heading a function's signature names (rows()), and each heading a field of one names, once per level that
 *   declares a function over it: CREATE TYPE <level>.<row type> AS (<attributes>), its attributes in its heading's
 *   order, code point order of the fields' names (schema/function.ts byName), named by its definition's digest
 *   (identity.rowType), each value attribute its field's base type, text collated as every grizzle column is
 *   (ir/physical.ts lawColumnType), a field of rows an array of its heading's row type and a field of one row (row())
 *   that row type, each created before the row types that hold it; USAGE revoked from PUBLIC. A function's argument of
 *   rows is an array of it, its result of rows a set of it, and an argument or a result of one row the row type itself.
 * - Each function: CREATE OR REPLACE FUNCTION <level>.<name>(<arguments>), its parameters in code point order of the
 *   arguments' names (schema/function.ts byName), RETURNS <type> | SETOF <row type> LANGUAGE <language> <volatility>
 *   [STRICT, a strict function's] SECURITY DEFINER SET search_path = pg_catalog, <level>, pg_temp AS <body>, the body byte for byte but for each
 *   heading it names, which is its row type's name alone, the one the pinned search_path resolves
 *   (sql/print.ts typeOnSearchPath), and which the function's object depends on (sql/ast.ts CreateDeclaredFunction);
 *   EXECUTE revoked from PUBLIC; then handed over to the owner (sql/ast.ts HandOverFunction). A value's type is its field's base type: PostgreSQL holds a function's arguments and result to
 *   their declared types exactly, so a contract's or a pattern's domain is a statement's to check where it reads the
 *   value, never the signature's.
 *
 * Every object is created in Setup, after its level's schema, so a law, a stored table or a world that calls a
 * function finds it, each function after the functions its body calls (`calls`), so PostgreSQL validates an SQL body
 * against its callees as it creates it; no installation that declares no function holds any of them.
 */

/** A declared function as its installation created it: its object, and its name with its argument types, which a
 * GRANT of EXECUTE names. */
export interface InstalledFunction {
	readonly node: Node<"setup">
	readonly name: FunctionName
}

const volatilityClause: { readonly [V in FunctionVolatility]: DeclaredVolatility } = {
	immutable: "IMMUTABLE",
	stable: "STABLE",
	volatile: "VOLATILE"
}

/** A null input's clause: STRICT for a strict function, and none for one called on NULL input, PostgreSQL's default. */
const nullInputClause: { readonly [N in FunctionNullInput]: DeclaredNullInput } = {
	called: undefined,
	strict: "STRICT"
}

/** A row type of one level, its object and the row type, once per definition. */
interface InstalledRowType {
	readonly node: Node<"setup">
	readonly rowType: RowType
}

/** The type a value of `desc` is as an argument or a result: its base type, never a domain. */
const valueType = (b: InstallBuilder, desc: FieldDesc, at: OwnedFunction): TypeRef =>
	baseTypeRef(b.names, b.checked.fieldType(desc, at.desc.loc))

const why = (fn: OwnedFunction) => enforcement(`function ${fn.name}`)

/** The function owner's object: its role, its membership in the migration identity and its USAGE on every level. */
const addOwner = (b: InstallBuilder, owner: Identity<"functionOwner">): Node<"setup"> => {
	const role = b.name(owner)
	return b.add(
		{
			kind: "functionOwner",
			ident: { kind: "role", name: owner },
			ddl: [
				{ kind: "createRole", name: role, login: false },
				{ kind: "adoptRole", role },
				{
					kind: "grant",
					privileges: ["USAGE"],
					on: { kind: "SCHEMA", names: mapNonEmpty(b.names.levels, identifierOf) },
					to: [{ kind: "role", name: role }]
				}
			],
			reasons: [enforcement(`the owner of schema ${b.owned.name}'s declared functions`)],
			phase: "setup"
		},
		b.levelNodes
	)
}

/**
 * The functions of `owned` with every function's callees before it, each once, by name where none calls another: the
 * order of their creation, a callee first, so an SQL body, which PostgreSQL validates against the functions standing
 * as it creates it, finds each it calls. Ownership refused a cycle (schema/function-own.ts), so every walk ends.
 */
const calleesFirst = (
	functions: Readonly<Record<string, OwnedFunction>>
): ReadonlyArray<OwnedFunction> => {
	const out: Array<OwnedFunction> = []
	const placed = new Set<string>()
	const place = (fn: OwnedFunction): void => {
		if (placed.has(fn.name)) {
			return
		}
		placed.add(fn.name)
		for (const callee of fn.desc.calls) {
			place(defined(functions[callee], `the declared function ${callee} that ${fn.name} calls`))
		}
		out.push(fn)
	}
	for (const fn of Object.values(functions).toSorted((x, y) => compareStrings(x.name, y.name))) {
		place(fn)
	}
	return out
}

/**
 * Every declared function of the installation, each with its row types and, where there is one, the function owner,
 * by the function's declared name, each created after the functions it calls; none, and no object, for an
 * installation that declares none.
 */
export const addFunctions = (b: InstallBuilder): ReadonlyMap<string, InstalledFunction> => {
	const functions = calleesFirst(b.owned.functions)
	const out = new Map<string, InstalledFunction>()
	const [first] = functions
	if (first === undefined) {
		return out
	}
	const ownerIdentity = identity.functionOwner(identifierOf(b.settings.levels[0]))
	const owner = addOwner(b, ownerIdentity)
	const ownerRole = identifierOf(ownerIdentity)
	const rowTypes = new Map<string, InstalledRowType>()
	for (const fn of functions) {
		const level = defined(b.settings.levels[fn.level], `the schema of level ${fn.level}`)
		const levelNode = defined(b.levelNodes[fn.level], `the schema object of level ${fn.level}`)
		const types = installationTypes(level)
		/** What a heading's field holds as an attribute, each row type it holds created first, among `held`. */
		const attributeOf = (t: FunctionTypeDesc, held: Array<Node<"setup">>): RowAttribute => {
			switch (t.kind) {
				case "value":
					return { kind: "value", type: b.checked.fieldType(t.type, fn.desc.loc) }
				case "rows":
				case "row": {
					const inner = rowTypeIn(t.heading)
					held.push(inner.node)
					return { kind: t.kind, rowType: inner.rowType }
				}
			}
		}
		/** The row type of `heading` at this level, created once, after every row type a field of it holds. */
		const rowTypeIn = (heading: HeadingDesc): InstalledRowType => {
			const held: Array<Node<"setup">> = []
			const rowType = rowTypeOf(
				b.names,
				types,
				mapNonEmpty(heading, (f) => ({ name: f.name, type: attributeOf(f.type, held) }))
			)
			const { attributes, named } = rowType
			const key = `${identifierOf(level)}.${identifierOf(named)}`
			const known = rowTypes.get(key)
			if (known !== undefined) {
				return known
			}
			const name = { schema: identifierOf(level), name: b.name(named) }
			const node = b.add(
				{
					kind: "rowType",
					ident: { kind: "type", schema: level, name: named },
					ddl: [
						{ kind: "createRowType", name, attributes },
						{
							kind: "revoke",
							privileges: ["ALL"],
							on: { kind: "TYPE", names: [name] },
							from: [{ kind: "PUBLIC" }]
						}
					],
					reasons: [why(fn)],
					phase: "setup"
				},
				[levelNode, ...held]
			)
			const made = { node, rowType }
			rowTypes.set(key, made)
			return made
		}
		const used: Array<Node<"setup">> = []
		/** The type of the row type of `heading`, which the function's object depends on. */
		const rowType = (heading: HeadingDesc): TypeRef => {
			const made = rowTypeIn(heading)
			used.push(made.node)
			return made.rowType.type
		}
		const argType = (t: FunctionTypeDesc): TypeRef => {
			switch (t.kind) {
				case "value":
					return valueType(b, t.type, fn)
				case "rows":
					return defined(arrayOf(rowType(t.heading)), "the array of a row type")
				case "row":
					return rowType(t.heading)
			}
		}
		const params: ReadonlyArray<FunctionParam> = fn.desc.args.map((a) => ({
			name: a.name,
			type: argType(a.type)
		}))
		const returned = fn.desc.returns
		const returns: CreateDeclaredFunction["returns"] =
			returned.kind === "rows"
				? { setOf: rowType(returned.heading), rows: { kind: "planner" } }
				: argType(returned)
		const body = fn.desc.body.named.reduce(
			(text, next) => `${text}${typeOnSearchPath(rowType(next.rowType))}${next.text}`,
			fn.desc.body.text
		)
		const callees = fn.desc.calls.map(
			(callee) => defined(out.get(callee), `the function ${callee}, created before ${fn.name}`).node
		)
		const fnName = { schema: identifierOf(level), name: b.name(fn.named) }
		const signature = functionNameOf({ name: fnName, params })
		const node = b.add(
			{
				kind: "declaredFunction",
				ident: { kind: "function", schema: level, name: fn.named },
				ddl: [
					{
						kind: "createDeclaredFunction",
						name: fnName,
						params,
						returns,
						language: fn.desc.language,
						volatility: volatilityClause[fn.desc.volatility],
						nullInput: nullInputClause[nullInputOf(fn.desc)],
						body: declaredBody(body)
					},
					{
						kind: "revoke",
						privileges: ["ALL"],
						on: { kind: "FUNCTION", names: [signature] },
						from: [{ kind: "PUBLIC" }]
					},
					{ kind: "handOverFunction", name: signature, owner: ownerRole }
				],
				reasons: [why(fn)],
				phase: "setup"
			},
			[levelNode, owner, ...used, ...callees]
		)
		out.set(fn.name, { node, name: signature })
	}
	return out
}
