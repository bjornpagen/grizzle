/** What the properties of prepared-levels.test.ts read: their logins, the change compile they are held to, and walks. */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { defined } from "@bjornpagen/testing/assert"
import { array, type Gen, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { artifactsOver, builtLogin, ownLoginOver } from "#adapter/served/login.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { installBasis, unserved } from "#compiler/physical/install/plan.ts"
import type { Variants } from "#compiler/program/workload/change.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { range, int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	login,
	mutable,
	relation,
	role,
	schema,
	unit,
	wholeEntriesOf,
	wholeWritesOf
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { succeeded } from "#test/support/assert.ts"
import { changeLogin } from "#test/support/change-login.ts"
import { Id } from "#test/support/ids.ts"

const note = str.regex("^[a-z]{1,8}$")

/** A span primary key: its insert and its put have no READ COMMITTED form (write/schedule/plan.ts readCommittedLack). */
const Room = relation("Room", { room: Id, during: range(int8), guest: Id }, ["room", "during"])

/** Room's mutable twin, whose put is the DELETE-then-insert pair, which has none either. */
const Hold = relation("Hold", { room: Id, during: range(int8), note }, ["room", "during"])

/** A scalar primary key: its insert and its put have a READ COMMITTED form. */
const Plain = relation("Plain", { id: Id, note }, ["id"])

/** Hold under the unit of its room, Plain under the unit of its id, each mutable inside its unit. */
const Levels = schema(
	"PreparedLevels",
	[Room, Hold, Plain],
	[unit("Rooms", { room: Id }), unit("Plains", { id: Id }), mutable(Hold), mutable(Plain)]
)

/** The programs a role's workload may hold, by whether each has a READ COMMITTED form, with the relation it writes. */
export const programs = {
	insertRoom: {
		formed: false,
		relation: "Room",
		value: () => ChangeSet.empty(Levels).insert(Room, [])
	},
	putHold: { formed: false, relation: "Hold", value: () => ChangeSet.empty(Levels).put(Hold, []) },
	insertPlain: {
		formed: true,
		relation: "Plain",
		value: () => ChangeSet.empty(Levels).insert(Plain, [])
	},
	putPlain: { formed: true, relation: "Plain", value: () => ChangeSet.empty(Levels).put(Plain, []) }
} as const

export type Program = keyof typeof programs

/** The programs in their order: Room's insert, Hold's put, Plain's insert and Plain's put. */
export const programNames: readonly [Program, ...Array<Program>] = [
	"insertRoom",
	"putHold",
	"insertPlain",
	"putPlain"
]

const roleGen: Gen<ReadonlyArray<Program>> = subset(programNames, {
	min: 1,
	max: programNames.length
})

/** A login's roles, one to three, each its workload's programs, one to all four. */
export const rolesGen: Gen<NonEmptyReadonlyArray<ReadonlyArray<Program>>> = (source) => [
	source.draw(roleGen),
	...source.draw(array(roleGen, { min: 0, max: 2 }))
]

/**
 * The login of `drawn` as its change members compile (ChangeLogin): one role per drawn workload, each writing every
 * relation, its programs named apart by the role's index, compiled with no database over the artifacts its served
 * file compiles over, as generate compiles it (test/support/compiled-served.ts compiledInstallation).
 */
export const changeLoginOf = (drawn: NonEmptyReadonlyArray<ReadonlyArray<Program>>) => {
	const roles = Arr.map(drawn, (_, i) =>
		role(Levels, `writer${i}`, wholeEntriesOf(Levels), wholeWritesOf(Levels))
	)
	const value = login(Levels, "app", roles, {
		workload: Arr.map(drawn, (held, i) =>
			workload(
				defined(roles[i], "a drawn role"),
				Rec.fromEntries(Arr.map(held, (p) => [`${p}${i}`, programs[p].value()] as const))
			)
		)
	})
	return changeLogin(value)
}

/** The entries of `variants`, every form of its splits, in order. */
export const entriesOf = <E>(variants: Variants<E>): ReadonlyArray<E> =>
	variants.kind === "form"
		? [variants.entry]
		: [...entriesOf(variants.lacking), ...entriesOf(variants.holding)]

/** A read of every Plain fact: the query program each workload of footprintsLoginOf's login holds beside its ChangeSets. */
const plainRead = () =>
	query(Levels).rule((r) => {
		const { id, note: n } = v(Plain, "plain")
		return r.match(Plain, { id, note: n }).find({ id, note: n })
	})

/**
 * The login of `drawn` as a served file's footprint plan reads it (program/workload/compile.ts loginFootprints): one
 * role per drawn workload, each workload its drawn ChangeSets and a read of Plain (`read<i>`), with the base's
 * artifacts over unserved parameter types, the login's name and its owned roles.
 */
export const footprintsLoginOf = (drawn: NonEmptyReadonlyArray<ReadonlyArray<Program>>) => {
	const roles = Arr.map(drawn, (_, i) =>
		role(Levels, `writer${i}`, wholeEntriesOf(Levels), wholeWritesOf(Levels))
	)
	const value = login(Levels, "app", roles, {
		workload: Arr.map(drawn, (held, i) =>
			workload(defined(roles[i], "a drawn role"), {
				...Rec.fromEntries(Arr.map(held, (p) => [`${p}${i}`, programs[p].value()] as const)),
				[`read${i}`]: plainRead()
			})
		)
	})
	const built = defined(builtLogin(value), "a login built by login(...)")
	const owned = succeeded(built.base.content.owned(), "the login's base")
	const basis = succeeded(
		installBasis(owned, firstCodebook(rostersOf(owned)), new Set()),
		"the base's basis"
	)
	return {
		built,
		artifacts: succeeded(artifactsOver(basis, unserved), "the base's artifacts"),
		owned: succeeded(ownLoginOver(built, owned), "the login over its base")
	}
}
