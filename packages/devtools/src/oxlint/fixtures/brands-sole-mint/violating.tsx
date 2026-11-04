import { Brand, Schema } from "effect"
type TableName = string & Brand.Brand<"TableName">
type Label = string & Brand.Brand<"Label">
type SqlText = string & { readonly sqlText: true }
type Plain = string & { readonly plain: true }
declare const nominal: <A, B extends A>() => (value: A) => B
export const table = Brand.nominal<TableName>() // violation
export const column = Schema.String.pipe(Schema.brand("ColumnName")) // violation
export const sql = nominal<string, SqlText>() // violation
export const label = Brand.nominal<Label>()
export const tag = Schema.String.pipe(Schema.brand("Label"))
export const plain = nominal<string, Plain>()
