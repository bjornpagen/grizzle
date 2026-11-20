/** What the properties of search-policy.test.ts read: its spaces, models and helpers. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import { array, boolean, constant, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Option, Order, pipe, String as Str } from "effect"
import { login } from "#compiler/program/workload/login.ts"
import { Logic, Text } from "#compiler/public/compute.ts"
import { contract, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import { fixedDefaults, searchDefaults } from "#test/support/catalog/installed.ts"
import { Id } from "#test/support/ids.ts"
import { whereIndex } from "#test/support/oracle/pick.ts"

const Slug = str.regex("^[a-z]{1,8}$")

const State = str.regex("^(on|off)$")

/** A contract over a refined text: its domain rests on the text's, a base chain of two domains of the schema. */
const Handle = contract("Handle", Slug, (x) => Logic.le(Text.charLength(x), 6))

const Doc = relation("Doc", { id: Id, slug: Slug, handle: Handle }, ["id"])

const Embedding = relation("Embedding", { doc: Id, value: pg.vector(3) }, ["doc"])

const Tag = relation("Tag", { doc: Id, state: State }, ["doc"])

/** The schema under `name`: the stored relations, and Vectors in a level that extends them. */
export const searchAt = (name: string) => {
	const core = schema(name, [Doc, Embedding, Tag], [])
	const Vectors = derived.materialized(
		"Vectors",
		query(core).rule((r) => {
			const { doc, value } = v(Embedding, "embedding")
			return r.match(Embedding, { doc, value }).find({ doc, value })
		})
	)
	return schema.extend(core, `${name}_1`, [Vectors], [])
}

type SearchSchema = ReturnType<typeof searchAt>

const readable = ["Doc", "Embedding", "Tag", "Vectors"] as const

type Readable = (typeof readable)[number]

const stored = ["Doc", "Embedding", "Tag"] as const

type Stored = (typeof stored)[number]

const loginNames = ["alpha", "beta"] as const

type LoginName = (typeof loginNames)[number]

/** A role's scope: what it holds whole, writes and refreshes. */
interface Scope {
	readonly holds: ReadonlyArray<Readable>
	readonly writes: ReadonlyArray<Stored>
	readonly refreshes: boolean
}

/** Whether a role reaches the vector type: Embedding's own column, or the derived relation's over it. */
export const reaches = (s: Scope): boolean =>
	s.holds.includes("Embedding") || s.holds.includes("Vectors")

/** A role drawn: its scope's masks and its login. */
interface RoleDraw {
	readonly holds: number
	readonly writes: number
	readonly refreshes: boolean
	readonly login: LoginName
}

const roleDrawGen =
	(vectorFree: boolean): Gen<RoleDraw> =>
	(source) => ({
		/** A vector-free draw holds Doc or Tag alone (bits 0 and 2). */
		holds: source.draw(vectorFree ? element<number>([1, 4, 5]) : int(1, 15)),
		writes: source.draw(int(0, 7)),
		refreshes: source.draw(boolean),
		login: source.draw(element(loginNames))
	})

const scopeOf = (d: RoleDraw): Scope => {
	const holds = whereIndex(readable, (i) => (d.holds & (1 << i)) !== 0)
	return {
		holds,
		writes: Arr.filter(stored, (r, i) => (d.writes & (1 << i)) !== 0 && holds.includes(r)),
		refreshes: d.refreshes && holds.includes("Vectors")
	}
}

/** Each login with its roles' scopes, a login no role is drawn into left out. */
interface SearchCase {
	readonly logins: ReadonlyArray<{
		readonly name: LoginName
		readonly scopes: ReadonlyArray<Scope>
	}>
}

/** Three roles; planted, one draw in four, none reaching the vector type. */
export const caseGen: Gen<SearchCase> = (source) => {
	const vectorFree = source.draw(
		weighted([
			[3, constant(false)],
			[1, constant(true)]
		])
	)
	const roleDraw = roleDrawGen(vectorFree)
	const draws = [source.draw(roleDraw), source.draw(roleDraw), source.draw(roleDraw)]
	return {
		logins: Arr.flatMap(loginNames, (name) => {
			const scopes = Arr.map(
				Arr.filter(draws, (d) => d.login === name),
				scopeOf
			)
			return scopes.length === 0 ? [] : [{ name, scopes }]
		})
	}
}

/** The worlds of `logins` over `base`: each scope a role `<login>_<n>`. */
export const worldsOf = (base: SearchSchema, logins: SearchCase["logins"]) =>
	Arr.map(logins, (l) => {
		const roles = Arr.map(l.scopes, (s, n) => {
			const entries: Record<string, EntryValue> = {}
			for (const r of s.holds) {
				entries[r] = base.relations[r]
			}
			return role(base, `${l.name}_${n}`, entries, {
				write: [...s.writes],
				refresh: s.refreshes ? ["Vectors"] : []
			})
		})
		const [first, ...rest] = roles
		if (first === undefined) {
			throw new Error(`the login ${l.name} has no role`)
		}
		return {
			name: l.name,
			reaches: Arr.some(l.scopes, reaches),
			value: login(base, l.name, [first, ...rest])
		}
	})

/**
 * The defaults a login stores: the fixed ones, and the search policy's when one of its roles reaches the vector type.
 */
export const defaultsOf = (reach: boolean): ReadonlyArray<string> =>
	Arr.sort([...fixedDefaults, ...(reach ? searchDefaults : [])], Order.String)

/** A login's stored defaults for every database, sorted, as the owner reads them. */
export const storedQuery =
	"SELECT x FROM pg_catalog.pg_db_role_setting AS s, unnest(s.setconfig) AS x " +
	"WHERE s.setdatabase = 0 AND s.setrole = (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = $1::text) " +
	"ORDER BY x"

export type SearchFeature =
	| "a role reading a contract over a refined text"
	| "a role writing a contract over a refined text"
	| "a role reaching the vector type through the derived relation alone"
	| "a login none of whose roles reaches the vector type"
	| "a login one of whose roles reaches the vector type"
	| "a refresher of the derived relation"
	| "a reader of the derived relation that does not refresh it"

export const notesOf = (c: SearchCase, cx: Case<SearchFeature>): void => {
	for (const l of c.logins) {
		cx.note(
			Arr.some(l.scopes, reaches)
				? "a login one of whose roles reaches the vector type"
				: "a login none of whose roles reaches the vector type"
		)
		for (const s of l.scopes) {
			if (s.holds.includes("Doc")) {
				cx.note(
					s.writes.includes("Doc")
						? "a role writing a contract over a refined text"
						: "a role reading a contract over a refined text"
				)
			}
			if (s.holds.includes("Vectors") && !s.holds.includes("Embedding")) {
				cx.note("a role reaching the vector type through the derived relation alone")
			}
			if (s.refreshes) {
				cx.note("a refresher of the derived relation")
			} else if (s.holds.includes("Vectors")) {
				cx.note("a reader of the derived relation that does not refresh it")
			}
		}
	}
}

/** Each search default as `[parameter, value]`. */
export const searchPairs: ReadonlyArray<readonly [string, string]> = Arr.map(
	searchDefaults,
	(d) => {
		const at = Option.getOrThrowWith(
			pipe(d, Str.indexOf("=")),
			() => new Error(`the search default ${d} holds an =`)
		)
		return [Str.slice(0, at)(d), Str.slice(at + 1)(d)] as const
	}
)

/** Each login's one role's holdings at a version, as a mask over the readable relations, none empty. */
export interface Holdings {
	readonly alpha: number
	readonly beta: number
}

/** A history of two or three versions. */
export const holdingsHistoryGen: Gen<Arr.NonEmptyReadonlyArray<Holdings>> = (source) =>
	nonEmpty(
		source.draw(
			array((inner) => ({ alpha: inner.draw(int(1, 15)), beta: inner.draw(int(1, 15)) }), {
				min: 2,
				max: 3
			})
		),
		"a history's versions"
	)

/** A role that holds the relations of `mask` whole, and writes and refreshes nothing. */
export const onlyHolding = (mask: number): Scope => ({
	holds: whereIndex(readable, (i) => (mask & (1 << i)) !== 0),
	writes: [],
	refreshes: false
})

/** How a login's reach of the vector type moves from one version to the next. */
export type ReachChange =
	| "gains the policy"
	| "loses the policy"
	| "keeps the policy"
	| "stays without it"

export const reachChanges = (
	history: Arr.NonEmptyReadonlyArray<Holdings>
): ReadonlyArray<ReachChange> =>
	Arr.flatMap(Arr.zip<Holdings, Holdings>(history, Arr.drop(history, 1)), ([was, now]) =>
		Arr.map([was.alpha, was.beta] as const, (mask, i): ReachChange => {
			const before = reaches(onlyHolding(mask))
			const after = reaches(onlyHolding(i === 0 ? now.alpha : now.beta))
			return before
				? after
					? "keeps the policy"
					: "loses the policy"
				: after
					? "gains the policy"
					: "stays without it"
		})
	)
