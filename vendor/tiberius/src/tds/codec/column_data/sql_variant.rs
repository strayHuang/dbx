//! `sql_variant` (SSVARIANT) value decoding.
//!
//! Upstream tiberius leaves `sql_variant` unimplemented, so any result set with
//! a `sql_variant` column panicked while decoding the row. With
//! `panic = "abort"` that aborts the whole process (DBX crashed with SIGABRT
//! on `dbo.GemFlow_Snapshot_Job_Log.last_key` during simple-query batches).
//!
//! A `sql_variant` value carries its own base type, so the payload can be
//! decoded into the matching [`ColumnData`] variant. Unknown base types fall
//! back to the raw payload bytes instead of panicking, keeping the rest of the
//! result set readable.

use byteorder::{ByteOrder, LittleEndian};
use uuid::Uuid;

use crate::{
    error::Error,
    sql_read_bytes::SqlReadBytes,
    tds::{codec::guid, Collation, Numeric},
    ColumnData,
};

#[cfg(feature = "tds73")]
use crate::tds::time::{Date, DateTime2, DateTimeOffset, Time};

/// `sql_variant` payloads are at most 8016 bytes (MS-TDS 2.2.5.4.3).
const MAX_VARIANT_LEN: usize = 8016;

// `sql_variant` base type bytes, from MS-TDS 2.2.5.5.2.4.
const TINY_INT: u8 = 0x30;
const BIT: u8 = 0x32;
const SMALL_INT: u8 = 0x34;
const INT: u8 = 0x38;
const SMALL_DATETIME: u8 = 0x3A;
const REAL: u8 = 0x3B;
const MONEY: u8 = 0x3C;
const DATETIME: u8 = 0x3D;
const FLOAT: u8 = 0x3E;
const SMALL_MONEY: u8 = 0x7A;
const BIG_INT: u8 = 0x7F;
const UNIQUE_IDENTIFIER: u8 = 0x24;
const NVARCHAR: u8 = 0xE7;
const NCHAR: u8 = 0xEF;
const VARCHAR: u8 = 0xA7;
const CHAR: u8 = 0xAF;
const VARBINARY: u8 = 0xA5;
const BINARY: u8 = 0xAD;
const DECIMAL: u8 = 0x6A;
const NUMERIC: u8 = 0x6C;
#[cfg(feature = "tds73")]
const DATE: u8 = 0x28;
#[cfg(feature = "tds73")]
const TIME: u8 = 0x29;
#[cfg(feature = "tds73")]
const DATETIME2: u8 = 0x2A;
#[cfg(feature = "tds73")]
const DATETIME_OFFSET: u8 = 0x2B;

fn protocol_error(message: &'static str) -> Error {
    Error::Protocol(message.into())
}

fn fixed<const N: usize>(data: &[u8]) -> crate::Result<&[u8; N]> {
    <&[u8; N]>::try_from(data.get(..N).ok_or_else(|| protocol_error("sql_variant: truncated payload"))?)
        .map_err(|_| protocol_error("sql_variant: truncated payload"))
}

pub(crate) async fn decode<R>(src: &mut R) -> crate::Result<ColumnData<'static>>
where
    R: SqlReadBytes + Unpin,
{
    let len = src.read_u32_le().await? as usize;

    // A zero length marks a NULL variant value.
    if len == 0 {
        return Ok(ColumnData::String(None));
    }

    if len > MAX_VARIANT_LEN {
        return Err(Error::Protocol(format!("sql_variant: invalid length {}", len).into()));
    }

    let mut buf = Vec::with_capacity(len);

    for _ in 0..len {
        buf.push(src.read_u8().await?);
    }

    decode_payload(&buf)
}

/// Decodes `[base type][properties length][properties][data]`.
fn decode_payload(buf: &[u8]) -> crate::Result<ColumnData<'static>> {
    let base = *buf.first().ok_or_else(|| protocol_error("sql_variant: empty payload"))?;
    let prop_len = *buf.get(1).ok_or_else(|| protocol_error("sql_variant: empty payload"))? as usize;

    let properties = buf.get(2..2 + prop_len).ok_or_else(|| protocol_error("sql_variant: truncated properties"))?;
    let data = &buf[2 + prop_len..];

    let value = match base {
        TINY_INT => ColumnData::U8(Some(fixed::<1>(data)?[0])),
        BIT => ColumnData::Bit(Some(fixed::<1>(data)?[0] != 0)),
        SMALL_INT => ColumnData::I16(Some(LittleEndian::read_i16(fixed::<2>(data)?))),
        INT => ColumnData::I32(Some(LittleEndian::read_i32(fixed::<4>(data)?))),
        BIG_INT => ColumnData::I64(Some(LittleEndian::read_i64(fixed::<8>(data)?))),
        REAL => ColumnData::F32(Some(LittleEndian::read_f32(fixed::<4>(data)?))),
        FLOAT => ColumnData::F64(Some(LittleEndian::read_f64(fixed::<8>(data)?))),
        SMALL_DATETIME => {
            let bytes = fixed::<4>(data)?;
            ColumnData::SmallDateTime(Some(crate::tds::time::SmallDateTime::new(
                LittleEndian::read_u16(&bytes[..2]),
                LittleEndian::read_u16(&bytes[2..]),
            )))
        }
        DATETIME => {
            let bytes = fixed::<8>(data)?;
            ColumnData::DateTime(Some(crate::tds::time::DateTime::new(
                LittleEndian::read_i32(&bytes[..4]),
                LittleEndian::read_u32(&bytes[4..]),
            )))
        }
        SMALL_MONEY => ColumnData::F64(Some(LittleEndian::read_i32(fixed::<4>(data)?) as f64 / 1e4)),
        MONEY => {
            let bytes = fixed::<8>(data)?;
            let high = LittleEndian::read_i32(&bytes[..4]) as i64;
            let low = LittleEndian::read_u32(&bytes[4..]) as f64;

            ColumnData::F64(Some(((high << 32) as f64 + low) / 1e4))
        }
        UNIQUE_IDENTIFIER => {
            let mut bytes = *fixed::<16>(data)?;
            guid::reorder_bytes(&mut bytes);

            ColumnData::Guid(Some(Uuid::from_bytes(bytes)))
        }
        NCHAR | NVARCHAR => {
            if data.len() % 2 != 0 {
                return Err(protocol_error("sql_variant: invalid nvarchar length"));
            }

            let utf16: Vec<u16> = data.chunks(2).map(|chunk| LittleEndian::read_u16(chunk)).collect();

            ColumnData::String(Some(String::from_utf16_lossy(&utf16).into()))
        }
        CHAR | VARCHAR => {
            let collation = variant_collation(properties)?;
            let (text, _) = collation.codec()?.decode_lossy(data);

            ColumnData::String(Some(text.into()))
        }
        BINARY | VARBINARY => ColumnData::Binary(Some(data.to_vec().into())),
        DECIMAL | NUMERIC => {
            let scale = *properties.get(1).ok_or_else(|| protocol_error("sql_variant: missing decimal scale"))?;
            let sign = match data.first() {
                Some(0) => -1i128,
                Some(1) => 1i128,
                _ => return Err(protocol_error("sql_variant: invalid decimal sign")),
            };
            let magnitude = match data.len() {
                5 => LittleEndian::read_u32(&data[1..]) as u128,
                9 => LittleEndian::read_u64(&data[1..]) as u128,
                13 => {
                    let low = LittleEndian::read_u64(&data[1..9]) as u128;
                    let high = LittleEndian::read_u32(&data[9..13]) as u128;

                    low | (high << 64)
                }
                17 => {
                    let low = LittleEndian::read_u64(&data[1..9]) as u128;
                    let high = LittleEndian::read_u64(&data[9..17]) as u128;

                    low | (high << 64)
                }
                _ => return Err(protocol_error("sql_variant: invalid decimal length")),
            };

            ColumnData::Numeric(Some(Numeric::new_with_scale(magnitude as i128 * sign, scale)))
        }
        #[cfg(feature = "tds73")]
        DATE => ColumnData::Date(Some(variant_date(data)?)),
        #[cfg(feature = "tds73")]
        TIME => {
            let scale = variant_time_scale(properties)?;
            let (time, _) = variant_time(scale, data)?;

            ColumnData::Time(Some(time))
        }
        #[cfg(feature = "tds73")]
        DATETIME2 => {
            let scale = variant_time_scale(properties)?;
            let (time, used) = variant_time(scale, data)?;

            ColumnData::DateTime2(Some(DateTime2::new(variant_date(&data[used..])?, time)))
        }
        #[cfg(feature = "tds73")]
        DATETIME_OFFSET => {
            let scale = variant_time_scale(properties)?;
            let (time, used) = variant_time(scale, data)?;
            let date = variant_date(&data[used..])?;
            let offset = LittleEndian::read_i16(fixed::<2>(&data[used + 3..])?);

            ColumnData::DateTimeOffset(Some(DateTimeOffset::new(DateTime2::new(date, time), offset)))
        }
        _ => ColumnData::Binary(Some(data.to_vec().into())),
    };

    Ok(value)
}

/// Char/varchar variants store the collation first, followed by the max length.
fn variant_collation(properties: &[u8]) -> crate::Result<Collation> {
    let raw = properties.get(0..5).ok_or_else(|| protocol_error("sql_variant: missing collation"))?;

    Ok(Collation::new(LittleEndian::read_u32(raw), raw[4]))
}

#[cfg(feature = "tds73")]
fn variant_date(data: &[u8]) -> crate::Result<Date> {
    let bytes = fixed::<3>(data)?;
    let mut raw = [0u8; 4];
    raw[..3].copy_from_slice(bytes);

    Ok(Date::new(LittleEndian::read_u32(&raw)))
}

#[cfg(feature = "tds73")]
fn variant_time_scale(properties: &[u8]) -> crate::Result<u8> {
    properties.first().copied().ok_or_else(|| protocol_error("sql_variant: missing time scale"))
}

#[cfg(feature = "tds73")]
fn variant_time(scale: u8, data: &[u8]) -> crate::Result<(Time, usize)> {
    let len = match scale {
        0..=2 => 3,
        3..=4 => 4,
        5..=7 => 5,
        _ => return Err(protocol_error("sql_variant: invalid time scale")),
    };
    let raw = data.get(..len).ok_or_else(|| protocol_error("sql_variant: truncated time"))?;
    let increments = match len {
        3 => LittleEndian::read_u16(raw) as u64 | (raw[2] as u64) << 16,
        4 => LittleEndian::read_u32(raw) as u64,
        _ => LittleEndian::read_u32(&raw[..4]) as u64 | (raw[4] as u64) << 32,
    };

    Ok((Time::new(increments, scale), len))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_read_bytes::test_utils::IntoSqlReadBytes;
    use bytes::BufMut;

    async fn decode_variant(len: Option<u32>, payload: &[u8]) -> crate::Result<ColumnData<'static>> {
        let mut wire = bytes::BytesMut::new();

        match len {
            Some(len) => wire.put_u32_le(len),
            None => wire.put_u32_le(payload.len() as u32),
        }
        wire.extend_from_slice(payload);

        decode(&mut wire.into_sql_read_bytes()).await
    }

    fn variant(base: u8, properties: &[u8], data: &[u8]) -> Vec<u8> {
        let mut buf = vec![base, properties.len() as u8];
        buf.extend_from_slice(properties);
        buf.extend_from_slice(data);

        buf
    }

    #[tokio::test]
    async fn null_variant_is_null() {
        let value = decode_variant(Some(0), &[]).await.expect("null variant");

        assert!(matches!(value, ColumnData::String(None)));
    }

    #[tokio::test]
    async fn int_variant_decodes() {
        let payload = variant(INT, &[], &2569086i32.to_le_bytes());
        let value = decode_variant(None, &payload).await.expect("int variant");

        assert!(matches!(value, ColumnData::I32(Some(2569086))));
    }

    #[tokio::test]
    async fn nvarchar_variant_decodes() {
        let mut utf16 = Vec::new();
        for chr in "主键".encode_utf16() {
            utf16.put_u16_le(chr);
        }

        let mut properties = 40u16.to_le_bytes().to_vec();
        properties.extend_from_slice(&[0x09, 0x04, 0x00, 0x00, 0x34]);

        let payload = variant(NVARCHAR, &properties, &utf16);
        let value = decode_variant(None, &payload).await.expect("nvarchar variant");

        assert!(matches!(value, ColumnData::String(Some(text)) if text.as_ref() == "主键"));
    }

    #[tokio::test]
    async fn varchar_variant_uses_collation_properties() {
        // Properties observed from SQL Server for a varchar variant: the
        // collation (Chinese_PRC, LCID 0x0804) comes first and the max length
        // (20) last.
        let properties = [0x04, 0x08, 0xd0, 0x00, 0x00, 0x14, 0x00];
        let payload = variant(VARCHAR, &properties, b"abc");
        let value = decode_variant(None, &payload).await.expect("varchar variant");

        assert!(matches!(value, ColumnData::String(Some(text)) if text.as_ref() == "abc"));
    }

    #[tokio::test]
    async fn decimal_variant_decodes_with_scale() {
        let payload = variant(DECIMAL, &[10, 2], &[1, 0x39, 0x30, 0x00, 0x00]);
        let value = decode_variant(None, &payload).await.expect("decimal variant");

        assert!(matches!(value, ColumnData::Numeric(Some(number)) if number.value() == 12345 && number.scale() == 2));
    }

    #[tokio::test]
    async fn unknown_base_type_keeps_raw_payload() {
        let payload = variant(0x42, &[], &[1, 2, 3]);
        let value = decode_variant(None, &payload).await.expect("unknown variant");

        assert!(matches!(value, ColumnData::Binary(Some(bytes)) if bytes.as_ref() == [1, 2, 3]));
    }

    #[tokio::test]
    async fn truncated_variant_is_a_protocol_error() {
        let payload = variant(INT, &[], &[1, 2]);
        let error = decode_variant(None, &payload).await.expect_err("truncated int variant");

        assert!(matches!(error, Error::Protocol(_)));
    }
}
