import { Brand, Schema } from "effect"
type LabelStream = number & Brand.Brand<"LabelStream">
type RunStream = number & Brand.Brand<"RunStream">
type Seed = number & Brand.Brand<"Seed">
export const labelStream = Brand.nominal<LabelStream>() // violation
export const runStream = Brand.check<RunStream>(Schema.isInt()) // violation
export const checked = Brand.make<RunStream>(() => undefined) // violation
export const TodoId = Schema.String.pipe(Schema.brand("TodoId")) // violation
export const TodoTitle = Schema.String.pipe(Schema.brand("TodoTitle")) // violation
export const seed = Brand.nominal<Seed>()
export const Label = Schema.String.pipe(Schema.brand("Label"))
export const both = Brand.all(labelStream, runStream)
export const generic = Brand.nominal<Brand.Brand<"LabelStream">>()
