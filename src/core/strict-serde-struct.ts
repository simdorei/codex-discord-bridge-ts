import type {StructFieldDecoder, StructShape} from './serde-struct-json.ts';

/** serde deny_unknown_fields on a typed struct. Sequence decoding keeps the
 * existing Serde field order; object input also rejects duplicate keys. */
export function strictSerdeStruct(shape: StructShape): StructFieldDecoder {
  return (raw, _depth, context) => {
    if (raw.trimStart().startsWith('[')) return context.struct(shape);
    const values: Record<string, unknown> = Object.create(null), fields = new Map(shape.fields);
    context.map((key, decode) => {
      const field = fields.get(key);
      if (field === undefined) throw new SyntaxError('Unknown struct field: ' + key);
      if (Object.hasOwn(values, key)) throw new SyntaxError('Duplicate struct field: ' + key);
      values[key] = decode(field);
    });
    for (const [key] of shape.fields) if (!Object.hasOwn(values, key)) throw new SyntaxError('Missing struct field: ' + key);
    return values;
  };
}
