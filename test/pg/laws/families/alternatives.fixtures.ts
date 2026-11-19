/** What the properties of alternatives.test.ts read: every armed handle of every schema of the alternatives box. */
import { element, type FiniteSpace, finite, int } from "@bjornpagen/testing/gen"
import { alternativesBox, type RunsParams } from "#test/support/laws/boxes.ts"
import { elementAt } from "#test/support/oracle/pick.ts"

/**
 * An armed handle of a schema of the box: the schema, the position of its payload relation and the handle's, and whether
 * the relation is the payload of other handles too.
 */
export interface ArmedHandle {
	readonly schema: RunsParams
	readonly pay: number
	readonly handle: number
	readonly shared: boolean
}

export type ArmedFeature =
	| "a handle of a payload relation shared"
	| "a handle of a payload relation of its own"

/**
 * Every armed handle of every schema of the alternatives box, the box's own parts: a schema, an arm of it and a handle of
 * that arm, each schema's arms and handles as the box states them.
 */
export const armedHandles: FiniteSpace<ArmedHandle> = finite((source) => {
	const schema = source.draw(element(alternativesBox.variants))
	const pay = source.draw(int(0, schema.arms.length - 1))
	const arm = elementAt(schema.arms, pay, "the schema's arms")
	const handle = source.draw(element(arm.handles))
	return { schema, pay, handle, shared: arm.handles.length > 1 }
})
