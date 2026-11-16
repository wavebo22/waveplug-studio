// What WavePlug 设置.exe installs travels inside the exe: scripts/package_setup.mjs appends an
// archive to the built exe, then the archive's length and a magic tag. Archive: "WPPK1\n", then for
// each file its name (u32 length + UTF-8) and its bytes (u64 length + data), little-endian.

use serde::Deserialize;

pub const MAGIC: &[u8; 16] = b"WAVEPLUG-PAYLOAD";
pub const HEAD: &[u8; 6] = b"WPPK1\n";

/// payload.json: the versions inside
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Info {
    /// the Photoshop plugin's version (what this installer calls its version)
    pub version: String,
    #[serde(default)]
    pub ai_version: String,
    #[serde(default)]
    pub helper_version: String,
    #[serde(default)]
    pub built: String,
}

pub struct Payload {
    pub files: Vec<(String, Vec<u8>)>,
}

impl Payload {
    pub fn parse(mut b: &[u8]) -> Result<Payload, String> {
        if !b.starts_with(HEAD) {
            return Err("安装包内容损坏（开头不对）".into());
        }
        b = &b[HEAD.len()..];
        let mut files = Vec::new();
        while !b.is_empty() {
            let n = take_u32(&mut b)? as usize;
            if b.len() < n {
                return Err("安装包内容损坏（文件名）".into());
            }
            let name = String::from_utf8(b[..n].to_vec()).map_err(|_| "安装包内容损坏（文件名编码）".to_string())?;
            b = &b[n..];
            let len = take_u64(&mut b)? as usize;
            if b.len() < len {
                return Err(format!("安装包内容损坏（{name} 不完整）"));
            }
            files.push((name, b[..len].to_vec()));
            b = &b[len..];
        }
        Ok(Payload { files })
    }

    pub fn get(&self, name: &str) -> Option<&[u8]> {
        self.files.iter().find(|(n, _)| n == name).map(|(_, d)| d.as_slice())
    }

    /// files under `prefix/`, with the prefix taken off
    pub fn under<'a>(&'a self, prefix: &'a str) -> impl Iterator<Item = (&'a str, &'a [u8])> + 'a {
        self.files.iter().filter_map(move |(n, d)| n.strip_prefix(prefix).and_then(|r| r.strip_prefix('/')).map(|r| (r, d.as_slice())))
    }

    pub fn info(&self) -> Option<Info> {
        serde_json::from_slice(self.get("payload.json")?).ok()
    }
}

/// The archive at the end of an exe, if one was appended.
pub fn split(exe: &[u8]) -> Option<&[u8]> {
    if exe.len() < 24 || &exe[exe.len() - 16..] != MAGIC {
        return None;
    }
    let mut lb = [0u8; 8];
    lb.copy_from_slice(&exe[exe.len() - 24..exe.len() - 16]);
    let len = u64::from_le_bytes(lb) as usize;
    let end = exe.len() - 24;
    if len > end {
        return None;
    }
    Some(&exe[end - len..end])
}

/// The archive of `files` (what package_setup.mjs writes; used by the tests).
#[cfg(test)]
pub fn encode(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = HEAD.to_vec();
    for (n, d) in files {
        out.extend((n.len() as u32).to_le_bytes());
        out.extend(n.as_bytes());
        out.extend((d.len() as u64).to_le_bytes());
        out.extend(*d);
    }
    out
}

/// The payload of the running exe (None: a development build without one).
pub fn read_self() -> Result<Option<Payload>, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    read_exe(&exe)
}

pub fn read_exe(path: &std::path::Path) -> Result<Option<Payload>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读不了 {}：{e}", path.display()))?;
    match split(&bytes) {
        Some(a) => Payload::parse(a).map(Some),
        None => Ok(None),
    }
}

fn take_u32(b: &mut &[u8]) -> Result<u32, String> {
    if b.len() < 4 {
        return Err("安装包内容损坏".into());
    }
    let v = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
    *b = &b[4..];
    Ok(v)
}

fn take_u64(b: &mut &[u8]) -> Result<u64, String> {
    if b.len() < 8 {
        return Err("安装包内容损坏".into());
    }
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[..8]);
    *b = &b[8..];
    Ok(u64::from_le_bytes(a))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exe_with(archive: &[u8]) -> Vec<u8> {
        let mut exe = b"MZ fake exe body".to_vec();
        exe.extend(archive);
        exe.extend((archive.len() as u64).to_le_bytes());
        exe.extend(MAGIC);
        exe
    }

    #[test]
    fn round_trip_through_an_exe() {
        let info = br#"{"version":"1.2.0","ai_version":"0.1.0","helper_version":"0.15.0","built":"11-15"}"#;
        let a = encode(&[("payload.json", info), ("WavePlug.ccx", b"PK.."), ("ai/CSXS/manifest.xml", b"<x/>"), ("ai/main.js", b"js")]);
        let exe = exe_with(&a);
        let p = Payload::parse(split(&exe).unwrap()).unwrap();
        assert_eq!(p.get("WavePlug.ccx"), Some(&b"PK.."[..]));
        assert_eq!(p.info().unwrap().version, "1.2.0");
        let ai: Vec<_> = p.under("ai").map(|(n, _)| n).collect();
        assert_eq!(ai, vec!["CSXS/manifest.xml", "main.js"]);
    }

    #[test]
    fn no_payload_or_a_broken_one() {
        assert!(split(b"MZ just an exe without anything").is_none());
        let mut exe = exe_with(&encode(&[("a", b"123")]));
        // claims more than there is
        let n = exe.len();
        exe[n - 24..n - 16].copy_from_slice(&(10_000u64).to_le_bytes());
        assert!(split(&exe).is_none());
        assert!(Payload::parse(b"WPPK1\n\x05\x00\x00\x00ab").is_err());
        assert!(Payload::parse(b"nope").is_err());
    }
}
