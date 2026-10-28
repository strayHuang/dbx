# DBX tiberius patch

This directory vendors `tiberius` 0.12.3 from crates.io. The source package is
identified by the checksum
`a1446cb4198848d1562301a3340424b4f425ef79f35ef9ee034769a9dd92c10d` and the
upstream release tag points to commit
`0e2897a276166503ba78fe3e1cee501e9a034021`.

DBX changes only SQL Server column-data decoding:

- NCHAR, NVARCHAR, and NTEXT row values replace unpaired UTF-16 surrogates with
  U+FFFD, matching the Microsoft JDBC driver's observable behavior.
- CHAR, VARCHAR, and TEXT row values under a non-Unicode collation decode
  lossily: byte sequences that are invalid in the column's collation become
  U+FFFD instead of failing the whole result set, following the JDBC driver's
  REPLACE policy. The lossy decoder does no BOM handling, so bytes that merely
  look like a UTF-8 BOM (e.g. under GB18030) stay ordinary collation data.
- Odd byte lengths remain protocol errors, including an explicit NTEXT guard
  that prevents truncating a trailing byte and desynchronizing the TDS stream.
- Metadata, environment tokens, and other protocol strings retain upstream's
  strict behavior.
- `sql_variant` (SSVARIANT, 0x62) columns decode instead of aborting the
  process. The 4-byte value length, properties, and base type are parsed and
  the payload becomes the matching `ColumnData` variant (integers, bit, money,
  floats, guid, decimal/numeric, char/varchar/nvarchar, binary, and TDS 7.3
  date/time types). Unknown base types fall back to the raw payload bytes as
  binary. This path is only reached for result sets that bypass DBX's
  `sql_variant`→`nvarchar` rewrite (simple-query batches used by plan and
  statistics diagnostics); upstream's `todo!()` there panicked and, under
  `panic = "abort"`, killed the app.
- CLR user-defined types (UDT, 0xF0) metadata is parsed (max length plus the
  database, schema, type, and assembly names) and values decode as binary, so
  spatial columns no longer hit `todo!()` on the same paths.
- Remaining unimplemented decoders now return protocol/encoding errors instead
  of panicking (`VarLenType` fallbacks, `intn` invalid lengths).

The regression tests in `src/tds/codec/column_data.rs` exercise the decoder
with raw TDS value frames. The `sql_variant` decoder has its own tests in
`src/tds/codec/column_data/sql_variant.rs`. The upstream integration fixtures
are omitted from this minimal vendor copy because the crates.io manifest does
not include their repository-only `runtimes-macro` dependency; library unit
tests remain enabled. Upstream tracks the same failure in
<https://github.com/prisma/tiberius/issues/325>. Remove this patch after an
equivalent fix is released upstream.
