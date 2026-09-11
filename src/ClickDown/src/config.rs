//! Loads and validates `config.toml`, the only source of settings.
use std::{
    fmt, fs, io,
    path::{Path, PathBuf},
};

use serde::Deserialize;
use tracing::level_filters::LevelFilter;

/// Fixed at compile time, so ClickDown finds its config from any working directory.
pub const CONFIG_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/config.toml");
const PLACEHOLDER: &str = "pk_REPLACE_ME";

#[derive(Debug)]
pub struct Config {
    pub token: Token,
    pub log_level: LevelFilter,
    pub log_file: PathBuf,
    pub animations: bool,
    /// Ids of the only lists to show; empty means everything the token can see.
    pub only_lists: Vec<String>,
}

/// The file as written: every key but `only_lists` is required, and unknown keys are errors.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    clickup_token: String,
    log_level: String,
    log_file: PathBuf,
    animations: bool,
    #[serde(default)]
    only_lists: Vec<String>,
}

/// The ClickUp API token. It masks itself when printed; only api.rs calls `expose()`.
pub struct Token(String);

impl Token {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Token {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(&mask_token(&self.0))
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

/// `pk_12…9xyz`: the first 5 and last 4 characters, or `***` when too short to hide anything.
pub fn mask_token(token: &str) -> String {
    let chars: Vec<char> = token.chars().collect();
    if chars.len() < 12 {
        return "***".into();
    }
    let head: String = chars[..5].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

/// Reads the config file. The error is a friendly message for the terminal.
pub fn load(path: &Path) -> Result<Config, String> {
    let text = fs::read_to_string(path).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => format!(
            "ClickDown needs a config file, but there is none at\n  {}\n\
             Copy config.example.toml to config.toml in that folder, paste your ClickUp token\n\
             into it, and start ClickDown again.",
            path.display()
        ),
        _ => format!("ClickDown can't read its config file\n  {}\n{e}", path.display()),
    })?;
    parse(&text, path)
}

/// Validates the file's text. `path` is used for messages and to resolve `log_file`.
pub fn parse(text: &str, path: &Path) -> Result<Config, String> {
    let problem = |what: &str| {
        format!("There is a problem in ClickDown's config file\n  {}\n{what}", path.display())
    };
    let raw: RawConfig = toml::from_str(text).map_err(|e| problem(&toml_error(text, &e)))?;
    let token = raw.clickup_token.trim();
    if token.is_empty() || token == PLACEHOLDER {
        return Err(problem(
            "clickup_token is not set yet. Paste your personal token there\n\
             (ClickUp avatar → Settings → Apps → API Token → Generate) and start ClickDown again.",
        ));
    }
    if !token.starts_with("pk_") || !token.chars().all(|c| c.is_ascii_graphic()) {
        return Err(problem(
            "clickup_token doesn't look like a personal token: it starts with pk_ and has no spaces.",
        ));
    }
    let log_level = match raw.log_level.as_str() {
        "" => None, // LevelFilter would parse "" as ERROR
        level => level.parse::<LevelFilter>().ok(),
    };
    // The value isn't echoed: it could be a misplaced token.
    let log_level = log_level
        .ok_or_else(|| problem("log_level is not one of off, error, warn, info, debug, trace."))?;
    let only_lists: Vec<String> = raw.only_lists.iter().map(|id| id.trim().to_string()).collect();
    // ClickUp list ids are numbers. Anything else (a misplaced token, say) is refused unechoed,
    // since list ids end up in the log and in request paths.
    if only_lists.iter().any(|id| id.is_empty() || !id.chars().all(|c| c.is_ascii_digit())) {
        return Err(problem(
            "only_lists must hold list ids, which are numbers: the part after /li/ in a list's\n\
             ClickUp URL, like only_lists = [\"901234567\"].",
        ));
    }
    Ok(Config {
        token: Token(token.to_string()),
        log_level,
        // A relative log_file lives next to the config file.
        log_file: path.parent().unwrap_or(Path::new("")).join(raw.log_file),
        animations: raw.animations,
        only_lists,
    })
}

/// Only toml's message plus line and column: its Display quotes the offending line,
/// which could be the token. The message itself can quote a key or value, so it is scrubbed.
fn toml_error(text: &str, err: &toml::de::Error) -> String {
    let mut message = format!("It is not valid TOML: {}", scrub(err.message().trim_end()));
    if let Some(span) = err.span() {
        let before = text.get(..span.start).unwrap_or(text);
        let line = before.matches('\n').count() + 1;
        let column = before.chars().rev().take_while(|&c| c != '\n').count() + 1;
        message += &format!(" (line {line}, column {column})");
    }
    message
}

/// Masks everything that looks like a token: each `pk_` up to the next space or quote.
fn scrub(message: &str) -> String {
    let mut out = String::new();
    let mut rest = message;
    while let Some(start) = rest.find("pk_") {
        out += &rest[..start];
        let run = &rest[start..];
        let end = run.find(|c: char| c.is_whitespace() || "\"'`".contains(c)).unwrap_or(run.len());
        out += &mask_token(&run[..end]);
        rest = &run[end..];
    }
    out + rest
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "pk_1234567_ABCDEFGHIJKLMNOP";

    fn file(token: &str, level: &str) -> String {
        format!(
            "clickup_token = \"{token}\"\nlog_level = \"{level}\"\n\
             log_file = \"logs/x.log\"\nanimations = false\n"
        )
    }

    #[test]
    fn valid_file() {
        let config = parse(&file(TOKEN, "debug"), Path::new(CONFIG_PATH)).unwrap();
        assert_eq!(config.token.expose(), TOKEN);
        assert_eq!(config.log_level, LevelFilter::DEBUG);
        assert_eq!(config.log_file, Path::new(env!("CARGO_MANIFEST_DIR")).join("logs/x.log"));
        assert!(!config.animations);
        assert!(config.only_lists.is_empty());
        assert!(!format!("{config:?}").contains(TOKEN));
    }

    #[test]
    fn missing_file_names_the_path() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/no-such-folder/config.toml");
        let message = load(Path::new(path)).unwrap_err();
        assert!(message.contains(path) && message.contains("config.example.toml"), "{message}");
    }

    #[test]
    fn placeholder_from_the_example_is_rejected() {
        let example = include_str!("../config.example.toml");
        let message = parse(example, Path::new(CONFIG_PATH)).unwrap_err();
        assert!(message.contains(CONFIG_PATH) && message.contains("not set yet"), "{message}");
    }

    #[test]
    fn errors_never_echo_the_token() {
        let good = file(TOKEN, "info");
        let unquoted = good.replace(&format!("\"{TOKEN}\""), TOKEN);
        let message = parse(&unquoted, Path::new(CONFIG_PATH)).unwrap_err();
        assert!(message.contains("line 1") && message.contains(CONFIG_PATH), "{message}");
        // The token pasted in the wrong place: toml quotes offending keys and values.
        for text in [
            unquoted,
            good.replace("animations = false", &format!("animations = \"{TOKEN}\"")),
            format!("{good}{TOKEN} = 1\n"),
            file(TOKEN, TOKEN),
            format!("{good}only_lists = [\"{TOKEN}\"]\n"),
        ] {
            let message = parse(&text, Path::new(CONFIG_PATH)).unwrap_err();
            assert!(!message.contains(&TOKEN[3..]), "{message}");
        }
    }

    #[test]
    fn bad_values_are_rejected() {
        for (token, level) in
            [("  ", "info"), ("abc_1234567890", "info"), (TOKEN, ""), (TOKEN, "loud")]
        {
            assert!(parse(&file(token, level), Path::new(CONFIG_PATH)).is_err(), "{token} {level}");
        }
    }

    #[test]
    fn only_lists_holds_numeric_list_ids() {
        let base = file(TOKEN, "info");
        let text = format!("{base}only_lists = [\"901234567\", \" 42 \"]\n");
        let config = parse(&text, Path::new(CONFIG_PATH)).unwrap();
        assert_eq!(config.only_lists, ["901234567", "42"]);
        for bad in [r#"[""]"#, r#"["../team"]"#, r#"["abc"]"#, r#"["1%2F"]"#, r#""901""#] {
            let text = format!("{base}only_lists = {bad}\n");
            assert!(parse(&text, Path::new(CONFIG_PATH)).is_err(), "{bad}");
        }
    }

    #[test]
    fn tokens_are_masked() {
        assert_eq!(mask_token("pk_12345678_9xyz"), "pk_12…9xyz");
        assert_eq!(mask_token("pk_short"), "***");
        assert_eq!(mask_token("pk_ééééééééé€€€€"), "pk_éé…€€€€");
        let token = Token(TOKEN.into());
        assert_eq!(format!("{token:?}"), "pk_12…MNOP");
        assert_eq!(token.to_string(), "pk_12…MNOP");
    }
}
