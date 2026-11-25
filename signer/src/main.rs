use ed25519_dalek::pkcs8::{DecodePrivateKey, DecodePublicKey};
use ed25519_dalek::{SigningKey, VerifyingKey};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use teamwork_signer::{
    process_request, SignerConfig, DEFAULT_CLOCK_SKEW_SECS, DEFAULT_MAX_APPROVAL_BYTES,
    DEFAULT_MAX_APPROVAL_TTL_SECS, DEFAULT_MAX_REQUEST_BYTES,
};

fn load_signing_key(path: &Path) -> Result<SigningKey, String> {
    let meta = fs::metadata(path).map_err(|e| format!("key file unreadable: {}", e))?;
    if !meta.is_file() {
        return Err("key file must be a regular file".into());
    }
    if meta.mode() & 0o077 != 0 {
        return Err(format!(
            "key file mode {:o} is too permissive (must not allow group/other access)",
            meta.mode() & 0o777
        ));
    }
    let pem = fs::read_to_string(path).map_err(|e| format!("failed reading key file: {}", e))?;
    SigningKey::from_pkcs8_pem(&pem).map_err(|e| format!("invalid Ed25519 PKCS#8 PEM key: {}", e))
}

fn load_verifying_key(path: &Path) -> Result<VerifyingKey, String> {
    let pem = fs::read_to_string(path).map_err(|e| format!("failed reading approver key: {}", e))?;
    VerifyingKey::from_public_key_pem(&pem)
        .map_err(|e| format!("invalid Ed25519 SPKI PEM public key: {}", e))
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(target_os = "linux")]
fn peer_uid_from_stream(stream: &std::os::unix::net::UnixStream) -> Option<u32> {
    use std::os::unix::io::AsRawFd;
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut _ as *mut libc::c_void,
            &mut len,
        )
    };
    if rc == 0 {
        Some(cred.uid)
    } else {
        None
    }
}

#[cfg(not(target_os = "linux"))]
fn peer_uid_from_stream(_stream: &std::os::unix::net::UnixStream) -> Option<u32> {
    None
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut key_file: Option<PathBuf> = None;
    let mut key_id: Option<String> = None;
    let mut approval_dir: Option<PathBuf> = None;
    let mut approver_key_file: Option<PathBuf> = None;
    let mut approver_key_id: Option<String> = None;
    let mut audit_log: Option<PathBuf> = None;
    let mut ledger_path: Option<PathBuf> = None;
    let mut socket_path: Option<PathBuf> = None;
    let mut workload_uid: Option<u32> = None;
    let mut approver_uid: Option<u32> = None;
    let mut max_request_bytes = DEFAULT_MAX_REQUEST_BYTES;
    let mut max_approval_bytes = DEFAULT_MAX_APPROVAL_BYTES;
    let mut max_approval_ttl_secs = DEFAULT_MAX_APPROVAL_TTL_SECS;
    let mut clock_skew_secs = DEFAULT_CLOCK_SKEW_SECS;

    let mut i = 1;
    while i < args.len() {
        let flag = args[i].as_str();
        let next = |idx: &mut usize| -> String {
            *idx += 1;
            args.get(*idx).cloned().unwrap_or_default()
        };
        match flag {
            "--key-file" => key_file = Some(PathBuf::from(next(&mut i))),
            "--key-id" => key_id = Some(next(&mut i)),
            "--approval-dir" => approval_dir = Some(PathBuf::from(next(&mut i))),
            "--approver-key" => approver_key_file = Some(PathBuf::from(next(&mut i))),
            "--approver-key-id" => approver_key_id = Some(next(&mut i)),
            "--audit-log" => audit_log = Some(PathBuf::from(next(&mut i))),
            "--ledger" => ledger_path = Some(PathBuf::from(next(&mut i))),
            "--socket" => socket_path = Some(PathBuf::from(next(&mut i))),
            "--workload-uid" => workload_uid = next(&mut i).parse().ok(),
            "--approver-uid" => approver_uid = next(&mut i).parse().ok(),
            "--max-request-bytes" => {
                if let Ok(n) = next(&mut i).parse() {
                    max_request_bytes = n;
                }
            }
            "--max-approval-bytes" => {
                if let Ok(n) = next(&mut i).parse() {
                    max_approval_bytes = n;
                }
            }
            "--max-approval-ttl" => {
                if let Ok(n) = next(&mut i).parse() {
                    max_approval_ttl_secs = n;
                }
            }
            "--clock-skew" => {
                if let Ok(n) = next(&mut i).parse() {
                    clock_skew_secs = n;
                }
            }
            _ => {}
        }
        i += 1;
    }

    let signing_key = match key_file.as_deref().ok_or("missing --key-file".to_string()).and_then(load_signing_key) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("teamwork-signer: startup failed closed: {}", e);
            std::process::exit(1);
        }
    };
    let approver_key = match approver_key_file
        .as_deref()
        .ok_or("missing --approver-key".to_string())
        .and_then(load_verifying_key)
    {
        Ok(k) => k,
        Err(e) => {
            eprintln!("teamwork-signer: startup failed closed: {}", e);
            std::process::exit(1);
        }
    };

    let cfg = SignerConfig {
        key_id: key_id.unwrap_or_else(|| "signer_default".into()),
        signing_key,
        approver_key_id: approver_key_id.unwrap_or_else(|| "approver_default".into()),
        approver_key,
        approval_dir: approval_dir.unwrap_or_else(|| PathBuf::from("/var/lib/teamwork-approvals/signer")),
        audit_log: audit_log.unwrap_or_else(|| PathBuf::from("/var/log/teamwork/signer-audit.jsonl")),
        ledger_path,
        workload_uid,
        approver_uid,
        allow_same_uid_for_test: false,
        max_request_bytes,
        max_approval_bytes,
        max_approval_ttl_secs,
        clock_skew_secs,
    };

    if let Some(sock) = socket_path {
        let _ = fs::remove_file(&sock);
        let listener = match UnixListener::bind(&sock) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("teamwork-signer: bind failed: {}", e);
                std::process::exit(1);
            }
        };
        for stream in listener.incoming() {
            if let Ok(mut s) = stream {
                let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
                let peer = peer_uid_from_stream(&s);
                let mut buf = Vec::new();
                let _ = std::io::Read::by_ref(&mut s).take((cfg.max_request_bytes + 1) as u64).read_to_end(&mut buf);
                let resp = process_request(&buf, &cfg, now_unix(), peer);
                let json = serde_json::to_string(&resp).unwrap_or_else(|_| "{\"ok\":false,\"error\":\"E_INTERNAL\"}".into());
                let _ = writeln!(s, "{}", json);
            }
        }
    } else {
        let mut buf = Vec::new();
        let _ = std::io::stdin()
            .take((cfg.max_request_bytes + 1) as u64)
            .read_to_end(&mut buf);
        let resp = process_request(&buf, &cfg, now_unix(), None);
        println!("{}", serde_json::to_string(&resp).unwrap());
        if !resp.ok {
            std::process::exit(1);
        }
    }
}
