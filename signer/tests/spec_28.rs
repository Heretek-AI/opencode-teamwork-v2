use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier};
use serde_json::{json, Value};
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use teamwork_signer::{
    canonical_json, keyed_digest, process_request, SignerConfig, APPROVAL_DOMAIN, ARTIFACT_DOMAIN,
    DEFAULT_CLOCK_SKEW_SECS, DEFAULT_MAX_APPROVAL_BYTES, DEFAULT_MAX_APPROVAL_TTL_SECS,
    DEFAULT_MAX_REQUEST_BYTES,
};

const NOW: i64 = 1_795_435_200; // 2026-11-23T12:00:00Z
const AT_ISO: &str = "2026-11-23T12:00:00Z";
const APPROVED_AT_ISO: &str = "2026-11-23T11:55:00Z";
const EXPIRES_AT_ISO: &str = "2026-11-24T11:55:00Z";
const NONCE: &str = "AAAAAAAAAAAAAAAAAAAAAA";
const RUN_ID: &str = "r-01J8Z5K8V6Q9W2M4N7P3S6T8X0";
const APPROVAL_ID: &str = "BBBBBBBBBBBBBBBBBBBBBBBB";

struct Fixture {
    dir: PathBuf,
    cfg: SignerConfig,
    approver_sk: SigningKey,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("tw-signer-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let approval_dir = dir.join("approvals");
        fs::create_dir_all(approval_dir.join(RUN_ID)).unwrap();
        let audit_log = dir.join("audit.jsonl");

        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let approver_sk = SigningKey::from_bytes(&[9u8; 32]);
        let cfg = SignerConfig {
            key_id: "signer_test".into(),
            signing_key,
            approver_key_id: "approval_test".into(),
            approver_key: approver_sk.verifying_key(),
            approval_dir,
            audit_log,
            ledger_path: None,
            workload_uid: None,
            approver_uid: None,
            allow_same_uid_for_test: true,
            max_request_bytes: DEFAULT_MAX_REQUEST_BYTES,
            max_approval_bytes: DEFAULT_MAX_APPROVAL_BYTES,
            max_approval_ttl_secs: DEFAULT_MAX_APPROVAL_TTL_SECS,
            clock_skew_secs: DEFAULT_CLOCK_SKEW_SECS,
        };
        Self { dir, cfg, approver_sk }
    }

    fn write_approval(
        &self,
        rel_name: &str,
        run_id: &str,
        path: &str,
        digest: &str,
        nonce: &str,
        approved_at: &str,
        expires_at: &str,
        approval_id: &str,
    ) -> PathBuf {
        let unsigned = json!({
            "v": 1,
            "kind": "teamwork.signer-approval",
            "approvalId": approval_id,
            "runId": run_id,
            "path": path,
            "digest": digest,
            "nonce": nonce,
            "approvedAt": approved_at,
            "expiresAt": expires_at,
            "approvedBy": "uid:approver"
        });
        let canon = canonical_json(&unsigned).unwrap();
        let sig_input = format!(
            "{}\0{}\0{}\0{}\0{}\0{}\0{}",
            APPROVAL_DOMAIN, run_id, path, digest, nonce, expires_at, canon
        );
        let sig = self.approver_sk.sign(sig_input.as_bytes());
        let mut full = unsigned.as_object().unwrap().clone();
        full.insert(
            "_auth".into(),
            json!({
                "alg": "ed25519",
                "keyId": self.cfg.approver_key_id,
                "sig": URL_SAFE_NO_PAD.encode(sig.to_bytes())
            }),
        );
        let p = self.cfg.approval_dir.join(RUN_ID).join(rel_name);
        fs::write(&p, serde_json::to_string(&Value::Object(full)).unwrap()).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o640)).unwrap();
        p
    }

    fn build_request(&self, payload: &Value, path: &str, approval_ref: &Path) -> Value {
        let canon = canonical_json(payload).unwrap();
        let digest = keyed_digest(&canon);
        let msg = format!("{}\0ed25519\0{}\0{}\0{}\0{}", ARTIFACT_DOMAIN, self.cfg.key_id, path, NONCE, canon);
        json!({
            "v": 2,
            "op": "sign-artifact",
            "runId": RUN_ID,
            "alg": "ed25519",
            "keyId": self.cfg.key_id,
            "path": path,
            "digest": digest,
            "nonce": NONCE,
            "at": AT_ISO,
            "approvalRef": approval_ref.to_str().unwrap(),
            "message": URL_SAFE_NO_PAD.encode(msg.as_bytes())
        })
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// §3.3 Test Vector + Item 6: exact digest and base64url message reproduction.
#[test]
fn spec_item_06_section_3_3_test_vector() {
    let payload = json!({"z": "last", "kind": "teamwork.test", "n": 1, "verdict": "PASS"});
    let canon = canonical_json(&payload).unwrap();
    assert_eq!(canon, r#"{"kind":"teamwork.test","n":1,"verdict":"PASS","z":"last"}"#);
    let digest = keyed_digest(&canon);
    assert_eq!(digest, "ebafa7996580c7e8623f2eb09c1e32ae1c3f8cef511dc1a8552c1a15313810da");
    let msg = format!(
        "{}\0ed25519\0signer_test\0verify/victory.json\0{}\0{}",
        ARTIFACT_DOMAIN, NONCE, canon
    );
    assert_eq!(
        URL_SAFE_NO_PAD.encode(msg.as_bytes()),
        "dGVhbXdvcmstYXJ0aWZhY3QtdjEAZWQyNTUxOQBzaWduZXJfdGVzdAB2ZXJpZnkvdmljdG9yeS5qc29uAEFBQUFBQUFBQUFBQUFBQUFBQUFBQUEAeyJraW5kIjoidGVhbXdvcmsudGVzdCIsIm4iOjEsInZlcmRpY3QiOiJQQVNTIiwieiI6Imxhc3QifQ"
    );
}

/// Items 1, 20: v1 refused (E_VERSION); v2 valid request returns verifiable Ed25519 sig.
#[test]
fn spec_items_01_and_20_v1_refused_v2_happy_path() {
    let f = Fixture::new("v1v2");
    let payload = json!({"kind": "teamwork.test", "n": 1, "verdict": "PASS", "z": "last"});
    let digest = keyed_digest(&canonical_json(&payload).unwrap());
    let app = f.write_approval("a.json", RUN_ID, "verify/victory.json", &digest, NONCE, APPROVED_AT_ISO, EXPIRES_AT_ISO, APPROVAL_ID);
    let mut req = f.build_request(&payload, "verify/victory.json", &app);

    // v1 refused
    req["v"] = json!(1);
    let r1 = process_request(req.to_string().as_bytes(), &f.cfg, NOW, None);
    assert_eq!(r1.error.as_deref(), Some("E_VERSION"));
    assert!(r1.sig.is_none());

    // v2 accepted and signature verifies over decoded message bytes
    req["v"] = json!(2);
    let r2 = process_request(req.to_string().as_bytes(), &f.cfg, NOW, None);
    assert!(r2.ok, "expected ok, got {:?}", r2);
    let sig_bytes = URL_SAFE_NO_PAD.decode(r2.sig.as_ref().unwrap()).unwrap();
    let msg_bytes = URL_SAFE_NO_PAD.decode(req["message"].as_str().unwrap()).unwrap();
    let sig = Signature::from_bytes(&sig_bytes.try_into().unwrap());
    assert!(f.cfg.signing_key.verifying_key().verify(&msg_bytes, &sig).is_ok());
}

/// Items 2, 3, 4, 5, 7, 8: base64url, NUL fields, canonicalization, dup/non-ASCII keys, UTF-8 values, size bound.
#[test]
fn spec_items_02_to_08_protocol_and_canonical() {
    let f = Fixture::new("proto");
    let payload = json!({"msg": "héllo 🌍", "n": 1});
    let digest = keyed_digest(&canonical_json(&payload).unwrap());
    let app = f.write_approval("a.json", RUN_ID, "verify/r.json", &digest, NONCE, APPROVED_AT_ISO, EXPIRES_AT_ISO, APPROVAL_ID);

    // Item 7: non-ASCII values round-trip cleanly
    let req = f.build_request(&payload, "verify/r.json", &app);
    assert!(process_request(req.to_string().as_bytes(), &f.cfg, NOW, None).ok);

    // Item 2: padded base64url rejected
    let mut bad_b64 = req.clone();
    bad_b64["message"] = json!(format!("{}=", req["message"].as_str().unwrap()));
    assert_eq!(process_request(bad_b64.to_string().as_bytes(), &f.cfg, NOW, None).error.as_deref(), Some("E_MESSAGE"));

    // Item 3: wrong domain rejected
    let mut bad_dom = req.clone();
    bad_dom["message"] = json!(URL_SAFE_NO_PAD.encode(b"wrong-domain\0ed25519\0signer_test\0verify/r.json\0AAAAAAAAAAAAAAAAAAAAAA\0{}"));
    assert_eq!(process_request(bad_dom.to_string().as_bytes(), &f.cfg, NOW, None).error.as_deref(), Some("E_MESSAGE"));

    // Item 4: non-canonical key order / whitespace rejected
    let mut bad_canon = req.clone();
    let non_canon = format!("{}\0ed25519\0signer_test\0verify/r.json\0{}\0{{\"z\":1, \"a\":2}}", ARTIFACT_DOMAIN, NONCE);
    bad_canon["message"] = json!(URL_SAFE_NO_PAD.encode(non_canon.as_bytes()));
    assert_eq!(process_request(bad_canon.to_string().as_bytes(), &f.cfg, NOW, None).error.as_deref(), Some("E_CANONICAL"));

    // Item 5: duplicate keys & non-ASCII keys rejected
    let dup_msg = format!("{}\0ed25519\0signer_test\0verify/r.json\0{}\0{{\"a\":1,\"a\":2}}", ARTIFACT_DOMAIN, NONCE);
    let mut bad_dup = req.clone();
    bad_dup["message"] = json!(URL_SAFE_NO_PAD.encode(dup_msg.as_bytes()));
    assert_eq!(process_request(bad_dup.to_string().as_bytes(), &f.cfg, NOW, None).error.as_deref(), Some("E_CANONICAL"));

    let non_ascii_msg = format!("{}\0ed25519\0signer_test\0verify/r.json\0{}\0{{\"é\":1}}", ARTIFACT_DOMAIN, NONCE);
    let mut bad_ascii = req.clone();
    bad_ascii["message"] = json!(URL_SAFE_NO_PAD.encode(non_ascii_msg.as_bytes()));
    assert_eq!(process_request(bad_ascii.to_string().as_bytes(), &f.cfg, NOW, None).error.as_deref(), Some("E_CANONICAL"));

    // Item 8: oversized request refused
    let big = vec![b' '; f.cfg.max_request_bytes + 1];
    assert_eq!(process_request(&big, &f.cfg, NOW, None).error.as_deref(), Some("E_REQUEST"));
}

/// Items 9, 10, 11, 12, 13, 14: policy checks, path/scope, digest, symlink, owner mismatch.
#[test]
fn spec_items_09_to_14_policy_and_owner_checks() {
    let mut f = Fixture::new("policy");
    let payload = json!({"k": "v"});
    let digest = keyed_digest(&canonical_json(&payload).unwrap());
    let app = f.write_approval("a.json", RUN_ID, "verify/r.json", &digest, NONCE, APPROVED_AT_ISO, EXPIRES_AT_ISO, APPROVAL_ID);
    let req = f.build_request(&payload, "verify/r.json", &app);

    // Item 9: op/alg/keyId mismatches
    let mut r = req.clone(); r["op"] = json!("other");
    assert_eq!(process_request(r.to_string().as_bytes(), &f.cfg, NOW, None).error.as_deref(), Some("E_OP"));
    let mut r = req.clone(); r["alg"] = json!("hmac-sha256");
    assert_eq!(process_request(r.to_string().as_bytes(), &f.cfg, NOW, None).error.as_deref(), Some("E_ALG"));
    let mut r = req.clone(); r["keyId"] = json!("wrong_key");
    assert_eq!(process_request(r.to_string().as_bytes(), &f.cfg, NOW, None).error.as_deref(), Some("E_KEYID"));

    // Item 10: traversal and approvals/ path
    let mut r = req.clone(); r["path"] = json!("../escape.json");
    assert_eq!(process_request(r.to_string().as_bytes(), &f.cfg, NOW, None).error.as_deref(), Some("E_PATH"));
    let mut r = req.clone(); r["path"] = json!("approvals/prompt.json");
    assert_eq!(process_request(r.to_string().as_bytes(), &f.cfg, NOW, None).error.as_deref(), Some("E_APPROVAL_SCOPE"));

    // Item 11: digest mismatch
    let mut r = req.clone(); r["digest"] = json!("0".repeat(64));
    assert_eq!(process_request(r.to_string().as_bytes(), &f.cfg, NOW, None).error.as_deref(), Some("E_DIGEST"));

    // Item 12 & 13: missing, traversal, and symlinked approval refused
    let mut r = req.clone(); r["approvalRef"] = json!("/etc/passwd");
    assert_eq!(process_request(r.to_string().as_bytes(), &f.cfg, NOW, None).error.as_deref(), Some("E_APPROVAL_OPEN"));
    let sym = f.cfg.approval_dir.join(RUN_ID).join("sym.json");
    symlink(&app, &sym).unwrap();
    let mut r = req.clone(); r["approvalRef"] = json!(sym.to_str().unwrap());
    assert_eq!(process_request(r.to_string().as_bytes(), &f.cfg, NOW, None).error.as_deref(), Some("E_APPROVAL_OPEN"));

    // Item 14: approval owned by workload UID refused with E_APPROVAL_OWNER
    f.cfg.allow_same_uid_for_test = false;
    f.cfg.workload_uid = Some(unsafe { libc::geteuid() });
    let owner_res = process_request(req.to_string().as_bytes(), &f.cfg, NOW, None);
    assert_eq!(owner_res.error.as_deref(), Some("E_APPROVAL_OWNER"));
    assert!(owner_res.sig.is_none());
}

/// Items 15, 16, 17, 18, 19, 21: bad sig, binding mismatch, expiry, ledger replay, audit-before-sign, peer UID.
#[test]
fn spec_items_15_to_21_sig_binding_expiry_ledger_audit_peer() {
    let mut f = Fixture::new("adv");
    let payload = json!({"k": "v"});
    let digest = keyed_digest(&canonical_json(&payload).unwrap());
    let app = f.write_approval("a.json", RUN_ID, "verify/r.json", &digest, NONCE, APPROVED_AT_ISO, EXPIRES_AT_ISO, APPROVAL_ID);
    let req = f.build_request(&payload, "verify/r.json", &app);

    // Item 16: wrong path binding
    let bad_bind = f.write_approval("b.json", RUN_ID, "verify/other.json", &digest, NONCE, APPROVED_AT_ISO, EXPIRES_AT_ISO, APPROVAL_ID);
    let mut r = req.clone(); r["approvalRef"] = json!(bad_bind.to_str().unwrap());
    assert_eq!(process_request(r.to_string().as_bytes(), &f.cfg, NOW, None).error.as_deref(), Some("E_APPROVAL_BINDING"));

    // Item 17: expired approval
    let expired = f.write_approval("exp.json", RUN_ID, "verify/r.json", &digest, NONCE, "2026-11-22T11:55:00Z", "2026-11-23T11:55:00Z", APPROVAL_ID);
    let mut r = req.clone(); r["approvalRef"] = json!(expired.to_str().unwrap());
    assert_eq!(process_request(r.to_string().as_bytes(), &f.cfg, NOW, None).error.as_deref(), Some("E_APPROVAL_EXPIRED"));

    // Item 18: ledger rejects reused approvalId for a different request
    f.cfg.ledger_path = Some(f.dir.join("ledger.jsonl"));
    assert!(process_request(req.to_string().as_bytes(), &f.cfg, NOW, None).ok);
    let payload2 = json!({"k": "v2"});
    let digest2 = keyed_digest(&canonical_json(&payload2).unwrap());
    let app2 = f.write_approval("a2.json", RUN_ID, "verify/r.json", &digest2, NONCE, APPROVED_AT_ISO, EXPIRES_AT_ISO, APPROVAL_ID);
    let req2 = f.build_request(&payload2, "verify/r.json", &app2);
    assert_eq!(process_request(req2.to_string().as_bytes(), &f.cfg, NOW, None).error.as_deref(), Some("E_APPROVAL_REPLAY"));

    // Item 19: failed audit append returns E_AUDIT and no signature
    f.cfg.ledger_path = None;
    f.cfg.audit_log = f.dir.join("nonexistent_dir/audit.jsonl");
    let audit_fail = process_request(req.to_string().as_bytes(), &f.cfg, NOW, None);
    assert_eq!(audit_fail.error.as_deref(), Some("E_AUDIT"));
    assert!(audit_fail.sig.is_none());

    // Item 21: peer UID mismatch returns E_PEER
    f.cfg.audit_log = f.dir.join("audit.jsonl");
    f.cfg.workload_uid = Some(1000);
    assert_eq!(process_request(req.to_string().as_bytes(), &f.cfg, NOW, Some(2000)).error.as_deref(), Some("E_PEER"));
}
