import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { appendNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import {
	type EventUnit,
	eventsInOrder,
	type Images,
	type LawField,
	type Participant,
	type ResidualLaw,
	type SidedImage,
	type UpdateOf
} from "#compiler/ir/law.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { familyUnits } from "#compiler/laws/families/index.ts"
import type { FamilyAt, FamilyUnit } from "#compiler/laws/families/plugin.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { imageField, recordField, selectedBy, witnessShown } from "#compiler/laws/residual/sql.ts"

import type {
	CreateConstraintTrigger,
	Ddl,
	Expr,
	PlDeclaration,
	PlFunction,
	PlStatement,
	Revoke,
	Select,
	SelectCore,
	TriggerEvent
} from "#compiler/sql/ast.ts"

import {
	and,
	asc,
	col,
	core,
	derived,
	ne,
	objectName,
	or,
	row,
	select,
	setOp,
	target,
	types
} from "#compiler/sql/build.ts"

/** The record the skeleton binds each affected key of a several-image event to. */
const keyVariable = "k"

/** One event unit's installed objects: its function, the function's PUBLIC revocation, and the constraint trigger for
 * that one event that alone executes it. */
export interface ResidualUnitObjects {
	readonly participant: Participant
	/** The event unit, whose identities name the function and the trigger. */
	readonly unit: EventUnit<Images | UpdateOf>
	readonly function: PlFunction
	readonly revoke: Revoke
	readonly trigger: CreateConstraintTrigger
}

/** One residual law's installed objects: one unit per participating relation and threatening event, participant by
 * participant in law order, each in INSERT, DELETE, UPDATE order. */
export interface ResidualLawObjects {
	readonly law: LawId
	readonly units: NonEmptyReadonlyArray<ResidualUnitObjects>
}

interface ResidualEmitOptions {
	/** The PostgreSQL schema identifier the law is installed in. */
	readonly schema: string
	/** The installation's names, which type the law's literals. */
	readonly names: PhysicalNames
	/** The theory roles holding a relation whole, the roles a violation of it reports its keys to (`witnessShown`). */
	readonly holders: (relation: string) => ReadonlyArray<string>
}

/** The installation statements of one residual law, in order: each unit's function, its PUBLIC revocation and its
 * trigger. */
export const residualLawStatements = (objects: ResidualLawObjects): ReadonlyArray<Ddl> =>
	objects.units.flatMap((u): ReadonlyArray<Ddl> => [u.function, u.revoke, u.trigger])

/** The row a unit's function returns: NEW for an INSERT's and an UPDATE's, OLD for a DELETE's. */
const returned = (event: TriggerEvent): Expr => {
	switch (event.kind) {
		case "INSERT":
		case "UPDATE":
			return { kind: "plSpecial", name: "NEW" }
		case "DELETE":
			return { kind: "plSpecial", name: "OLD" }
	}
}

/** Whether an UPDATE changed any of the fields it lists: they are NOT NULL, so exact inequality suffices. */
const changed = (of: NonEmptyReadonlyArray<LawField>): Expr => {
	const [only, ...more] = of
	return more.length === 0
		? ne(imageField("old", only), imageField("new", only))
		: ne(
				row(mapNonEmpty(of, (f) => imageField("old", f))),
				row(mapNonEmpty(of, (f) => imageField("new", f)))
			)
}

/** Where one unit fires: its trigger's event and row filter, the event unit it emits, and the images its step 1
 * reads. */
interface UnitAt {
	readonly event: TriggerEvent
	readonly unit: EventUnit<Images | UpdateOf>
	readonly images: NonEmptyReadonlyArray<SidedImage>
	readonly when: Expr | undefined
}

class Emitter {
	readonly law: ResidualLaw
	readonly at: FamilyAt

	constructor(law: ResidualLaw, options: ResidualEmitOptions) {
		this.law = law
		this.at = {
			schema: options.schema,
			names: options.names,
			shown: (relation) => witnessShown(options.holders(relation))
		}
	}

	/** The guard of one image (see `emitResidualLaw`), over the row its event reads it on, or undefined when the image
	 * may always threaten. */
	guard({ side, image }: SidedImage): Expr | undefined {
		switch (image.guard.kind) {
			case "always":
				return undefined
			case "selected":
				return or(
					mapNonEmpty(image.guard.selections, (selection) =>
						selectedBy(this.law.lawId, this.at.names, selection, (field) => imageField(side, field))
					)
				)
		}
	}

	/** The row filter of one event's images: the disjunction of their guards, none when one of them always threatens. */
	filter(images: NonEmptyReadonlyArray<SidedImage>): Expr | undefined {
		const [first, ...rest] = images
		const head = this.guard(first)
		if (head === undefined) {
			return undefined
		}
		const guards: [Expr, ...Array<Expr>] = [head]
		for (const image of rest) {
			const g = this.guard(image)
			if (g === undefined) {
				return undefined
			}
			guards.push(g)
		}
		return or(guards)
	}

	/** Step 1 for one event, and the participant's steps 2 and 3 for each key it affects. */
	keys(images: NonEmptyReadonlyArray<SidedImage>, family: FamilyUnit): ReadonlyArray<PlStatement> {
		const [{ side, image }, ...others] = images
		if (others.length === 0) {
			return family.check(
				mapNonEmpty(image.key, (c) => ({ pair: c.pair, value: imageField(side, c.field) }))
			)
		}
		const keyed = mapNonEmpty(image.key, (c, i) => ({ pair: c.pair, column: `c${i + 1}` }))
		const columns = mapNonEmpty(keyed, (c) => c.column)
		const union = setOp(
			"UNION",
			mapNonEmpty(images, (each): SelectCore =>
				core(
					each.image.key.map((c) => target(imageField(each.side, c.field))),
					[],
					this.guard(each)
				)
			)
		)
		const query: Select = {
			...select(
				core(
					columns.map((c) => target(col("r1", c))),
					[derived(select(union), "r1", columns, false)],
					undefined
				)
			),
			orderBy: columns.map((c) => asc(col("r1", c)))
		}
		return [
			{
				kind: "forQuery",
				variable: keyVariable,
				query,
				body: family.check(
					mapNonEmpty(keyed, (c) => ({ pair: c.pair, value: recordField(keyVariable, c.column) }))
				)
			}
		]
	}

	/** One unit: the function its event runs, step 1 over the event's images and the participant's steps 2 and 3, and
	 * the constraint trigger for that event alone, filtered by its WHEN. */
	unit(participant: Participant, family: FamilyUnit, at: UnitAt): ResidualUnitObjects {
		const declare: ReadonlyArray<PlDeclaration> = [
			...(at.images.length > 1 ? [{ name: keyVariable, type: types.record }] : []),
			...family.declare
		]
		const fn = objectName(this.at.schema, identifierOf(at.unit.function))
		const createFunction: PlFunction = {
			kind: "createFunction",
			language: "plpgsql",
			name: fn,
			params: [],
			returns: "trigger",
			volatility: "VOLATILE",
			parallel: "UNSAFE",
			security: "DEFINER",
			planCacheMode: "force_custom_plan",
			body: {
				declare,
				body: appendNonEmpty(this.keys(at.images, family), {
					kind: "return",
					value: returned(at.event)
				})
			}
		}
		const revoke: Revoke = {
			kind: "revoke",
			privileges: ["EXECUTE"],
			on: { kind: "FUNCTION", names: [{ ...fn, args: [] }] },
			from: [{ kind: "PUBLIC" }]
		}
		const trigger: CreateConstraintTrigger = {
			kind: "createConstraintTrigger",
			name: identifierOf(at.unit.trigger),
			table: objectName(this.at.schema, participant.relation.ident),
			event: at.event,
			when: at.when,
			function: fn
		}
		return { participant, unit: at.unit, function: createFunction, revoke, trigger }
	}

	/** The units of one participant, in INSERT, DELETE, UPDATE order. */
	participant(
		participant: Participant,
		family: FamilyUnit
	): NonEmptyReadonlyArray<ResidualUnitObjects> {
		return eventsInOrder(participant.events, {
			insert: (unit, images) =>
				this.unit(participant, family, {
					event: { kind: "INSERT" },
					unit,
					images,
					when: this.filter(images)
				}),
			delete: (unit, images) =>
				this.unit(participant, family, {
					event: { kind: "DELETE" },
					unit,
					images,
					when: this.filter(images)
				}),
			update: (unit, images) => {
				const selected = this.filter(images)
				const change = changed(unit.on.of)
				return this.unit(participant, family, {
					event: { kind: "UPDATE", of: mapNonEmpty(unit.on.of, (f) => f.column) },
					unit,
					images,
					when: selected === undefined ? change : and([change, selected])
				})
			}
		})
	}

	run(): ResidualLawObjects {
		const [first, ...rest] = familyUnits(this.law, this.at)
		return {
			law: this.law.lawId,
			units: [
				...this.participant(first.participant, first.unit),
				...rest.flatMap((p) => this.participant(p.participant, p.unit))
			]
		}
	}
}

/** The units of one residual law: one deferred constraint trigger per participating table and threatening event, each
 * executing the one PL/pgSQL function that is its own.
 *
 *   CREATE OR REPLACE FUNCTION <schema>.<unit function>() RETURNS trigger
 *     LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ...
 *     SET plan_cache_mode = force_custom_plan AS $$ ... $$;
 *   REVOKE EXECUTE ON FUNCTION <schema>.<unit function>() FROM PUBLIC;
 *   CREATE CONSTRAINT TRIGGER <unit trigger>
 *     AFTER INSERT | DELETE | UPDATE OF <fields> ON <schema>.<table>
 *     DEFERRABLE INITIALLY DEFERRED FOR EACH ROW [WHEN (<filter>)] EXECUTE FUNCTION <schema>.<unit function>();
 *
 * PostgreSQL compiles a trigger function once per trigger and backend, and a trigger fires for one table and its
 * events, so a unit's binding is static: its function never dispatches on the table or the event that fired it, and a
 * first write compiles only its own unit's check. Every firing runs the three steps below in order. The skeleton writes
 * step 1 and splices the participant's steps 2 and 3 (`FamilyUnit`) in once per affected key:
 *
 * 1. Take the affected anchor keys from the event's row images. Each row image gives one anchor key, the event's
 *    KeyImage: the participant fields that give the anchor key, in anchor-key order. Each row image carries its guard
 *    (`ImageGuard`), which the recognizer records for the side the image plays: an image of a row outside that side's
 *    selection gives no key, so its event cannot change the law's selected facts (a pending shift is such a row). An
 *    image two sides of one relation share is guarded by the union of their selections, and one an unselected side
 *    plays is never skipped (plan.ts mergeParticipants).
 *
 *    The trigger's WHEN holds the event's static filter, which PostgreSQL evaluates at the row event, before it queues
 *    the deferred event: the disjunction of its images' guards, none when an image always threatens. An UPDATE, which
 *    only a `mutable` participant has, is the deletion of OLD and the insertion of NEW, so it checks the images those
 *    events would (ir/law.ts updateImages), and its WHEN also requires a change of a field it lists in UPDATE OF:
 *    UPDATE OF tests target-list membership, not change. The fields are NOT NULL, so exact inequality suffices. A row
 *    the law cannot care about, or an UPDATE that changes nothing it reads, queues no event and calls no function. The
 *    guards read only the row images, which are the same at the event and at commit.
 *
 *    An event with one image checks its key directly. An event with several, an UPDATE that may move a fact between
 *    groups, checks each distinct key once, in key order, each image's key under its own guard:
 *
 *      FOR k IN SELECT r1.c1, ... FROM (SELECT OLD.f1, ... [WHERE <guard>] UNION SELECT NEW.f1, ...)
 *        AS r1(c1, ...) ORDER BY r1.c1, ... LOOP <steps 2 and 3 for k.c1, ...> END LOOP;
 *
 * 2. and 3. The participant's statements for each key: read the anchor row at the key (`readAnchor`), then evaluate
 *    what the participant's writes can break and raise 23000 with the law's identity and a DetailCodec DETAIL.
 *
 * An INSERT's and an UPDATE's function returns NEW and a DELETE's OLD, never a NULL marker. Every statement in it reads
 * the transaction's snapshot, which is SERIALIZABLE: the isolation guard on every table refuses a write below it before
 * the statement that would fire the law runs, so the function needs no test of the level and no lock. It is SECURITY
 * DEFINER with a fixed search path and qualified names, so it reads outside the writer's scope. EXECUTE is revoked from
 * PUBLIC; PostgreSQL invokes it only as a trigger.
 *
 * A unit's names are its law's, relation's and event's: a change to its body or its filter replaces its function and
 * its trigger in place, atomically with the law's validation. The constraint name every unit raises is the law id.
 *
 * The units of one residual law, or the first refusal: its family's (UnsupportedOperation for a literal no residual
 * law compares), or a law the model records inconsistently. */
export const emitResidualLaw = (
	law: ResidualLaw,
	options: ResidualEmitOptions
): Result.Result<ResidualLawObjects, CompileError> =>
	catchRefusal(() => new Emitter(law, options).run())

/** Every residual law of a model, in the model's order, or the first refusal. */
export const emitResidualLaws = (
	model: LawModel,
	options: ResidualEmitOptions
): Result.Result<ReadonlyArray<ResidualLawObjects>, CompileError> => {
	const out: Array<ResidualLawObjects> = []
	for (const law of model.residuals) {
		const objects = emitResidualLaw(law, options)
		if (!objects.ok) {
			return Result.err(objects.error)
		}
		out.push(objects.value)
	}
	return Result.ok(out)
}
