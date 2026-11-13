//! Executes the original TypeScript business functions and the real Rust
//! rules binary against the same JSON input corpus on GitHub Actions.
//! No duplicated expectations can masquerade as differential parity.
use std::path::PathBuf;
use std::process::Command;

#[test]
fn original_typescript_vs_rust_differential() {
    let root=PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../..").canonicalize()
        .expect("repository root");
    let install=Command::new("npm")
        .args(["ci","--ignore-scripts","--no-audit","--no-fund"])
        .current_dir(&root)
        .output()
        .expect("npm is required for true TypeScript comparison");
    if !install.status.success() {
        panic!("BASELINE BLOCKED: npm ci failed (status {:?})\nstdout:\n{}\nstderr:\n{}",
            install.status.code(),
            String::from_utf8_lossy(&install.stdout),
            String::from_utf8_lossy(&install.stderr));
    }
    let outcome=Command::new("node")
        .arg("--import").arg("tsx")
        .arg("tests/rust-migration/rules/parity/compare.mts")
        .env("TSBH_RULES_BIN",env!("CARGO_BIN_EXE_json_rules"))
        .current_dir(&root)
        .output()
        .expect("Node.js and tsx are required for true TypeScript comparison");
    println!("TS/Rust DIFFERENTIAL stdout:\n{}",String::from_utf8_lossy(&outcome.stdout));
    println!("TS/Rust DIFFERENTIAL stderr:\n{}",String::from_utf8_lossy(&outcome.stderr));
    assert!(outcome.status.success(),
        "TS and Rust baseline did not match; read per-case DIFF logs above (status {:?})",
        outcome.status.code());
}
