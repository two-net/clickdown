//! Records the toolchain and framework versions for ClickDown's startup log line.
use std::{env, fs, process::Command};

fn main() {
    for file in ["build.rs", "Cargo.lock", "../ClickDown.Angular/package-lock.json"] {
        println!("cargo::rerun-if-changed={file}");
    }
    // Cargo tells build scripts which rustc it uses (build time only, never read at run time).
    let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".into());
    let rustc_version = Command::new(rustc).arg("--version").output().ok();
    let rustc_version =
        rustc_version.map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string());
    println!(
        "cargo::rustc-env=RUSTC_VERSION={}",
        rustc_version.unwrap_or_else(|| "unknown".into())
    );

    let lock = fs::read_to_string("Cargo.lock").unwrap_or_default();
    println!(
        "cargo::rustc-env=AXUM_VERSION={}",
        version_after(&lock, "name = \"axum\"\nversion = \"")
    );
    println!(
        "cargo::rustc-env=TOKIO_VERSION={}",
        version_after(&lock, "name = \"tokio\"\nversion = \"")
    );

    let npm = fs::read_to_string("../ClickDown.Angular/package-lock.json").unwrap_or_default();
    let core = npm.split("\"node_modules/@angular/core\"").nth(1).unwrap_or("");
    println!("cargo::rustc-env=ANGULAR_VERSION={}", version_after(core, "\"version\": \""));
}

/// The quoted value right after the first `marker` in `text`, or "unknown".
fn version_after(text: &str, marker: &str) -> String {
    let value = text.split(marker).nth(1).and_then(|rest| rest.split('"').next());
    value.unwrap_or("unknown").to_string()
}
