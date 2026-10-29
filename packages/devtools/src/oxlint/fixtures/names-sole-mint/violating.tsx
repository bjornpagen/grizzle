import { Brand, Schema } from "effect"
type TableName = string & Brand.Brand<"TableName">
type Label = string & Brand.Brand<"Label">
export const table = Brand.nominal<TableName>() // violation
export const column = Schema.String.pipe(Schema.brand("ColumnName")) // violation
export const label = Brand.nominal<Label>()
export const tag = Schema.String.pipe(Schema.brand("Label"))
