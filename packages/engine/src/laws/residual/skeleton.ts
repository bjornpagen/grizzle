import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import {
	isNonEmpty,
	lastNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import {
	eventsInOrder,
	type KeyImage,
	type LawField,
	type Participant,
	type ParticipantEvents,
	type ResidualLaw,
	type UpdateEvent
} from "#compiler/ir/law.ts"
import { familyBody } from "#compiler/laws/families/index.ts"
import type { FamilyBody } from "#compiler/laws/families/plugin.ts"
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
	SelectBody,
	TriggerEvent
} from "#compiler/sql/ast.ts"

import {
	asc,
	col,
	core,
	derived,
	eq,
	lit,
	objectName,
	or,
	row,
	select,
	target,
	types
} from "#compiler/sql/build.ts"

/** The record the skeleton binds each affected key of a several-image event to. */
const keyVariable = "k"

export interface ResidualLawObjects {
	readonly law: LawId
	readonly function: PlFunction
	readonly revoke: Revoke
	/** One constraint trigger per participating relation, with its participant, in the law's participant order. */
	readonly triggers: ReadonlyArray<{
		readonly participant: Participant
		readonly trigger: CreateConstraintTrigger
	}>
}

interface ResidualEmitOptions {
	/** The PostgreSQL schema identifier the law is installed in. */
	readonly schema: string
	/** The theory roles holding a relation whole, the roles a violation of it reports its keys to (`witnessShown`). */
	readonly holders: (relation: string) => ReadonlyArray<string>
}

/** The installation statements of one residual law, in order: the function, its PUBLIC revocation, its triggers. */
export const residualLawStatements = (objects: ResidualLawObjects): ReadonlyArray<Ddl> => [
	objects.function,
	objects.revoke,
	...objects.triggers.map((t) => t.trigger)
]

const on = (op: string, body: ReadonlyArray<PlStatement>) => ({
	condition: eq(tgOp, lit.text(op, types.text)),
	body
})

class Emitter {
	readonly law: ResidualLaw
	readonly schema: string
	/** Steps 2 and 3, from the law's family. */
	readonly body: FamilyBody

	constructor(law: ResidualLaw, options: ResidualEmitOptions) {
		this.law = law
		this.schema = options.schema
		this.body = familyBody(law, options.schema, (relation) =>
			witnessShown(options.holders(relation))
		)
	}

	/** The guard of one image (see `emitResidualLaw`), or undefined when the image may always threaten. */
	guard(image: KeyImage): Expr | undefined {
		switch (image.guard.kind) {
			case "always":
				return undefined
			case "selected":
				return or(
					...image.guard.selections.map((selection) =>
						selectedBy(this.law.lawId, this.schema, selection, (field) =>
							imageField(image.side, field)
						)
					)
				)
		}
	}

	guarded(image: KeyImage, statements: ReadonlyArray<PlStatement>): ReadonlyArray<PlStatement> {
		const guard = this.guard(image)
		return guard === undefined || statements.length === 0
			? statements
			: [{ kind: "if", branches: [{ condition: guard, body: statements }], else: [] }]
	}

	/** Step 1 for one event, and steps 2 and 3 for each key it affects. */
	keys(images: NonEmptyReadonlyArray<KeyImage>): ReadonlyArray<PlStatement> {
		const [image, ...others] = images
		if (others.length === 0) {
			return this.guarded(
				image,
				this.body.check(
					mapNonEmpty(image.key, (c) => ({ pair: c.pair, value: imageField(image.side, c.field) }))
				)
			)
		}
		const keyed = mapNonEmpty(image.key, (c, i) => ({ pair: c.pair, column: `c${i + 1}` }))
		const columns = mapNonEmpty(keyed, (c) => c.column)
		const [head, ...tail] = mapNonEmpty(images, (each): SelectBody =>
			core(
				each.key.map((c) => target(imageField(each.side, c.field))),
				[],
				this.guard(each)
			)
		)
		const union = tail.reduce(
			(left, right): SelectBody => ({ kind: "setOp", op: "UNION", left, right }),
			head
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
				body: this.body.check(
					mapNonEmpty(keyed, (c) => ({ pair: c.pair, value: recordField(keyVariable, c.column) }))
				)
			}
		]
	}

	/** An UPDATE of one participant: the change test of its UPDATE OF fields, then its keys. */
	update(update: UpdateEvent): ReadonlyArray<PlStatement> {
		const keys = this.keys(update.images)
		const [only, ...more] = update.of
		const field = (side: "old" | "new", f: LawField) => imageField(side, f)
		const unchanged =
			more.length === 0
				? eq(field("old", only), field("new", only))
				: eq(
						row(...update.of.map((f) => field("old", f))),
						row(...update.of.map((f) => field("new", f)))
					)
		return [
			{
				kind: "if",
				branches: [{ condition: unchanged, body: [{ kind: "return", value: newRecord }] }],
				else: []
			},
			...keys
		]
	}

	/** Every event of one participant, dispatched on TG_OP when it has several. */
	participant(events: ParticipantEvents): ReadonlyArray<PlStatement> {
		return dispatch(
			eventsInOrder(events, {
				insert: (images) => on("INSERT", this.keys(images)),
				delete: (images) => on("DELETE", this.keys(images)),
				update: (update) => on("UPDATE", this.update(update))
			})
		)
	}

	run(): ResidualLawObjects {
		const participants = this.law.participants
		const dispatched = dispatch(
			participants.map((p) => ({
				condition: eq(tgTableName, lit.text(p.relation.ident, types.text)),
				body: this.participant(p.events)
			}))
		)
		const deletes = participants.some((p) => p.events.delete !== undefined)
		const others = participants.some(
			(p) => p.events.insert !== undefined || p.events.update !== undefined
		)
		const returns: NonEmptyReadonlyArray<PlStatement> = !deletes
			? [{ kind: "return", value: newRecord }]
			: !others
				? [{ kind: "return", value: oldRecord }]
				: [
						{
							kind: "if",
							branches: [
								{
									condition: eq(tgOp, lit.text("DELETE", types.text)),
									body: [{ kind: "return", value: oldRecord }]
								}
							],
							else: []
						},
						{ kind: "return", value: newRecord }
					]
		/** An event with several images binds each of its keys to the key record. */
		const usesKeyVariable = participants.some((p) =>
			eventsInOrder(p.events, {
				insert: (images) => images.length > 1,
				delete: (images) => images.length > 1,
				update: (update) => update.images.length > 1
			}).includes(true)
		)
		const declare: ReadonlyArray<PlDeclaration> = [
			...(usesKeyVariable ? [{ name: keyVariable, type: types.record }] : []),
			...this.body.declare
		]
		const fn = objectName(this.schema, identifierOf(this.law.function))
		const createFunction: PlFunction = {
			kind: "createFunction",
			language: "plpgsql",
			name: fn,
			params: [],
			returns: "trigger",
			volatility: "VOLATILE",
			parallel: "UNSAFE",
			security: "DEFINER",
			searchPath: ["pg_catalog", "pg_temp"],
			planCacheMode: "force_custom_plan",
			body: { declare, body: isNonEmpty(dispatched) ? [...dispatched, ...returns] : returns }
		}
		const revoke: Revoke = {
			kind: "revoke",
			privileges: ["EXECUTE"],
			on: { kind: "FUNCTION", names: [{ ...fn, args: [] }] },
			from: [{ kind: "PUBLIC" }]
		}
		const triggers = participants.map((p) => {
			const events = eventsInOrder(p.events, {
				insert: (): TriggerEvent => ({ kind: "INSERT" }),
				delete: (): TriggerEvent => ({ kind: "DELETE" }),
				update: (update): TriggerEvent => ({
					kind: "UPDATE",
					of: mapNonEmpty(update.of, (f) => f.column)
				})
			})
			const trigger: CreateConstraintTrigger = {
				kind: "createConstraintTrigger",
				name: identifierOf(p.trigger),
				table: objectName(this.schema, p.relation.ident),
				events,
				function: fn
			}
			return { participant: p, trigger }
		})
		return { law: this.law.lawId, function: createFunction, revoke, triggers }
	}
}

const tgOp: Expr = { kind: "plSpecial", name: "TG_OP" }
const tgTableName: Expr = { kind: "plSpecial", name: "TG_TABLE_NAME" }
const newRecord: Expr = { kind: "plSpecial", name: "NEW" }
const oldRecord: Expr = { kind: "plSpecial", name: "OLD" }

/** IF <c1> THEN ... ELSIF ... ELSE <last> END IF over alternatives of which exactly one holds at firing: the trigger
 * fires only for its own table and events, so the last needs no test. One alternative needs no IF at all. */
const dispatch = (
	branches: ReadonlyArray<{ readonly condition: Expr; readonly body: ReadonlyArray<PlStatement> }>
): ReadonlyArray<PlStatement> => {
	if (!isNonEmpty(branches)) {
		return []
	}
	const init = branches.slice(0, -1)
	const last = lastNonEmpty(branches)
	return isNonEmpty(init) ? [{ kind: "if", branches: init, else: last.body }] : last.body
}

/** The function and triggers of one residual law: one PL/pgSQL function and one deferred constraint trigger per
 * participating table.
 *
 *   CREATE OR REPLACE FUNCTION <schema>.__law_<law-id>() RETURNS trigger
 *     LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
 *     SET plan_cache_mode = force_custom_plan AS $$ ... $$;
 *   REVOKE EXECUTE ON FUNCTION <schema>.__law_<law-id>() FROM PUBLIC;
 *   CREATE CONSTRAINT TRIGGER <table>__law__<law-id>
 *     AFTER INSERT OR DELETE [OR UPDATE OF <fields>] ON <schema>.<table>
 *     DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION <schema>.__law_<law-id>();
 *
 * Every firing runs the three steps below in order. The skeleton writes step 1 and splices the family's steps 2 and 3
 * (`FamilyPlugin`) in once per affected key:
 *
 * 1. Take the affected anchor keys from the event's row images. With several participating tables the function
 *    dispatches on TG_TABLE_NAME, then on TG_OP when the table has several events. An UPDATE, which only
 *    a `mutable` participant has, first compares OLD and NEW over the fields its trigger lists in
 *    UPDATE OF and returns at once when none changed: UPDATE OF tests target-list membership, not change, and a
 *    constraint trigger's WHEN cannot refer to both images of a trigger that also covers INSERT or DELETE. The fields
 *    are NOT NULL, so exact inequality suffices.
 *
 *    Each row image gives one anchor key, the event's KeyImage: the participant fields that give the
 *    anchor key, in anchor-key order. Each row image carries its guard (`ImageGuard`), which the recognizer
 *    records for the side the image plays: an image of a row outside that side's selection gives no key, so its event
 *    cannot change the law's selected facts (a pending shift is such a row). An image two sides of one relation share
 *    is guarded by the union of their selections, and one an unselected side plays is never skipped (`mergeParticipants`).
 *
 *    An event with one image checks its key directly. An event with several, an UPDATE that may move a fact between
 *    groups, checks each distinct key once, in key order:
 *
 *      FOR k IN SELECT r1.c1, ... FROM (SELECT OLD.f1, ... [WHERE <guard>] UNION SELECT NEW.f1, ...)
 *        AS r1(c1, ...) ORDER BY r1.c1, ... LOOP <steps 2 and 3 for k.c1, ...> END LOOP;
 *
 * 2. and 3. The family's statements for each key: read the anchor row at the key (`readAnchor`), then evaluate
 *    the violation query and raise 23000 with the law's identity and a DetailCodec DETAIL.
 *
 * The function returns NEW for INSERT and UPDATE and OLD for DELETE, never a NULL marker. Every statement in it reads
 * the transaction's snapshot, which is SERIALIZABLE: the isolation guard on every table refuses a write below it before
 * the statement that would fire the law runs, so the function needs no test of the level
 * and no lock. It is SECURITY DEFINER with a fixed search path and qualified names, so it reads outside the
 * writer's scope. EXECUTE is revoked from PUBLIC; PostgreSQL invokes it only as a trigger.
 *
 * The function's name is the law's: a change to the body, the anchors or the events replaces the function in place,
 * atomically with its triggers and the law's validation. The constraint name the function
 * raises is the law id.
 *
 * The function and triggers of one residual law, or the first refusal: its family's (UnsupportedOperation for a literal
 * no residual law compares), or a law the model records inconsistently. */
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
