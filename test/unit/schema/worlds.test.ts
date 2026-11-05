import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import type { LoginRule, RoleRule } from "#compiler/core/causes.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { decodeDesc, type RoleDesc } from "#compiler/ir/desc.ts"
import { lowerQuery } from "#compiler/program/describe.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, derived, relation, schema } from "#compiler/public/schema.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { ownLogin, ownRole } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import {
	admitContext,
	admitRole,
	context,
	login,
	role,
	roleDescOf
} from "#compiler/schema/world.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyRole } from "#compiler/types/schema/world.ts"
import { assert, refused, succeeded, throwsRefused } from "#test/support/assert.ts"
import { queryFromDesc } from "#test/support/describe.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	bareContract,
	descOf,
	rawClosedId,
	rawPg,
	rawSpan,
	regex
} from "#test/unit/schema/support.ts"

/**
 * The world builders' admission (context, role, login) and ownership of their decoded descriptions (ownRole,
 * ownLogin), against the rules of roles (the worlds proposal, section 3) restated as the oracle:
 *
 * - a context's fields are claims of scalar types: text, uuid, boolean, the integer types, a contract over one of them,
 *   or a closed handle;
 * - a role relation is a whole relation of the base under its own name, or a query built over the base or one of its
 *   levels that reads only the base's relations, reads no parameter, attaches nothing, searches nothing approximately
 *   and is a Query, not an Ordered;
 * - a role writes whole ordinary relations and query entries the writable-entry rule admits (one occurrence of an
 *   ordinary relation supplying every head field, every other field of it fixed to a literal or a context field), at
 *   most one per base relation, and refreshes derived whole entries;
 * - a login's roles share its base, are named apart from it and from each other, and each role is in exactly one login.
 *
 * Every case plants at most one defect beside the declaration a healthy twin holds: a planted defect is refused as
 * MalformedDescription, where the builder admits its arguments and again where ownership owns a description no
 * builder checked, each by the rule the defect breaks (the rule its refusal states as required); the twin is admitted
 * by both.
 */
const Kind = closed("Kind", ["Draft", "Live"])
const Author = regex("^user_[a-z]{1,8}$", "u")
const Post = relation(
	"Post",
	{ id: uuid, author: Author, kind: rawClosedId(Kind), words: pg.integer },
	["id"]
)
const Note = relation("Note", { id: uuid, post: uuid }, ["id"])
const Doc = relation("Doc", { id: uuid, a: pg.vector(3), b: pg.vector(3) }, ["id"])
const Blog = schema("Blog", { Kind, Post, Note, Doc }, [])
const Counts = derived(
	"Counts",
	query(Blog).rule((r) => {
		const { id, author } = v(Post, "post")
		return r.match(Post, { id, author }).find({ author, posts: r.count() })
	})
)
const Reports = schema.extend(Blog, { Counts }, [])
const Stray = relation("Stray", { id: uuid }, ["id"])
const Other = schema("Other", { Kind, Post, Stray }, [])
const Session = context("Session", { sub: Author })

/** The member's own posts: Post's one occurrence supplies the head, its author fixed to the session's claim. */
const mine = query(Reports).rule((r) => {
	const { id, author, kind, words } = v(Post, "post")
	return r
		.match(Post, { id, author, kind, words })
		.match(Session, { sub: author })
		.find({ id, kind, words })
})

/** Every post's id and words: author and kind are neither in the head nor fixed, so no insert could fill them. */
const unfixed = query(Reports).rule((r) => {
	const { id, words } = v(Post, "post")
	return r.match(Post, { id, words }).find({ id, words })
})

const ofAuthor = query(Reports).rule((r) => {
	const { id } = v(Post, "post")
	return r.match(Post, { id, author: r.param("author", Author) }).find({ id })
})

const withNotes = query(Reports)
	.rule((r) => {
		const { id } = v(Post, "post")
		return r.match(Post, { id }).find({ id })
	})
	.attach(
		"notes",
		(p) =>
			query(Reports).rule((r) => {
				const { id } = v(Note, "note")
				return r.match(Note, { id, post: p.id }).find({ id })
			}),
		"array"
	)
const ordered = unfixed.orderBy(["words", "desc"])
const elsewhere = query(Other).rule((r) => {
	const { id } = v(Stray, "stray")
	return r.match(Stray, { id }).find({ id })
})

/** A query over another schema reading only a relation the base declares too: its names pass, its schema does not. */
const otherPosts = query(Other).rule((r) => {
	const { id } = v(Post, "post")
	return r.match(Post, { id }).find({ id })
})
/**
 * A query over the base rebuilt from a Description that reads a relation the base lacks: it carries no schema, so only
 * the names it reads tell it apart.
 */
const strayDescribed = succeeded(queryFromDesc(queryValueDesc(elsewhere), undefined))
/** The nearest documents by the distance between their own two embeddings. */
const nearest = query(Reports)
	.rule((r) => {
		const { id, a, b } = v(Doc, "doc")
		return r.match(Doc, { id, a, b }).find({ id, distance: Compute.cosineDistance(a, b) })
	})
	.approximateNearest({ by: "distance", take: 5 })

/**
 * The healthy role: whole relations of every kind, a writable query entry, a whole ordinary relation written, and the
 * derived relation refreshed.
 */
const healthyEntries = { Kind, Note, Counts, Mine: mine }
const healthyOptions = { write: ["Note", "Mine"], refresh: ["Counts"] }

type RoleDefect =
	| "none"
	| "a whole entry under another name"
	| "a whole entry the base does not declare"
	| "a query entry built over another schema"
	| "a query entry over a relation the base lacks"
	| "a query entry that reads a parameter"
	| "a query entry that attaches"
	| "a query entry that searches approximately"
	| "an Ordered query entry"
	| "a write of no entry"
	| "a write of a closed relation"
	| "a write of a derived relation"
	| "a write of a query entry with an unfixed field"
	| "two writable entries over one relation"
	| "a refresh of an ordinary relation"

const roleDefects: Arr.NonEmptyReadonlyArray<RoleDefect> = [
	"none",
	"a whole entry under another name",
	"a whole entry the base does not declare",
	"a query entry built over another schema",
	"a query entry over a relation the base lacks",
	"a query entry that reads a parameter",
	"a query entry that attaches",
	"a query entry that searches approximately",
	"an Ordered query entry",
	"a write of no entry",
	"a write of a closed relation",
	"a write of a derived relation",
	"a write of a query entry with an unfixed field",
	"two writable entries over one relation",
	"a refresh of an ordinary relation"
]

/** The healthy role, built through the builder. */
const healthyRole = (name: string): AnyRole => role(Reports, name, healthyEntries, healthyOptions)

/**
 * The role a defect plants, built through the builder; an entry no typed caller can pass (an Ordered) through its
 * admission core, as a JavaScript caller reaches it.
 */
const plantedRole = (defect: RoleDefect, name: string): unknown => {
	switch (defect) {
		case "none":
			return healthyRole(name)
		case "a whole entry under another name":
			return role(Reports, name, { ...healthyEntries, Notes: Note }, healthyOptions)
		case "a whole entry the base does not declare":
			return role(Reports, name, { ...healthyEntries, Stray }, healthyOptions)
		case "a query entry built over another schema":
			return admitRole(Reports, name, { ...healthyEntries, Far: otherPosts }, healthyOptions, [])
		case "a query entry over a relation the base lacks":
			return admitRole(
				Reports,
				name,
				{ ...healthyEntries, Far: strayDescribed },
				healthyOptions,
				[]
			)
		case "a query entry that reads a parameter":
			return role(Reports, name, { ...healthyEntries, ByAuthor: ofAuthor }, healthyOptions)
		case "a query entry that attaches":
			return role(Reports, name, { ...healthyEntries, Notes2: withNotes }, healthyOptions)
		case "a query entry that searches approximately":
			return admitRole(Reports, name, { ...healthyEntries, Near: nearest }, healthyOptions, [])
		case "an Ordered query entry":
			return admitRole(Reports, name, { ...healthyEntries, Top: ordered }, healthyOptions, [])
		case "a write of no entry":
			return role(Reports, name, healthyEntries, {
				...healthyOptions,
				write: ["Note", "Mine", "Post"]
			})
		case "a write of a closed relation":
			return role(Reports, name, healthyEntries, {
				...healthyOptions,
				write: ["Note", "Mine", "Kind"]
			})
		case "a write of a derived relation":
			return role(Reports, name, healthyEntries, {
				...healthyOptions,
				write: ["Note", "Mine", "Counts"]
			})
		case "a write of a query entry with an unfixed field":
			return role(
				Reports,
				name,
				{ ...healthyEntries, Unfixed: unfixed },
				{ ...healthyOptions, write: ["Note", "Mine", "Unfixed"] }
			)
		case "two writable entries over one relation":
			return role(
				Reports,
				name,
				{ ...healthyEntries, Post },
				{ ...healthyOptions, write: ["Note", "Mine", "Post"] }
			)
		case "a refresh of an ordinary relation":
			return role(Reports, name, healthyEntries, { ...healthyOptions, refresh: ["Counts", "Note"] })
	}
}

/**
 * The healthy role's description as data a JavaScript author writes, decoded: its entries, the writable query entry's
 * definition the description of `mine`, and its lists; `planted` adds an entry or a list member.
 */
const plantedLoc = SourceLoc("a planted role", [])
const whole = (name: string) => ({ kind: "whole", name, loc: plantedLoc })
const describedRole = (planted: {
	readonly entries: ReadonlyArray<unknown>
	readonly write: ReadonlyArray<string>
	readonly refresh: ReadonlyArray<string>
}): Result.Result<RoleDesc, CompileError> =>
	decodeDesc("role", {
		name: "described",
		base: schemaDescOf(Reports),
		relations: [
			whole("Kind"),
			whole("Note"),
			whole("Counts"),
			{ kind: "world", name: "Mine", query: queryValueDesc(mine), loc: plantedLoc },
			...planted.entries
		],
		write: ["Note", "Mine", ...planted.write],
		refresh: ["Counts", ...planted.refresh]
	})

/** A query entry of a planted description: the Description of a query value under `name`. */
const worldEntry = (name: string, value: unknown) => ({
	kind: "world",
	name,
	query: queryValueDesc(value),
	loc: plantedLoc
})

/**
 * The healthy role's description with a defect planted where ownership alone reads it, a description decoded from data
 * that no builder checked: decoding refuses a defect the description's shape refuses (an Ordered entry), ownership
 * every other. A whole entry under another name has
 * no description (a whole entry is its name), and a description carries no schema its queries were built over, so those
 * two defects are the builder's alone.
 */
const plantedDesc = (
	defect: Exclude<RoleDefect, "none">
): Result.Result<RoleDesc, CompileError> | undefined => {
	const planted = (
		entries: ReadonlyArray<unknown>,
		write: ReadonlyArray<string>,
		refresh: ReadonlyArray<string>
	) => describedRole({ entries, write, refresh })
	switch (defect) {
		case "a whole entry the base does not declare":
			return planted([whole("Stray")], [], [])
		case "a query entry over a relation the base lacks":
			return planted([worldEntry("Far", elsewhere)], [], [])
		case "a query entry that reads a parameter":
			return planted([worldEntry("ByAuthor", ofAuthor)], [], [])
		case "a query entry that attaches":
			return planted([worldEntry("Notes2", withNotes)], [], [])
		case "a query entry that searches approximately":
			return planted([worldEntry("Near", nearest)], [], [])
		case "an Ordered query entry":
			return planted([worldEntry("Top", ordered)], [], [])
		case "a write of no entry":
			return planted([], ["Post"], [])
		case "a write of a closed relation":
			return planted([], ["Kind"], [])
		case "a write of a derived relation":
			return planted([], ["Counts"], [])
		case "a write of a query entry with an unfixed field":
			return planted([worldEntry("Unfixed", unfixed)], ["Unfixed"], [])
		case "two writable entries over one relation":
			return planted([whole("Post")], ["Post"], [])
		case "a refresh of an ordinary relation":
			return planted([], [], ["Note"])
		case "a whole entry under another name":
		case "a query entry built over another schema":
			return undefined
	}
}

/** The rule each planted breach breaks, as the builder and ownership name it. */
const ruleOf: Readonly<Record<Exclude<RoleDefect, "none">, RoleRule["kind"]>> = {
	"a whole entry under another name": "wholeEntryName",
	"a whole entry the base does not declare": "wholeEntryUndeclared",
	"a query entry built over another schema": "entryOverAnother",
	"a query entry over a relation the base lacks": "entryOutsideBase",
	"a query entry that reads a parameter": "entryParameters",
	"a query entry that attaches": "entryAttaches",
	"a query entry that searches approximately": "entryApproximate",
	"an Ordered query entry": "entryOrdered",
	"a write of no entry": "writeOutside",
	"a write of a closed relation": "writeKind",
	"a write of a derived relation": "writeKind",
	"a write of a query entry with an unfixed field": "writeUnwritable",
	"two writable entries over one relation": "writeTwice",
	"a refresh of an ordinary relation": "refreshKind"
}

/** The rule a role's refusal names. */
const brokenRule = (e: CompileError): RoleRule["kind"] | undefined =>
	e.reason._tag === "RoleRefused" ? e.reason.rule.kind : undefined

/** The healthy role's description, which ownership owns. */
const healthyDesc = succeeded(describedRole({ entries: [], write: [], refresh: [] }))

let roleSerial = 0

describe("role admission", () => {
	it.effect(
		"refuses every planted breach of a role's rules at the builder and at ownership, and admits its healthy twin",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/schema/worlds-role",
						generator: element(roleDefects),
						literal: Formatter.format,
						limit: roleDefects.length,
						coverage: requiredInSpace<RoleDefect>(roleDefects),
						caseHang
					},
					(defect, c) =>
						Effect.sync(() => {
							c.note(defect)
							const name = `r${roleSerial++}`
							if (defect === "none") {
								assert.equal(healthyRole(name).name, name)
								succeeded(ownRole(healthyDesc))
								return
							}
							const described = plantedDesc(defect)
							assert.equal(
								brokenRule(throwsRefused(() => plantedRole(defect, name), "RoleRefused", defect)),
								ruleOf[defect],
								defect
							)
							if (described === undefined) {
								return
							}
							const owned = Result.flatMap(described, ownRole)
							if (defect === "an Ordered query entry") {
								refused(
									owned,
									"MalformedDescription",
									"decoding refuses an Ordered entry by its shape"
								)
							} else {
								assert.equal(
									brokenRule(refused(owned, "RoleRefused", defect)),
									ruleOf[defect],
									defect
								)
							}
						})
				)
			)
	)
})

/**
 * A query entry's definition may hold any operation, since none raises: a partial one stands under the guard that
 * proves its precondition. Its role's view evaluates the definition on facts outside the world, and fails no read.
 */
type Operation = "a guarded division" | "an exact addition" | "a comparison"
const operations: Arr.NonEmptyReadonlyArray<Operation> = [
	"a guarded division",
	"an exact addition",
	"a comparison"
]

const definitionOf = (operation: Operation) => {
	switch (operation) {
		case "a guarded division":
			return query(Reports).rule((r) => {
				const { id, words } = v(Post, "post")
				return r
					.match(Post, { id, words })
					.where(
						r.gt(
							Compute.when(Compute.nonzero(words), (w) => Compute.div(words, w), 0n),
							0n
						)
					)
					.find({ id })
			})
		case "an exact addition":
			return query(Reports).rule((r) => {
				const { id, words } = v(Post, "post")
				return r.match(Post, { id, words }).find({ id, more: Compute.add(words, words) })
			})
		case "a comparison":
			return query(Reports).rule((r) => {
				const { id, words } = v(Post, "post")
				return r.match(Post, { id, words }).where(r.gt(words, 0)).find({ id })
			})
	}
}

let entrySerial = 0

describe("query entry totality", () => {
	it.effect("admits every operation in a query entry's definition, as in a program", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/schema/worlds-totality",
					generator: element(operations),
					literal: Formatter.format,
					limit: operations.length,
					coverage: requiredInSpace<Operation>(operations),
					caseHang
				},
				(operation, c) =>
					Effect.sync(() => {
						const definition = definitionOf(operation)
						succeeded(lowerQuery(definition), `${operation} in a program`)
						/**
						 * The role is compiled with every query over it, its entries checked once: a query reading its whole
						 * Note compiles whatever the entry's definition computes.
						 */
						const entries = role(Reports, `t${entrySerial++}`, { Note, Entry: definition })
						succeeded(
							lowerQuery(
								query(entries).rule((r) => {
									const { id } = v(Note, "note")
									return r.match(Note, { id }).find({ id })
								})
							),
							`${operation} in a query entry`
						)
						c.note(operation)
					})
			)
		)
	)
})

/** Context field descriptors, each with whether a claim of its type is admitted. */
const contextFields: Arr.NonEmptyReadonlyArray<readonly [string, FieldBase, boolean]> = [
	["uuid", uuid, true],
	["text", Author, true],
	["boolean", rawPg.boolean, true],
	["smallint", rawPg.smallint, true],
	["integer", rawPg.integer, true],
	["bigint", rawPg.bigint, true],
	["a contract over bigint", bareContract("Tier", rawPg.bigint), true],
	["a closed handle", rawClosedId(Kind), true],
	["numeric", rawPg.numericOf(10, 2), false],
	["real", rawPg.real, false],
	["double precision", rawPg.doublePrecision, false],
	["money", rawPg.money, false],
	["a span", rawSpan(rawPg.integer), false],
	["a vector", rawPg.vector(3), false],
	["a serial", rawPg.bigserial, false],
	["a contract over money", bareContract("Fee", rawPg.money), false]
]

describe("context admission", () => {
	it.effect("admits a context of scalar claims and refuses any other field type", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/schema/worlds-context",
					generator: element(contextFields),
					literal: Formatter.format,
					limit: contextFields.length,
					coverage: requiredInSpace<"admitted" | "refused">(["admitted", "refused"]),
					caseHang
				},
				([label, field, admitted], c) =>
					Effect.sync(() => {
						if (admitted) {
							c.note("admitted")
							admitContext("Claims", { field }, { claim: "o" }, [])
							succeeded(
								decodeDesc("context", { name: "Claims", fields: { field: descOf(field) } }),
								label
							)
							return
						}
						c.note("refused")
						throwsRefused(
							() => admitContext("Claims", { field }, undefined, []),
							"ContextRefused",
							label
						)
						refused(
							decodeDesc("context", { name: "Claims", fields: { field: descOf(field) } }),
							"MalformedDescription",
							label
						)
					})
			)
		)
	)
})

type LoginDefect =
	| "none"
	| "a role over another base"
	| "a role named as its login"
	| "a role in a second login"

const loginDefects: Arr.NonEmptyReadonlyArray<LoginDefect> = [
	"none",
	"a role over another base",
	"a role named as its login",
	"a role in a second login"
]

let loginSerial = 0

/** The rule a login's refusal names. */
const loginRule = (e: CompileError): LoginRule["kind"] | undefined =>
	e.reason._tag === "LoginRefused" ? e.reason.rule.kind : undefined

const fresh = () => role(Reports, `r${roleSerial++}`, { Note })

describe("login admission", () => {
	it.effect(
		"refuses a login breaking each login rule by that rule, and admits its healthy twin",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/schema/worlds-login",
						generator: element(loginDefects),
						literal: Formatter.format,
						limit: loginDefects.length,
						coverage: requiredInSpace<LoginDefect>(loginDefects),
						caseHang
					},
					(defect, c) =>
						Effect.sync(() => {
							c.note(defect)
							const loginName = `l${loginSerial++}`
							switch (defect) {
								case "none": {
									const roles = [fresh(), fresh()] as const
									assert.equal(login(Reports, loginName, roles, []).name, loginName)
									succeeded(
										Result.flatMap(
											decodeDesc("login", {
												name: loginName,
												base: schemaDescOf(Reports),
												roles: Arr.map(roles, (r) => roleDescOf(r)),
												loc: SourceLoc("a described login", [])
											}),
											ownLogin
										)
									)
									return
								}
								case "a role over another base":
									assert.equal(
										loginRule(
											throwsRefused(
												() =>
													login(
														Reports,
														loginName,
														[fresh(), role(Other, `o${loginSerial}`, { Post })],
														[]
													),
												"LoginRefused"
											)
										),
										"roleBase"
									)
									return
								case "a role named as its login":
									assert.equal(
										loginRule(
											throwsRefused(
												() => login(Reports, loginName, [role(Reports, loginName, { Note })], []),
												"LoginRefused"
											)
										),
										"roleName"
									)
									return
								case "a role in a second login": {
									const shared = fresh()
									login(Reports, loginName, [shared], [])
									assert.equal(
										loginRule(
											throwsRefused(
												() => login(Reports, `${loginName}x`, [shared], []),
												"LoginRefused"
											)
										),
										"roleTwice"
									)
									return
								}
							}
						})
				)
			)
	)
})
