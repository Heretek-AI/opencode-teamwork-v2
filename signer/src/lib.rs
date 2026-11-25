use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::Sha256;
use std::collections::{BTreeMap, HashMap};
use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::io::{FromRawFd, RawFd};
use std::path::{Component, Path, PathBuf};
use subtle::ConstantTimeEq;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

type HmacSha256 = Hmac<Sha256>;

pub const ARTIFACT_DOMAIN: &str = "teamwork-artifact-v1";
pub const DIGEST_HMAC_KEY: &[u8] = b"teamwork-artifact-digest-v1";
pub const APPROVAL_DOMAIN: &str = "teamwork-signer-approval-v1";
pub const DEFAULT_MAX_REQUEST_BYTES: usize = 262_144;
pub const DEFAULT_MAX_APPROVAL_BYTES: usize = 65_536;
pub const DEFAULT_MAX_APPROVAL_TTL_SECS: i64 = 24 * 3600;
pub const MAX_ALLOWED_APPROVAL_TTL_SECS: i64 = 7 * 24 * 3600;
pub const DEFAULT_CLOCK_SKEW_SECS: i64 = 300;

#[derive(Clone)]
pub struct SignerConfig {
    pub key_id: String,
    pub signing_key: SigningKey,
    pub approver_key_id: String,
    pub approver_key: VerifyingKey,
    pub approval_dir: PathBuf,
    pub audit_log: PathBuf,
    pub ledger_path: Option<PathBuf>,
    pub workload_uid: Option<u32>,
    pub approver_uid: Option<u32>,
    pub allow_same_uid_for_test: bool,
    pub max_request_bytes: usize,
    pub max_approval_bytes: usize,
    pub max_approval_ttl_secs: i64,
    pub clock_skew_secs: i64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SignResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alg: Option<String>,
    #[serde(rename = "keyId", skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sig: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl SignResponse {
    pub fn err(code: &str, msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            v: None,
            alg: None,
            key_id: None,
            sig: None,
            error: Some(code.to_string()),
            message: Some(msg.into()),
        }
    }

    pub fn ok_sig(key_id: &str, sig: String) -> Self {
        Self {
            ok: true,
            v: Some(2),
            alg: Some("ed25519".to_string()),
            key_id: Some(key_id.to_string()),
            sig: Some(sig),
            error: None,
            message: None,
        }
    }
}

/// Strict canonical JSON serializer matching `plugins/opencode-teamwork/approval-format.mjs`.
/// Rejects non-ASCII object keys and non-finite numbers.
pub fn canonical_json(value: &Value) -> Result<String, &'static str> {
    let mut out = String::new();
    write_canonical(value, &mut out)?;
    Ok(out)
}

fn write_canonical(value: &Value, out: &mut String) -> Result<(), &'static str> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                if !f.is_finite() {
                    return Err("non-finite number");
                }
            }
            out.push_str(&n.to_string());
        }
        Value::String(s) => {
            let escaped = serde_json::to_string(s).map_err(|_| "string escape failed")?;
            out.push_str(&escaped);
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut sorted: BTreeMap<&str, &Value> = BTreeMap::new();
            for (k, v) in map {
                if !k.is_ascii() {
                    return Err("non-ASCII object key");
                }
                sorted.insert(k.as_str(), v);
            }
            out.push('{');
            for (i, (k, v)) in sorted.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                let escaped = serde_json::to_string(k).map_err(|_| "key escape failed")?;
                out.push_str(&escaped);
                out.push(':');
                write_canonical(v, out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// Parse JSON rejecting duplicate object keys at any nesting depth.
pub fn parse_json_no_duplicates(input: &str) -> Result<Value, String> {
    struct NoDupVisitor;

    impl<'de> serde::de::Visitor<'de> for NoDupVisitor {
        type Value = Value;

        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("any valid JSON value without duplicate keys")
        }

        fn visit_bool<E>(self, v: bool) -> Result<Value, E> {
            Ok(Value::Bool(v))
        }
        fn visit_i64<E>(self, v: i64) -> Result<Value, E> {
            Ok(Value::Number(v.into()))
        }
        fn visit_u64<E>(self, v: u64) -> Result<Value, E> {
            Ok(Value::Number(v.into()))
        }
        fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Value, E> {
            if !v.is_finite() {
                return Err(E::custom("non-finite number"));
            }
            serde_json::Number::from_f64(v)
                .map(Value::Number)
                .ok_or_else(|| E::custom("invalid float"))
        }
        fn visit_str<E>(self, v: &str) -> Result<Value, E> {
            Ok(Value::String(v.to_string()))
        }
        fn visit_string<E>(self, v: String) -> Result<Value, E> {
            Ok(Value::String(v))
        }
        fn visit_unit<E>(self) -> Result<Value, E> {
            Ok(Value::Null)
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
            let mut vec = Vec::new();
            while let Some(elem) = seq.next_element_seed(NoDupSeed)? {
                vec.push(elem);
            }
            Ok(Value::Array(vec))
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
            let mut out = Map::new();
            while let Some(key) = map.next_key::<String>()? {
                if out.contains_key(&key) {
                    return Err(serde::de::Error::custom(format!("duplicate key: {}", key)));
                }
                let val = map.next_value_seed(NoDupSeed)?;
                out.insert(key, val);
            }
            Ok(Value::Object(out))
        }
    }

    struct NoDupSeed;
    impl<'de> serde::de::DeserializeSeed<'de> for NoDupSeed {
        type Value = Value;
        fn deserialize<D: serde::de::Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
            d.deserialize_any(NoDupVisitor)
        }
    }

    let mut de = serde_json::Deserializer::from_str(input);
    let val = serde::de::DeserializeSeed::deserialize(NoDupSeed, &mut de)
        .map_err(|e| e.to_string())?;
    de.end().map_err(|e| e.to_string())?;
    Ok(val)
}

/// Keyed artifact digest: HMAC-SHA256("teamwork-artifact-digest-v1", canonical_json).
pub fn keyed_digest(canonical: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(DIGEST_HMAC_KEY).expect("HMAC accepts any key size");
    mac.update(canonical.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub fn decode_strict_base64url(input: &str) -> Result<Vec<u8>, &'static str> {
    if input.is_empty()
        || input.contains('=')
        || input.bytes().any(|b| b.is_ascii_whitespace())
    {
        return Err("non-canonical base64url");
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(input.as_bytes())
        .map_err(|_| "invalid base64url")?;
    if URL_SAFE_NO_PAD.encode(&bytes) != input {
        return Err("base64url re-encode mismatch");
    }
    Ok(bytes)
}

fn valid_run_id(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || b.len() > 64 {
        return false;
    }
    if !b[0].is_ascii_alphanumeric() {
        return false;
    }
    b[1..]
        .iter()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

fn valid_rel_path(s: &str) -> Result<(), &'static str> {
    if s.is_empty() || s.starts_with('/') || s.contains('\0') {
        return Err("E_PATH");
    }
    for seg in s.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err("E_PATH");
        }
    }
    if s == "approvals" || s.starts_with("approvals/") || s.starts_with("./approvals/") {
        return Err("E_APPROVAL_SCOPE");
    }
    Ok(())
}

fn valid_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_approved_by(s: &str) -> bool {
    (s.starts_with("uid:") && s.len() > 4)
        || (s.starts_with("oidc:") && s.contains('#'))
        || (s.starts_with("ci:") && s.len() > 3)
}

fn parse_rfc3339(s: &str) -> Result<i64, &'static str> {
    OffsetDateTime::parse(s, &Rfc3339)
        .map(|dt| dt.unix_timestamp())
        .map_err(|_| "invalid ISO-8601 timestamp")
}

/// Safely open an approval file relative to `approval_dir` using `O_DIRECTORY|O_NOFOLLOW`
/// on the parent directory and `O_RDONLY|O_NOFOLLOW` via `openat` on each relative component.
fn open_approval_safely(
    approval_ref: &str,
    cfg: &SignerConfig,
    peer_uid: Option<u32>,
) -> Result<Vec<u8>, (&'static str, String)> {
    let ref_path = Path::new(approval_ref);
    if !ref_path.is_absolute() {
        return Err(("E_APPROVAL_OPEN", "approvalRef must be absolute".into()));
    }
    for comp in ref_path.components() {
        if matches!(comp, Component::ParentDir) {
            return Err(("E_APPROVAL_OPEN", "approvalRef contains '..'".into()));
        }
    }
    let canonical_dir = std::fs::canonicalize(&cfg.approval_dir)
        .map_err(|e| ("E_APPROVAL_OPEN", format!("approval dir unreadable: {}", e)))?;
    let rel = ref_path
        .strip_prefix(&canonical_dir)
        .or_else(|_| ref_path.strip_prefix(&cfg.approval_dir))
        .map_err(|_| ("E_APPROVAL_OPEN", "approvalRef is outside approval dir".into()))?;

    let components: Vec<&std::ffi::OsStr> = rel
        .components()
        .map(|c| match c {
            Component::Normal(s) => Ok(s),
            _ => Err(("E_APPROVAL_OPEN", "invalid approvalRef component".into())),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if components.is_empty() {
        return Err(("E_APPROVAL_OPEN", "approvalRef points to directory".into()));
    }

    let c_dir = CString::new(canonical_dir.as_os_str().as_bytes())
        .map_err(|_| ("E_APPROVAL_OPEN", "NUL in approval dir".into()))?;
    let mut cur_fd: RawFd = unsafe {
        libc::open(
            c_dir.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if cur_fd < 0 {
        return Err(("E_APPROVAL_OPEN", "failed to open approval dir".into()));
    }

    // Traverse intermediate subdirectories with O_DIRECTORY | O_NOFOLLOW.
    for dir_seg in &components[..components.len() - 1] {
        let c_seg = CString::new(dir_seg.as_bytes()).map_err(|_| {
            unsafe { libc::close(cur_fd) };
            ("E_APPROVAL_OPEN", "NUL in approvalRef segment".into())
        })?;
        let next_fd = unsafe {
            libc::openat(
                cur_fd,
                c_seg.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        unsafe { libc::close(cur_fd) };
        if next_fd < 0 {
            return Err(("E_APPROVAL_OPEN", "failed to open approval subdirectory (symlink or missing)".into()));
        }
        cur_fd = next_fd;
    }

    let file_seg = components[components.len() - 1];
    let c_file = CString::new(file_seg.as_bytes()).map_err(|_| {
        unsafe { libc::close(cur_fd) };
        ("E_APPROVAL_OPEN", "NUL in approval filename".into())
    })?;
    let file_fd = unsafe {
        libc::openat(
            cur_fd,
            c_file.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    unsafe { libc::close(cur_fd) };
    if file_fd < 0 {
        return Err(("E_APPROVAL_OPEN", "failed to open approval file (missing or symlink)".into()));
    }

    let file = unsafe { File::from_raw_fd(file_fd) };
    let meta = file
        .metadata()
        .map_err(|_| ("E_APPROVAL_OPEN", "fstat failed on approval file".into()))?;
    if !meta.is_file() {
        return Err(("E_APPROVAL_OPEN", "approvalRef is not a regular file".into()));
    }
    if meta.len() as usize > cfg.max_approval_bytes {
        return Err(("E_APPROVAL_OPEN", "approval file exceeds size bound".into()));
    }
    if meta.mode() & 0o022 != 0 {
        return Err(("E_APPROVAL_OWNER", "approval file must not be group/other writable".into()));
    }

    let file_uid = meta.uid();
    if let Some(expected_approver) = cfg.approver_uid {
        if file_uid != expected_approver {
            return Err(("E_APPROVAL_OWNER", format!("approval file uid {} != approver uid {}", file_uid, expected_approver)));
        }
    }
    if !cfg.allow_same_uid_for_test {
        let disallowed_uid = cfg.workload_uid.or(peer_uid).unwrap_or_else(|| unsafe { libc::geteuid() });
        if file_uid == disallowed_uid {
            return Err(("E_APPROVAL_OWNER", format!("approval file owned by workload uid {}", file_uid)));
        }
    }

    let mut buf = Vec::with_capacity((meta.len() as usize).min(cfg.max_approval_bytes) + 1);
    file.take((cfg.max_approval_bytes + 1) as u64)
        .read_to_end(&mut buf)
        .map_err(|_| ("E_APPROVAL_OPEN", "failed reading approval file".into()))?;
    if buf.len() > cfg.max_approval_bytes {
        return Err(("E_APPROVAL_OPEN", "approval file grew past size bound".into()));
    }
    Ok(buf)
}

fn check_and_record_ledger(
    ledger_path: &Path,
    approval_id: &str,
    request_fingerprint: &str,
) -> Result<(), (&'static str, String)> {
    let mut entries: HashMap<String, String> = HashMap::new();
    if ledger_path.exists() {
        let content = std::fs::read_to_string(ledger_path)
            .map_err(|e| ("E_INTERNAL", format!("failed reading ledger: {}", e)))?;
        for line in content.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let v: Value = serde_json::from_str(line)
                .map_err(|e| ("E_INTERNAL", format!("corrupt ledger line: {}", e)))?;
            if let (Some(id), Some(fp)) = (
                v.get("approvalId").and_then(|x| x.as_str()),
                v.get("fingerprint").and_then(|x| x.as_str()),
            ) {
                entries.insert(id.to_string(), fp.to_string());
            }
        }
    }
    if let Some(prev_fp) = entries.get(approval_id) {
        if prev_fp != request_fingerprint {
            return Err((
                "E_APPROVAL_REPLAY",
                "approvalId already used for a different request".into(),
            ));
        }
        return Ok(());
    }
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(ledger_path)
        .map_err(|e| ("E_INTERNAL", format!("failed opening ledger: {}", e)))?;
    let line = serde_json::json!({
        "approvalId": approval_id,
        "fingerprint": request_fingerprint,
    })
    .to_string();
    writeln!(f, "{}", line).map_err(|e| ("E_INTERNAL", format!("ledger write failed: {}", e)))?;
    f.sync_all()
        .map_err(|e| ("E_INTERNAL", format!("ledger fsync failed: {}", e)))?;
    Ok(())
}

fn append_audit_line(audit_log: &Path, record: &Value) -> Result<(), (&'static str, String)> {
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(audit_log)
        .map_err(|e| ("E_AUDIT", format!("audit open failed: {}", e)))?;
    let line = serde_json::to_string(record)
        .map_err(|e| ("E_AUDIT", format!("audit serialize failed: {}", e)))?;
    writeln!(f, "{}", line).map_err(|e| ("E_AUDIT", format!("audit write failed: {}", e)))?;
    f.sync_all()
        .map_err(|e| ("E_AUDIT", format!("audit fsync failed: {}", e)))?;
    Ok(())
}

/// Process one v2 signing request according to the six checks in `docs/SIGNER-PROTOCOL.md` §5.
pub fn process_request(
    raw: &[u8],
    cfg: &SignerConfig,
    now_unix_secs: i64,
    peer_uid: Option<u32>,
) -> SignResponse {
    if raw.len() > cfg.max_request_bytes {
        return SignResponse::err("E_REQUEST", "request exceeds max_request_bytes");
    }
    if let (Some(expected_peer), Some(actual_peer)) = (cfg.workload_uid, peer_uid) {
        if actual_peer != expected_peer {
            return SignResponse::err("E_PEER", format!("peer uid {} != workload uid {}", actual_peer, expected_peer));
        }
    }

    let raw_str = match std::str::from_utf8(raw) {
        Ok(s) => s,
        Err(_) => return SignResponse::err("E_REQUEST", "request is not valid UTF-8"),
    };
    let req_val = match parse_json_no_duplicates(raw_str) {
        Ok(Value::Object(m)) => m,
        _ => return SignResponse::err("E_REQUEST", "request must be a JSON object without duplicate keys"),
    };

    // Check 1: Version, op, alg, keyId, runId, path, time.
    match req_val.get("v").and_then(|v| v.as_u64()) {
        Some(2) => {}
        _ => return SignResponse::err("E_VERSION", "only v2 requests are accepted; v1 is refused"),
    }
    match req_val.get("op").and_then(|v| v.as_str()) {
        Some("sign-artifact") => {}
        _ => return SignResponse::err("E_OP", "op must be \"sign-artifact\""),
    }
    match req_val.get("alg").and_then(|v| v.as_str()) {
        Some("ed25519") => {}
        _ => return SignResponse::err("E_ALG", "alg must be \"ed25519\""),
    }
    let key_id = match req_val.get("keyId").and_then(|v| v.as_str()) {
        Some(s) if s == cfg.key_id => s,
        _ => return SignResponse::err("E_KEYID", "keyId does not match configured signer keyId"),
    };
    let run_id = match req_val.get("runId").and_then(|v| v.as_str()) {
        Some(s) if valid_run_id(s) => s,
        _ => return SignResponse::err("E_REQUEST", "invalid or missing runId"),
    };
    let path = match req_val.get("path").and_then(|v| v.as_str()) {
        Some(s) => {
            if let Err(code) = valid_rel_path(s) {
                return SignResponse::err(code, "invalid or forbidden artifact path");
            }
            s
        }
        None => return SignResponse::err("E_PATH", "missing path"),
    };
    let req_digest = match req_val.get("digest").and_then(|v| v.as_str()) {
        Some(s) if valid_hex64(s) => s,
        _ => return SignResponse::err("E_DIGEST", "digest must be 64 lowercase hex chars"),
    };
    let nonce = match req_val.get("nonce").and_then(|v| v.as_str()) {
        Some(s) => match decode_strict_base64url(s) {
            Ok(b) if b.len() >= 16 => s,
            _ => return SignResponse::err("E_REQUEST", "nonce must be >= 16 decoded bytes of base64url"),
        },
        None => return SignResponse::err("E_REQUEST", "missing nonce"),
    };
    let at_str = match req_val.get("at").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return SignResponse::err("E_REQUEST", "missing at timestamp"),
    };
    let at_secs = match parse_rfc3339(at_str) {
        Ok(t) => t,
        Err(e) => return SignResponse::err("E_REQUEST", e),
    };
    if (now_unix_secs - at_secs).abs() > cfg.clock_skew_secs {
        return SignResponse::err("E_REQUEST", "request timestamp outside allowed clock skew");
    }
    let approval_ref = match req_val.get("approvalRef").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s,
        _ => return SignResponse::err("E_APPROVAL_OPEN", "missing approvalRef"),
    };
    let message_b64 = match req_val.get("message").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return SignResponse::err("E_MESSAGE", "missing message"),
    };

    // Check 2: Decode and validate the 6-field NUL-separated message + canonical JSON.
    let message_bytes = match decode_strict_base64url(message_b64) {
        Ok(b) => b,
        Err(e) => return SignResponse::err("E_MESSAGE", e),
    };
    let message_str = match std::str::from_utf8(&message_bytes) {
        Ok(s) => s,
        Err(_) => return SignResponse::err("E_MESSAGE", "message is not valid UTF-8"),
    };
    let fields: Vec<&str> = message_str.split('\0').collect();
    if fields.len() != 6 {
        return SignResponse::err("E_MESSAGE", format!("expected 6 NUL-separated fields, got {}", fields.len()));
    }
    if fields[0] != ARTIFACT_DOMAIN
        || fields[1] != "ed25519"
        || fields[2] != key_id
        || fields[3] != path
        || fields[4] != nonce
    {
        return SignResponse::err("E_MESSAGE", "message header fields do not match request");
    }
    let payload_val = match parse_json_no_duplicates(fields[5]) {
        Ok(v @ Value::Object(_)) => v,
        _ => return SignResponse::err("E_CANONICAL", "message payload must be a JSON object without duplicate keys"),
    };
    let recanon = match canonical_json(&payload_val) {
        Ok(s) => s,
        Err(e) => return SignResponse::err("E_CANONICAL", e),
    };
    if recanon.as_bytes() != fields[5].as_bytes() {
        return SignResponse::err("E_CANONICAL", "message payload is not canonical JSON");
    }

    // Check 3: Recompute keyed digest and constant-time compare.
    let recomputed = keyed_digest(&recanon);
    if !bool::from(recomputed.as_bytes().ct_eq(req_digest.as_bytes())) {
        return SignResponse::err("E_DIGEST", "recomputed keyed digest does not match request.digest");
    }

    // Check 4: Open approval file safely.
    let approval_bytes = match open_approval_safely(approval_ref, cfg, peer_uid) {
        Ok(b) => b,
        Err((code, msg)) => return SignResponse::err(code, msg),
    };
    let approval_str = match std::str::from_utf8(&approval_bytes) {
        Ok(s) => s,
        Err(_) => return SignResponse::err("E_APPROVAL_OPEN", "approval file is not valid UTF-8"),
    };
    let approval_obj = match parse_json_no_duplicates(approval_str) {
        Ok(Value::Object(m)) => m,
        _ => return SignResponse::err("E_APPROVAL_BINDING", "approval must be a JSON object"),
    };

    // Check 5: Verify approval schema, signature, binding, expiry, and ledger.
    if approval_obj.get("v").and_then(|v| v.as_u64()) != Some(1)
        || approval_obj.get("kind").and_then(|v| v.as_str()) != Some("teamwork.signer-approval")
    {
        return SignResponse::err("E_APPROVAL_BINDING", "invalid approval v or kind");
    }
    let auth_obj = match approval_obj.get("_auth").and_then(|v| v.as_object()) {
        Some(m) => m,
        None => return SignResponse::err("E_APPROVAL_SIG", "approval missing _auth"),
    };
    if auth_obj.get("alg").and_then(|v| v.as_str()) != Some("ed25519") {
        return SignResponse::err("E_APPROVAL_SIG", "approval _auth.alg must be ed25519");
    }
    if auth_obj.get("keyId").and_then(|v| v.as_str()) != Some(cfg.approver_key_id.as_str()) {
        return SignResponse::err("E_APPROVAL_SIG", "approval _auth.keyId mismatch");
    }
    let sig_b64 = match auth_obj.get("sig").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return SignResponse::err("E_APPROVAL_SIG", "approval missing _auth.sig"),
    };
    let sig_bytes = match decode_strict_base64url(sig_b64) {
        Ok(b) if b.len() == 64 => b,
        _ => return SignResponse::err("E_APPROVAL_SIG", "invalid approval Ed25519 signature encoding"),
    };
    let sig_arr: [u8; 64] = sig_bytes.try_into().unwrap();
    let approval_sig = Signature::from_bytes(&sig_arr);

    let app_run_id = approval_obj.get("runId").and_then(|v| v.as_str()).unwrap_or("");
    let app_path = approval_obj.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let app_digest = approval_obj.get("digest").and_then(|v| v.as_str()).unwrap_or("");
    let app_nonce = approval_obj.get("nonce").and_then(|v| v.as_str()).unwrap_or("");
    let app_approved_at = approval_obj.get("approvedAt").and_then(|v| v.as_str()).unwrap_or("");
    let app_expires_at = approval_obj.get("expiresAt").and_then(|v| v.as_str()).unwrap_or("");
    let app_approved_by = approval_obj.get("approvedBy").and_then(|v| v.as_str()).unwrap_or("");
    let app_id = approval_obj.get("approvalId").and_then(|v| v.as_str()).unwrap_or("");

    // Verify signature over payload without _auth.
    let mut unsigned_approval = approval_obj.clone();
    unsigned_approval.remove("_auth");
    let app_canon = match canonical_json(&Value::Object(unsigned_approval)) {
        Ok(s) => s,
        Err(e) => return SignResponse::err("E_APPROVAL_SIG", e),
    };
    let app_sig_input = format!(
        "{}\0{}\0{}\0{}\0{}\0{}\0{}",
        APPROVAL_DOMAIN, app_run_id, app_path, app_digest, app_nonce, app_expires_at, app_canon
    );
    if cfg.approver_key.verify(app_sig_input.as_bytes(), &approval_sig).is_err() {
        return SignResponse::err("E_APPROVAL_SIG", "approval Ed25519 signature verification failed");
    }

    // Bindings.
    if app_run_id != run_id
        || app_path != path
        || !bool::from(app_digest.as_bytes().ct_eq(req_digest.as_bytes()))
        || app_nonce != nonce
    {
        return SignResponse::err("E_APPROVAL_BINDING", "approval binding mismatch (runId/path/digest/nonce)");
    }
    if !valid_approved_by(app_approved_by) {
        return SignResponse::err("E_APPROVAL_BINDING", "invalid approvedBy format");
    }
    match decode_strict_base64url(app_id) {
        Ok(b) if b.len() >= 16 => {}
        _ => return SignResponse::err("E_APPROVAL_BINDING", "approvalId must be >= 16 decoded bytes of base64url"),
    }

    // Expiry & lifetime.
    let approved_at_secs = match parse_rfc3339(app_approved_at) {
        Ok(t) => t,
        Err(_) => return SignResponse::err("E_APPROVAL_EXPIRED", "invalid approvedAt"),
    };
    let expires_at_secs = match parse_rfc3339(app_expires_at) {
        Ok(t) => t,
        Err(_) => return SignResponse::err("E_APPROVAL_EXPIRED", "invalid expiresAt"),
    };
    if expires_at_secs <= now_unix_secs {
        return SignResponse::err("E_APPROVAL_EXPIRED", "approval is expired");
    }
    if approved_at_secs > now_unix_secs + cfg.clock_skew_secs {
        return SignResponse::err("E_APPROVAL_EXPIRED", "approval approvedAt is in the future beyond clock skew");
    }
    let ttl = expires_at_secs - approved_at_secs;
    let max_ttl = cfg.max_approval_ttl_secs.min(MAX_ALLOWED_APPROVAL_TTL_SECS);
    if ttl <= 0 || ttl > max_ttl {
        return SignResponse::err("E_APPROVAL_EXPIRED", "approval lifetime exceeds configured max TTL");
    }

    // Durable single-use ledger (when enabled).
    if let Some(ref ledger_path) = cfg.ledger_path {
        let fp = format!("{}|{}|{}|{}", run_id, path, req_digest, nonce);
        if let Err((code, msg)) = check_and_record_ledger(ledger_path, app_id, &fp) {
            return SignResponse::err(code, msg);
        }
    }

    // Check 6: Append audit line BEFORE signing; failure returns E_AUDIT and no signature.
    let audit_record = serde_json::json!({
        "at": now_unix_secs,
        "op": "sign-artifact",
        "runId": run_id,
        "path": path,
        "digest": req_digest,
        "keyId": key_id,
        "approvalId": app_id,
        "approvedBy": app_approved_by,
        "peerUid": peer_uid,
    });
    if let Err((code, msg)) = append_audit_line(&cfg.audit_log, &audit_record) {
        return SignResponse::err(code, msg);
    }

    // All checks passed and audit persisted — sign decoded message bytes.
    let signature = cfg.signing_key.sign(&message_bytes);
    SignResponse::ok_sig(key_id, URL_SAFE_NO_PAD.encode(signature.to_bytes()))
}
