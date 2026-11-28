/** What extraction-once.test.ts reads: its login, drawn, compiled for READ COMMITTED as generate compiles it. */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { nonEmpty } from "@bjornpagen/testing/assert"
import { boolean, type Gen, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { range, int4, int8 } from "#compiler/public/fields.ts"
import { query } from "#compiler/public/query.ts"
import { contained, login, on, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { changeLogin } from "#test/support/change-login.ts"

const Gate = relation("Gate", { v: int4 }, ["v"])
const Pub = relation("Pub", { v: int4, s: int4 }, ["v"])
const Seen = relation("Seen", { k: int4, v: int4 }, ["k"])

/** A span primary key: its insert has no READ COMMITTED form (write/schedule/plan.ts formedAt). */
const Room = relation("Room", { room: int4, during: range(int8) }, ["room", "during"])

const stored = { Gate, Pub, Seen, Room } as const

/** G3's fenced shape, one published relation: what a learner sees is published. */
const Fenced = schema("ExtractionOnce", Rec.values(stored), [
	contained(on(Seen, "v"), on(Pub, "v"))
])

/** The publisher's members, each an insert of what the learner references, Pub closed: a post of the proposed facts,
 * and a publish gated on Gate's absence, which runs SERIALIZABLE. */
const publishedNames = ["post", "publish"] as const

type Published = (typeof publishedNames)[number]

/** A case: the publisher's members, one to all three, and the writer's: its gate, its insert of a Room, which has no
 * READ COMMITTED form, both, or neither. */
export interface Drawn {
	readonly published: NonEmptyReadonlyArray<Published>
	readonly gate: boolean
	readonly room: boolean
}

export const drawnGen: Gen<Drawn> = (source) => ({
	published: nonEmpty(
		source.draw(subset(publishedNames, { min: 1, max: publishedNames.length })),
		"the publisher's members"
	),
	gate: source.draw(boolean),
	room: source.draw(boolean)
})

/**
 * The login of `drawn` as its change members compile (ChangeLogin, test/support/change-login.ts changeLogin): the
 * publisher's drawn members, the learner's insert of what it sees, and the writer's gate
 * where drawn, compiled with no database over the artifacts its served file compiles over.
 */
export const fencedLoginOf = (drawn: Drawn) => {
	const writer = role(Fenced, "writer", stored, { insert: ["Gate", "Room"] })
	const publisher = role(Fenced, "publisher", stored, { insert: ["Pub"] })
	const learner = role(Fenced, "learner", stored, { insert: ["Seen"] })
	const p = publisher.relations
	const proposed = query(publisher).rule((r) =>
		r.find({ v: r.param("v", int4), s: r.param("s", int4) })
	)
	const published = {
		post: () => ChangeSet.empty(publisher).insert(p.Pub, proposed),
		publish: () =>
			ChangeSet.empty(publisher).insert(
				p.Pub,
				query(publisher).rule((r) =>
					r
						.where(r.not(p.Gate, { v: r.param("v", int4) }))
						.find({ v: r.param("v", int4), s: r.param("s", int4) })
				)
			)
	}
	const learn = ChangeSet.empty(learner).insert(
		learner.relations.Seen,
		query(learner).rule((r) => r.find({ k: r.param("k", int4), v: r.param("v", int4) }))
	)
	const gate = ChangeSet.empty(writer).insert(
		writer.relations.Gate,
		query(writer).rule((r) => r.find({ v: r.param("v", int4) }))
	)
	const value = login(Fenced, "app", [writer, publisher, learner], {
		workload: [
			...(drawn.gate || drawn.room
				? [
						workload(writer, {
							...(drawn.gate ? { gate } : {}),
							...(drawn.room
								? { room: ChangeSet.empty(writer).insert(writer.relations.Room, []) }
								: {})
						})
					]
				: []),
			workload(
				publisher,
				Rec.fromEntries(
					Arr.map(drawn.published, (member) => [member, published[member]()] as const)
				)
			),
			workload(learner, { learn })
		]
	})
	return changeLogin(value)
}
