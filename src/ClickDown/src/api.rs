//! The ClickUp client (one method: `get()`) and the response models the UI shows.
//! Models keep only displayed fields; ClickUp's other fields are ignored.
use std::{
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use reqwest::{
    StatusCode,
    header::{AUTHORIZATION, HeaderMap, HeaderValue},
};
use serde::{Deserialize, Deserializer, Serialize, de::DeserializeOwned};
use tracing::{info, warn};

use crate::{config::Token, log_error};

#[cfg(not(test))]
const BASE_URL: &str = "https://api.clickup.com/api/v2";
/// Tests never reach ClickUp: a request sent by mistake fails on this closed local port.
#[cfg(test)]
const BASE_URL: &str = "http://127.0.0.1:9/api/v2";

/// Read-only by construction: the HTTP client is private and `get()` is the only request method.
pub struct ClickUp {
    http: reqwest::Client,
    /// The rate-limit numbers from ClickUp's latest answer, for the UI's status bar.
    rate: Mutex<Option<RateLimit>>,
}

/// `X-RateLimit-Limit` and `X-RateLimit-Remaining` from one ClickUp answer, good until its reset.
#[derive(Clone, Copy)]
pub struct RateLimit {
    pub limit: u64,
    pub remaining: u64,
    until_ms: u64,
}

#[derive(Debug)]
pub enum ApiError {
    Unauthorized(String),
    RateLimited { retry_in_s: u64 },
    Network(String),
    Status { status: u16, message: String },
    Parse(String),
}

impl ClickUp {
    pub fn new(token: &Token) -> Result<Self, Box<dyn std::error::Error>> {
        let mut auth = HeaderValue::from_str(token.expose())?; // the raw token, no "Bearer"
        auth.set_sensitive(true);
        let http = reqwest::Client::builder()
            .default_headers(HeaderMap::from_iter([(AUTHORIZATION, auth)]))
            .user_agent(concat!("ClickDown/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .no_proxy() // otherwise reqwest reads the *_PROXY env vars
            .build()?;
        Ok(Self { http, rate: Mutex::new(None) })
    }

    /// GETs `path` (below /api/v2) and parses the JSON body into `T`.
    pub async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T, ApiError> {
        let call =
            query.iter().fold(format!("GET {path}"), |call, (k, v)| format!("{call} {k}={v}"));
        let started = Instant::now();
        let response = self.http.get(format!("{BASE_URL}{path}")).query(query).send().await;
        let response = response.map_err(|e| network_error(&call, started, &e))?;
        let status = response.status();
        // Replaced on every answer, so an answer without the headers never leaves stale numbers.
        if let Ok(mut rate) = self.rate.lock() {
            *rate = rate_limit_from(response.headers(), now_ms());
        }
        let reset = response.headers().get("x-ratelimit-reset").and_then(|v| v.to_str().ok());
        let reset = reset.map(str::to_owned);
        let body = response.bytes().await.map_err(|e| network_error(&call, started, &e))?;
        info!("{call} → {} in {} ms", status.as_u16(), started.elapsed().as_millis());
        match status.as_u16() {
            200..=299 => serde_json::from_slice(&body).map_err(|e| {
                log_error(&format!("{call}: unexpected response"), &e);
                ApiError::Parse(e.to_string())
            }),
            401 => {
                let message = clickup_message(&body, status);
                warn!("{call}: ClickUp rejected the token ({message})");
                Err(ApiError::Unauthorized(message))
            }
            429 => {
                let retry_in_s = retry_in_s(reset.as_deref(), now_ms());
                warn!("rate limited on {call}, client retries in {retry_in_s} s");
                Err(ApiError::RateLimited { retry_in_s })
            }
            code => {
                let err =
                    ApiError::Status { status: code, message: clickup_message(&body, status) };
                log_error(&call, &err);
                Err(err)
            }
        }
    }

    /// The rate-limit numbers from ClickUp's latest answer, until its rate-limit window resets.
    pub fn rate_limit(&self) -> Option<RateLimit> {
        let rate = self.rate.lock().ok().and_then(|rate| *rate);
        rate.filter(|rate| now_ms() < rate.until_ms)
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::Unauthorized(message) => write!(f, "ClickUp rejected the token: {message}"),
            Self::RateLimited { retry_in_s } => write!(f, "rate limited, retry in {retry_in_s} s"),
            Self::Network(message) => f.write_str(message),
            Self::Status { status, message } => write!(f, "ClickUp answered {status}: {message}"),
            Self::Parse(message) => write!(f, "unexpected response from ClickUp: {message}"),
        }
    }
}

impl std::error::Error for ApiError {}

fn network_error(call: &str, started: Instant, err: &reqwest::Error) -> ApiError {
    log_error(&format!("{call} failed after {} ms", started.elapsed().as_millis()), err);
    let message = if err.is_timeout() {
        "ClickUp took too long to answer"
    } else if err.is_connect() {
        "can't connect to ClickUp"
    } else {
        "the request to ClickUp failed"
    };
    ApiError::Network(message.into())
}

/// ClickUp's error text (`{"err": "...", "ECODE": "..."}`), or the HTTP reason phrase.
fn clickup_message(body: &[u8], status: StatusCode) -> String {
    #[derive(Deserialize)]
    struct ErrorBody {
        err: String,
    }
    let reason = || status.canonical_reason().unwrap_or("error").to_string();
    serde_json::from_slice::<ErrorBody>(body).map_or_else(|_| reason(), |body| body.err)
}

/// Both rate-limit numbers, or None if either is missing or not a number. They hold until
/// `X-RateLimit-Reset`, or for a minute without it.
fn rate_limit_from(headers: &HeaderMap, now_ms: u64) -> Option<RateLimit> {
    let text = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let number = |name: &str| -> Option<u64> { text(name)?.trim().parse().ok() };
    Some(RateLimit {
        limit: number("x-ratelimit-limit")?,
        remaining: number("x-ratelimit-remaining")?,
        until_ms: reset_ms(text("x-ratelimit-reset")).unwrap_or(now_ms + 60_000),
    })
}

/// `X-RateLimit-Reset` in epoch ms. It's a Unix timestamp whose unit isn't documented; above
/// 1e12 it must be milliseconds.
fn reset_ms(reset_header: Option<&str>) -> Option<u64> {
    let reset = reset_header?.trim().parse::<u64>().ok()?;
    Some(if reset > 1_000_000_000_000 { reset } else { reset.saturating_mul(1000) })
}

/// Seconds to wait after a 429: the time left until the reset plus 1 s, clamped to 1–60 s.
fn retry_in_s(reset_header: Option<&str>, now_ms: u64) -> u64 {
    let Some(reset_ms) = reset_ms(reset_header) else {
        return 60;
    };
    (reset_ms.saturating_sub(now_ms) / 1000 + 1).clamp(1, 60)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// ClickUp sends some numbers as strings: accepts `123`, `"123"`, null or nothing.
fn lenient_int<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    Ok(match Option::<serde_json::Value>::deserialize(d)? {
        Some(serde_json::Value::Number(n)) => n.as_u64(),
        Some(serde_json::Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    })
}

/// The length of an array whose items aren't needed, like a workspace's members. Null gives the
/// default: 0, or None where the count can be unknown.
fn count<'de, D: Deserializer<'de>, T: From<usize> + Default>(d: D) -> Result<T, D::Error> {
    let items = Option::<Vec<serde::de::IgnoredAny>>::deserialize(d)?;
    Ok(items.map_or_else(T::default, |items| items.len().into()))
}

// Models. Field names match ClickUp's JSON and the UI's models.ts.

/// `/user`: the token's owner.
#[derive(Deserialize, Serialize)]
pub struct Me {
    pub user: User,
}

#[derive(Deserialize, Serialize)]
pub struct User {
    /// ClickUp's automation writes as user -1.
    pub id: i64,
    pub username: Option<String>,
    pub email: Option<String>,
    pub color: Option<String>,
    pub initials: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub struct Teams {
    #[serde(default)]
    pub teams: Vec<Team>,
}

#[derive(Deserialize, Serialize)]
pub struct Team {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    #[serde(rename(deserialize = "members"), default, deserialize_with = "count")]
    pub member_count: usize,
}

#[derive(Deserialize, Serialize)]
pub struct Spaces {
    #[serde(default)]
    pub spaces: Vec<Space>,
}

#[derive(Deserialize, Serialize)]
pub struct Space {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    #[serde(default)]
    pub statuses: Vec<Status>,
}

#[derive(Deserialize, Serialize)]
pub struct Folders {
    #[serde(default)]
    pub folders: Vec<Folder>,
}

#[derive(Deserialize, Serialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    #[serde(default, deserialize_with = "lenient_int")]
    pub task_count: Option<u64>,
    /// Folders shared with you come without their lists, so this is unknown for them.
    #[serde(rename(deserialize = "lists"), default, deserialize_with = "count")]
    pub list_count: Option<usize>,
}

#[derive(Deserialize, Serialize)]
pub struct Lists {
    #[serde(default)]
    pub lists: Vec<List>,
}

#[derive(Deserialize, Serialize)]
pub struct List {
    pub id: String,
    pub name: String,
    #[serde(default, deserialize_with = "lenient_int")]
    pub task_count: Option<u64>,
}

/// `/team/{id}/shared`: folders and lists shared with you directly, possibly inside spaces you
/// can't open. ClickUp sends only ids for shared tasks, so those are left out.
#[derive(Deserialize, Serialize)]
pub struct SharedHierarchy {
    pub shared: SharedItems,
}

#[derive(Deserialize, Serialize)]
pub struct SharedItems {
    #[serde(default)]
    pub folders: Vec<Folder>,
    #[serde(default)]
    pub lists: Vec<List>,
}

#[derive(Deserialize, Serialize)]
pub struct TasksPage {
    #[serde(default)]
    pub tasks: Vec<Task>,
    pub last_page: bool,
}

#[derive(Deserialize, Serialize)]
pub struct Task {
    pub id: String,
    pub custom_id: Option<String>,
    pub name: String,
    pub status: Status,
    pub priority: Option<Priority>,
    #[serde(default)]
    pub assignees: Vec<User>,
    #[serde(default)]
    pub tags: Vec<Tag>,
    #[serde(default, deserialize_with = "lenient_int")]
    pub due_date: Option<u64>,
    #[serde(default, deserialize_with = "lenient_int")]
    pub date_created: Option<u64>,
    pub parent: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub struct Status {
    pub status: String,
    pub color: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    /// The status's place in its workflow; the UI orders status groups by it.
    #[serde(default, deserialize_with = "lenient_int")]
    pub orderindex: Option<u64>,
}

#[derive(Deserialize, Serialize)]
pub struct Priority {
    pub priority: String,
    pub color: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub struct Tag {
    pub name: String,
    pub tag_fg: Option<String>,
    pub tag_bg: Option<String>,
}

/// `/task/{id}`. The raw description stays on the server; main.rs fills `description_html`.
#[derive(Deserialize, Serialize)]
pub struct TaskDetail {
    #[serde(flatten)]
    pub task: Task,
    #[serde(default)]
    pub subtasks: Vec<Task>,
    /// The list the task lives in: shown by the UI, and checked against only_lists by main.rs.
    #[serde(default)]
    pub list: Option<ListRef>,
    pub creator: Option<User>,
    #[serde(default, deserialize_with = "lenient_int")]
    pub date_updated: Option<u64>,
    #[serde(default, deserialize_with = "lenient_int")]
    pub start_date: Option<u64>,
    /// Milliseconds.
    #[serde(default, deserialize_with = "lenient_int")]
    pub time_estimate: Option<u64>,
    #[serde(default)]
    pub points: Option<f64>,
    #[serde(skip_serializing)]
    pub markdown_description: Option<String>,
    #[serde(skip_serializing)]
    pub text_content: Option<String>,
    #[serde(skip_deserializing)]
    pub description_html: String,
}

#[derive(Deserialize, Serialize)]
pub struct ListRef {
    pub id: String,
    #[serde(default)]
    pub name: String,
}

/// `/task/{id}/comment`. main.rs sets `has_more`.
#[derive(Deserialize, Serialize)]
pub struct CommentsPage {
    #[serde(default)]
    pub comments: Vec<Comment>,
    #[serde(skip_deserializing)]
    pub has_more: bool,
}

#[derive(Deserialize, Serialize)]
pub struct Comment {
    pub id: String,
    #[serde(default)]
    pub comment_text: String,
    pub user: Option<User>,
    #[serde(default, deserialize_with = "lenient_int")]
    pub date: Option<u64>,
    #[serde(default, deserialize_with = "lenient_int")]
    pub reply_count: Option<u64>,
}

#[cfg(test)]
mod tests {
    use reqwest::header::HeaderName;

    use super::*;

    const FIXTURE: &str = include_str!("../tests/fixtures/get_tasks.json");

    #[test]
    fn parses_the_get_tasks_fixture() {
        let page: TasksPage = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(page.tasks.len(), 2);
        assert!(page.last_page);
        let (first, second) = (&page.tasks[0], &page.tasks[1]);
        assert_eq!(first.priority.as_ref().map(|p| p.priority.as_str()), Some("normal"));
        assert!(second.priority.is_none());
        assert_eq!(first.due_date, Some(1508369194377));
        assert_eq!(first.date_created, Some(1567780450202)); // sent as a string
        assert_eq!(first.assignees[0].initials.as_deref(), Some("AJ"));
        assert_eq!(first.status.kind.as_deref(), Some("custom"));
        assert_eq!((first.status.orderindex, second.status.orderindex), (Some(1), Some(0)));

        // What the UI receives.
        let json = serde_json::to_value(&page).unwrap();
        let task = &json["tasks"][0];
        assert_eq!(task["status"]["type"], "custom");
        assert_eq!(task["due_date"], 1508369194377u64);
        assert_eq!(task["date_created"], 1567780450202u64);
        assert!(task.get("url").is_none()); // nothing in the UI uses it
        assert_eq!(json["tasks"][1].get("priority"), Some(&serde_json::Value::Null));
        assert_eq!(json["last_page"], true);
    }

    #[test]
    fn parses_the_task_detail_fields() {
        let fixture: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        let task: TaskDetail = serde_json::from_value(fixture["tasks"][0].clone()).unwrap();
        let creator = task.creator.as_ref().and_then(|c| c.username.as_deref());
        assert_eq!(creator, Some("Alex Johnson"));
        assert_eq!(task.task.date_created, Some(1567780450202));
        assert_eq!(task.time_estimate, Some(8640000)); // sent as a string
        assert_eq!(task.points, Some(3.0));
        assert_eq!(task.start_date, None);

        let json = serde_json::to_value(&task).unwrap();
        assert_eq!(json["date_created"], 1567780450202u64); // flattened, where the UI reads it
        assert_eq!(json["list"]["name"], "Sprint Backlog");
        assert!(json.get("text_content").is_none());

        let by_automation = r#"{"id":"1","name":"n","status":{"status":"s"},
            "creator":{"id":-1,"username":"ClickBot"}}"#;
        let task: TaskDetail = serde_json::from_str(by_automation).unwrap();
        assert_eq!(task.creator.map(|c| c.id), Some(-1));
    }

    #[test]
    fn counts_members_and_lists_and_keeps_statuses() {
        let teams: Teams = serde_json::from_str(
            r#"{"teams":[{"id":"1","name":"Acme","color":null,"members":[{"user":{"id":1}},{"user":{"id":2}}]}]}"#,
        )
        .unwrap();
        assert_eq!(teams.teams[0].member_count, 2);
        assert_eq!(serde_json::to_value(&teams).unwrap()["teams"][0]["member_count"], 2);

        let folders: Folders = serde_json::from_str(
            r#"{"folders":[{"id":"1","name":"F","task_count":"4","lists":[{"id":"9"}]},
                {"id":"2","name":"G"},{"id":"3","name":"H","lists":null}]}"#,
        )
        .unwrap();
        assert_eq!(folders.folders[0].list_count, Some(1));
        assert_eq!(folders.folders[1].list_count, None); // like a folder shared with you
        assert_eq!(folders.folders[2].list_count, None);

        let spaces: Spaces = serde_json::from_str(
            r##"{"spaces":[{"id":"1","name":"S","color":null,"statuses":[{"status":"to do","color":"#87909e","type":"open","orderindex":0}]}]}"##,
        )
        .unwrap();
        assert_eq!(spaces.spaces[0].statuses[0].orderindex, Some(0));
    }

    #[test]
    fn rate_limit_needs_both_numbers_and_holds_until_the_reset() {
        let now = 1_700_000_000_000;
        let headers = |pairs: &[(&'static str, &'static str)]| {
            HeaderMap::from_iter(pairs.iter().map(|&(name, value)| {
                (HeaderName::from_static(name), HeaderValue::from_static(value))
            }))
        };
        let both = [("x-ratelimit-limit", "100"), ("x-ratelimit-remaining", "97")];
        let rate = rate_limit_from(&headers(&both), now).unwrap();
        assert_eq!((rate.limit, rate.remaining, rate.until_ms), (100, 97, now + 60_000));
        let with_reset = [both[0], both[1], ("x-ratelimit-reset", "1700000030")];
        let rate = rate_limit_from(&headers(&with_reset), now).unwrap();
        assert_eq!(rate.until_ms, 1_700_000_030_000);
        assert!(rate_limit_from(&headers(&[both[0]]), now).is_none());
        let garbled = headers(&[both[0], ("x-ratelimit-remaining", "soon")]);
        assert!(rate_limit_from(&garbled, now).is_none());
    }

    #[test]
    fn lenient_int_accepts_strings_numbers_null_and_missing() {
        let cases = [
            (r#","due_date":"123""#, Some(123)),
            (r#","due_date":123"#, Some(123)),
            (r#","due_date":null"#, None),
            ("", None),
        ];
        for (field, expected) in cases {
            let json = format!(r#"{{"id":"1","name":"n","status":{{"status":"s"}}{field}}}"#);
            let task: Task = serde_json::from_str(&json).unwrap();
            assert_eq!(task.due_date, expected, "{json}");
            // Through serde(flatten), null arrives as unit.
            let detail: TaskDetail = serde_json::from_str(&json).unwrap();
            assert_eq!(detail.task.due_date, expected, "{json}");
        }
    }

    #[test]
    fn parses_the_shared_hierarchy() {
        // Shaped like the docs example; tasks are bare ids and get dropped.
        let json = r#"{"shared":{"tasks":["9hx"],
            "lists":[{"id":"1421","name":"Shared List","task_count":"53","archived":false}],
            "folders":[{"id":"1058","name":"Shared Folder","task_count":"0","archived":false}]}}"#;
        let shared: SharedHierarchy = serde_json::from_str(json).unwrap();
        assert_eq!(shared.shared.lists[0].name, "Shared List");
        assert_eq!(shared.shared.lists[0].task_count, Some(53));
        assert_eq!(shared.shared.folders[0].id, "1058");
        let json = serde_json::to_value(&shared).unwrap();
        assert!(json["shared"].get("tasks").is_none());
    }

    #[test]
    fn retry_wait_follows_the_reset_header() {
        let now = 1_700_000_000_000;
        assert_eq!(retry_in_s(Some("1700000010"), now), 11); // seconds
        assert_eq!(retry_in_s(Some("1700000010000"), now), 11); // milliseconds
        assert_eq!(retry_in_s(Some("1600000000"), now), 1); // already past
        assert_eq!(retry_in_s(Some("1800000000"), now), 60); // clamped
        assert_eq!(retry_in_s(None, now), 60);
        assert_eq!(retry_in_s(Some("soon"), now), 60);
    }
}
