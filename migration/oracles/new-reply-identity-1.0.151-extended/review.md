# Extended actual typed Identity oracle
Exact AGY tests-only source fully read and inspected before offline/locked Rust 1.97.1 execution.
161 cases: 47 accepted, 114 rejected. Initial 58 case output lines including raw JSON and identity/error outputs are byte-identical to immutable prior oracle.
New cases are Rust from_str::<Identity> observations, not hand-authored expectations. Includes required empty strings, all integer-field extrema/float lexemes, enum duplicate/empty/payloads, known wrong types, malformed unknown JSON, low surrogate direct/ignored keys, ignored 256-deep objects, BOM/NEL, prototype-key inputs.
No production changes. Generic Value parser is not the typed input oracle. Authoritative numeric values remain unmodified stdout.ndjson; summary excludes lossy identity numbers.
