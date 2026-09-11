//! Tripwire for the read-only rule: scans both codebases for any way to send or accept anything
//! but GET.
//! This file lives in tests/, outside the scanned folders, so its own word list never trips it.
use std::{
    fs,
    path::{Path, PathBuf},
};

const FORBIDDEN: &[&str] = &[
    ".post(",
    ".put(",
    ".patch(",
    ".delete(",
    ".request(",
    ".execute(",
    "Method::",
    "MethodFilter",
    "fetch(",
    "XMLHttpRequest",
    "sendBeacon",
    "<form",
];

fn walk(dir: &Path, files: &mut Vec<PathBuf>) {
    let entries = fs::read_dir(dir).unwrap_or_else(|e| panic!("can't read {}: {e}", dir.display()));
    for entry in entries {
        let path = entry.unwrap().path();
        if path.is_dir() { walk(&path, files) } else { files.push(path) }
    }
}

#[test]
fn nothing_but_get() {
    let rust = Path::new(env!("CARGO_MANIFEST_DIR"));
    let angular = rust.with_file_name("ClickDown.Angular");
    let mut files = Vec::new();
    walk(&rust.join("src"), &mut files);
    walk(&angular.join("src"), &mut files);

    let mut problems = Vec::new();
    for path in &files {
        // Skip files that aren't text, such as icons.
        let Ok(text) = fs::read_to_string(path) else { continue };
        let name = path.display();
        for word in FORBIDDEN.iter().filter(|word| text.contains(**word)) {
            problems.push(format!("{name}: contains `{word}`"));
        }
        let ext = path.extension().and_then(|ext| ext.to_str());
        if ext == Some("rs") && *path != rust.join("src/api.rs") && text.contains("reqwest") {
            problems.push(format!("{name}: uses reqwest outside api.rs"));
        }
        // The local server: every route is a `get(…)` route, and nothing but `get` comes from
        // axum::routing (not post, any, on, ...).
        let other_route =
            text.lines().any(|line| line.contains(".route") && !line.contains("get("));
        let other_routing =
            text.matches("routing::").count() != text.matches("routing::get").count();
        if ext == Some("rs") && (other_route || other_routing) {
            problems.push(format!("{name}: registers a route that isn't GET-only"));
        }
        if ext == Some("ts") && *path != angular.join("src/app/backend.ts") {
            // Tests may provide the (testing) HttpClient; nothing else may touch it.
            let is_spec = path.to_string_lossy().ends_with(".spec.ts");
            let text = if is_spec { text.replace("provideHttpClient", "") } else { text };
            if text.contains("HttpClient") {
                problems.push(format!("{name}: uses HttpClient outside backend.ts"));
            }
        }
    }
    assert!(problems.is_empty(), "read-only rule broken:\n{}", problems.join("\n"));

    let api = fs::read_to_string(rust.join("src/api.rs")).unwrap();
    assert_eq!(
        api.matches("pub async fn").count(),
        1,
        "api.rs must have exactly one request method"
    );
}
