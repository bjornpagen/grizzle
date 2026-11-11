import { Brand, Schema } from "effect"
type LabelStream = number & Brand.Brand<"LabelStream">
type RunStream = number & Brand.Brand<"RunStream">
export const labelStream = Brand.nominal<LabelStream>()
export const runStream = Brand.check<RunStream>(Schema.isInt())
export const TodoId = Schema.String.pipe(Schema.brand("TodoId"))
export const TodoTitle = Schema.String.pipe(Schema.brand("TodoTitle"))
