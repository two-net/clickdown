//! ClickDown, a read-only ClickUp browser: loads the config, starts logging, then serves the
//! Angular UI and a GET-only JSON API on 127.0.0.1:4280.
mod api;
mod config;

use std::{
    backtrace::Backtrace,
    error::Error,
    fs, io,
    process::ExitCode,
    sync::{Arc, Mutex},
};

use axum::{
    Json, Router,
    extract::{Path, Query, Request, State},
    http::{HeaderValue, StatusCode, header::HOST},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use pulldown_cmark::{Alignment, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde::Deserialize;
use serde_json::{Value, json};
use tower_http::services::ServeDir;
use tracing::{error, info, warn};

use api::{
    ApiError, ClickUp, CommentsPage, Folders, List, Lists, Me, Spaces, TaskDetail, TasksPage, Teams,
};
use config::{CONFIG_PATH, Config};

const ADDR: &str = "127.0.0.1:4280";
const DIST_DIR: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../ClickDown.Angular/dist/clickdown-angular/browser");
const NOT_ARCHIVED: &[(&str, &str)] = &[("archived", "false")];

struct AppState {
    clickup: ClickUp,
    animations: bool,
    /// From config.toml; empty means everything the token can see.
    only_lists: Vec<String>,
}

type Shared = State<Arc<AppState>>;
/// Errors are ready responses: a ClickUp error (through `From<ApiError>`) or a refusal.
type ApiResult<T> = Result<Json<T>, Response>;

fn main() -> ExitCode {
    let config = match config::load(std::path::Path::new(CONFIG_PATH)) {
        Ok(config) => config,
        Err(message) => {
            println!("{message}");
            return ExitCode::FAILURE;
        }
    };
    if let Err(e) = start_logging(&config) {
        println!("ClickDown can't write its log file\n  {}\n{e}", config.log_file.display());
        return ExitCode::FAILURE;
    }
    info!(
        "starting ClickDown {} on {}/{}; {}, axum {}, tokio {}, Angular {}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        env!("RUSTC_VERSION"),
        env!("AXUM_VERSION"),
        env!("TOKIO_VERSION"),
        env!("ANGULAR_VERSION"),
    );
    info!(
        "config loaded from {CONFIG_PATH}: log_level={}, animations={}, only_lists={:?}, token={}",
        config.log_level, config.animations, config.only_lists, config.token
    );
    // A current-thread runtime never reads TOKIO_WORKER_THREADS, and an explicit stack size
    // stops std from reading RUST_MIN_STACK for the blocking-pool threads.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .thread_stack_size(2 * 1024 * 1024)
        .build();
    match runtime {
        Ok(runtime) => runtime.block_on(run(config)),
        Err(e) => fail("can't start its async runtime", &e),
    }
}

async fn run(config: Config) -> ExitCode {
    let clickup = match ClickUp::new(&config.token) {
        Ok(clickup) => clickup,
        Err(e) => return fail("can't create its HTTP client", &*e),
    };
    let listener = match tokio::net::TcpListener::bind(ADDR).await {
        Ok(listener) => listener,
        Err(e) if e.kind() == io::ErrorKind::AddrInUse => {
            warn!("port 4280 is in use");
            println!("Port 4280 is in use; is ClickDown already running?");
            return ExitCode::FAILURE;
        }
        Err(e) => return fail(&format!("can't listen on {ADDR}"), &e),
    };
    match clickup.get::<Me>("/user", &[]).await {
        Ok(me) => {
            println!("Signed in as {}", me.user.username.or(me.user.email).unwrap_or_default())
        }
        Err(ApiError::Unauthorized(_)) => {
            println!("ClickUp rejected the token; edit {CONFIG_PATH} and restart")
        }
        Err(ApiError::Network(_)) => println!("Can't reach ClickUp; the UI will retry"),
        Err(e) => println!("ClickUp: {e}; the UI will retry"),
    }
    if !config.only_lists.is_empty() {
        println!("Showing only these lists (only_lists): {}", config.only_lists.join(", "));
    }
    if !std::path::Path::new(DIST_DIR).join("index.html").exists() {
        let ui_dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).with_file_name("ClickDown.Angular");
        warn!("UI not built: {DIST_DIR}/index.html is missing");
        println!("UI not built: run npm run build in {}", ui_dir.display());
    }
    println!("ClickDown running at http://{ADDR} (Ctrl+C to stop)");
    info!("listening on http://{ADDR}");
    let state = Arc::new(AppState {
        clickup,
        animations: config.animations,
        only_lists: config.only_lists,
    });
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.ok();
    };
    match axum::serve(listener, app(state)).with_graceful_shutdown(ctrl_c).await {
        Ok(()) => {
            info!("stopped");
            ExitCode::SUCCESS
        }
        Err(e) => fail("stopped with an error", &e),
    }
}

/// GET-only routes, one ClickUp path each. Everything outside /api is the built UI.
fn app(state: Arc<AppState>) -> Router {
    let mut api = Router::new()
        .route("/settings", get(settings))
        .route("/user", get(user))
        .route("/list/{id}", get(list))
        .route("/list/{id}/task", get(tasks))
        .route("/task/{id}", get(task))
        .route("/task/{id}/comment", get(comments));
    // With only_lists set, the workspace, space and folder levels don't exist at all.
    if state.only_lists.is_empty() {
        api = api
            .route("/team", get(teams))
            .route("/team/{id}/space", get(spaces))
            .route("/team/{id}/shared", get(shared_with_me))
            .route("/space/{id}/folder", get(folders))
            .route("/space/{id}/list", get(folderless_lists))
            .route("/folder/{id}/list", get(folder_lists));
    }
    let api = api
        .fallback(|| async { json_error(StatusCode::NOT_FOUND, "not_found") })
        .layer(middleware::from_fn_with_state(state.clone(), rate_headers))
        .with_state(state);
    Router::new()
        .nest("/api", api)
        .fallback_service(ServeDir::new(DIST_DIR))
        .layer(middleware::from_fn(guard)) // added last, so it wraps everything
}

async fn settings(State(s): Shared) -> Json<Value> {
    Json(json!({ "animations": s.animations, "only_lists": s.only_lists }))
}

async fn user(State(s): Shared) -> ApiResult<Me> {
    Ok(Json(s.clickup.get("/user", &[]).await?))
}

async fn teams(State(s): Shared) -> ApiResult<Teams> {
    Ok(Json(s.clickup.get("/team", &[]).await?))
}

async fn spaces(State(s): Shared, Path(id): Path<String>) -> ApiResult<Spaces> {
    Ok(Json(s.clickup.get(&format!("/team/{id}/space"), NOT_ARCHIVED).await?))
}

/// Folders and lists shared with you directly, which may sit in spaces you can't open.
async fn shared_with_me(
    State(s): Shared,
    Path(id): Path<String>,
) -> ApiResult<api::SharedHierarchy> {
    Ok(Json(s.clickup.get(&format!("/team/{id}/shared"), &[]).await?))
}

async fn folders(State(s): Shared, Path(id): Path<String>) -> ApiResult<Folders> {
    Ok(Json(s.clickup.get(&format!("/space/{id}/folder"), NOT_ARCHIVED).await?))
}

async fn folderless_lists(State(s): Shared, Path(id): Path<String>) -> ApiResult<Lists> {
    Ok(Json(s.clickup.get(&format!("/space/{id}/list"), NOT_ARCHIVED).await?))
}

async fn folder_lists(State(s): Shared, Path(id): Path<String>) -> ApiResult<Lists> {
    Ok(Json(s.clickup.get(&format!("/folder/{id}/list"), NOT_ARCHIVED).await?))
}

/// One list's name and task count, for the start screen when only_lists is set.
async fn list(State(s): Shared, Path(id): Path<String>) -> ApiResult<List> {
    allow_list(&s.only_lists, &id)?;
    Ok(Json(s.clickup.get(&format!("/list/{id}"), &[]).await?))
}

#[derive(Deserialize)]
struct PageQuery {
    page: Option<u32>,
}

async fn tasks(
    State(s): Shared,
    Path(id): Path<String>,
    Query(q): Query<PageQuery>,
) -> ApiResult<TasksPage> {
    allow_list(&s.only_lists, &id)?;
    let page = q.page.unwrap_or(0).to_string();
    Ok(Json(s.clickup.get(&format!("/list/{id}/task"), &[("page", &page)]).await?))
}

async fn task(State(s): Shared, Path(id): Path<String>) -> ApiResult<TaskDetail> {
    let query = [("include_subtasks", "true"), ("include_markdown_description", "true")];
    let mut task: TaskDetail = s.clickup.get(&format!("/task/{id}"), &query).await?;
    allow_list(&s.only_lists, home_list(&task))?;
    let markdown = task.markdown_description.as_deref().filter(|md| !md.is_empty());
    task.description_html =
        markdown_to_html(markdown.or(task.text_content.as_deref()).unwrap_or(""));
    Ok(Json(task))
}

#[derive(Deserialize)]
struct CommentsQuery {
    start: Option<String>,
    start_id: Option<String>,
}

async fn comments(
    State(s): Shared,
    Path(id): Path<String>,
    Query(q): Query<CommentsQuery>,
) -> ApiResult<CommentsPage> {
    if !s.only_lists.is_empty() {
        let task: TaskDetail = s.clickup.get(&format!("/task/{id}"), &[]).await?;
        allow_list(&s.only_lists, home_list(&task))?;
    }
    let older = match (&q.start, &q.start_id) {
        (Some(start), Some(start_id)) => {
            vec![("start", start.as_str()), ("start_id", start_id.as_str())]
        }
        _ => vec![],
    };
    let mut page: CommentsPage = s.clickup.get(&format!("/task/{id}/comment"), &older).await?;
    page.has_more = page.comments.len() == 25; // ClickUp sends 25 comments per page
    Ok(Json(page))
}

/// With only_lists set, anything outside those lists is refused.
fn allow_list(only_lists: &[String], list_id: &str) -> Result<(), NotAllowed> {
    if only_lists.is_empty() || only_lists.iter().any(|id| id == list_id) {
        return Ok(());
    }
    warn!("refused: list {list_id:?} is not in only_lists");
    Err(NotAllowed)
}

/// The refusal for anything outside only_lists: a 403 whose message the UI shows.
struct NotAllowed;

impl From<NotAllowed> for Response {
    fn from(_: NotAllowed) -> Self {
        let message = "This isn't in the lists allowed by only_lists in config.toml.";
        (StatusCode::FORBIDDEN, Json(json!({ "error": "not_allowed", "message": message })))
            .into_response()
    }
}

/// The list a task lives in; "" if ClickUp didn't say, which only_lists never allows.
fn home_list(task: &TaskDetail) -> &str {
    task.list.as_ref().map_or("", |list| &list.id)
}

/// The single mapping from ClickUp errors to HTTP responses for the UI.
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, body) = match self {
            ApiError::Unauthorized(message) => (
                StatusCode::UNAUTHORIZED,
                json!({ "error": "unauthorized", "message": message, "config_path": CONFIG_PATH }),
            ),
            ApiError::RateLimited { retry_in_s } => (
                StatusCode::TOO_MANY_REQUESTS,
                json!({ "error": "rate_limited", "retry_in_s": retry_in_s }),
            ),
            ApiError::Network(message) => {
                (StatusCode::SERVICE_UNAVAILABLE, json!({ "error": "network", "message": message }))
            }
            ApiError::Status { status, message } => (
                StatusCode::BAD_GATEWAY,
                json!({ "error": "clickup", "status": status, "message": message }),
            ),
            ApiError::Parse(message) => (
                StatusCode::BAD_GATEWAY,
                json!({ "error": "clickup", "status": 0, "message": message }),
            ),
        };
        (status, Json(body)).into_response()
    }
}

/// Lets handlers use `?` on ClickUp calls while returning `ApiResult`.
impl From<ApiError> for Response {
    fn from(err: ApiError) -> Self {
        err.into_response()
    }
}

fn json_error(status: StatusCode, error: &str) -> Response {
    (status, Json(json!({ "error": error }))).into_response()
}

/// Passes ClickUp's latest rate-limit numbers on to the UI, which shows them in its status bar.
async fn rate_headers(State(s): Shared, req: Request, next: Next) -> Response {
    let mut response = next.run(req).await;
    if let Some(rate) = s.clickup.rate_limit() {
        let headers = response.headers_mut();
        headers.insert("x-ratelimit-limit", HeaderValue::from(rate.limit));
        headers.insert("x-ratelimit-remaining", HeaderValue::from(rate.remaining));
    }
    response
}

/// Runs before every route. The Host check blocks DNS rebinding; /api paths may only use
/// [A-Za-z0-9/_-] (the query is not checked).
async fn guard(req: Request, next: Next) -> Response {
    let host = req.headers().get(HOST).and_then(|host| host.to_str().ok());
    if !matches!(host, Some("127.0.0.1:4280" | "localhost:4280")) {
        return json_error(StatusCode::FORBIDDEN, "forbidden");
    }
    let path = req.uri().path();
    if path.starts_with("/api")
        && !path.chars().all(|c| c.is_ascii_alphanumeric() || "/_-".contains(c))
    {
        return json_error(StatusCode::BAD_REQUEST, "bad_request");
    }
    next.run(req).await
}

/// Renders a task description. Raw HTML is shown as text and images become links, so the
/// browser never loads anything from elsewhere. Checkboxes are drawn by styles.css.
fn markdown_to_html(markdown: &str) -> String {
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let events = Parser::new_ext(markdown, options).map(|event| match event {
        Event::Html(raw) | Event::InlineHtml(raw) => Event::Text(raw),
        Event::TaskListMarker(done) => Event::InlineHtml(
            if done {
                r#"<span class="check done" role="img" aria-label="Done"></span>"#
            } else {
                r#"<span class="check" role="img" aria-label="Not done"></span>"#
            }
            .into(),
        ),
        Event::Start(Tag::Heading { level, id, classes, attrs }) => {
            Event::Start(Tag::Heading { level: sink(level), id, classes, attrs })
        }
        Event::End(TagEnd::Heading(level)) => Event::End(TagEnd::Heading(sink(level))),
        Event::Start(Tag::Table(aligns)) => {
            Event::Start(Tag::Table(vec![Alignment::None; aligns.len()]))
        }
        Event::Start(Tag::Image { link_type, dest_url, title, id }) => {
            Event::Start(Tag::Link { link_type, dest_url, title, id })
        }
        Event::End(TagEnd::Image) => Event::End(TagEnd::Link),
        other => other,
    });
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, events);
    html
}

/// Description headings sit below the page's h1 and the section's h2, so `#` becomes h3.
fn sink(level: HeadingLevel) -> HeadingLevel {
    HeadingLevel::try_from(level as usize + 2).unwrap_or(HeadingLevel::H6)
}

/// Standard `tracing` logging into the configured file, plus a panic hook that logs a backtrace.
fn start_logging(config: &Config) -> io::Result<()> {
    if let Some(dir) = config.log_file.parent() {
        fs::create_dir_all(dir)?;
    }
    let file = fs::OpenOptions::new().create(true).append(true).open(&config.log_file)?;
    // The builder, not fmt::init(), which would read RUST_LOG.
    tracing_subscriber::fmt()
        .with_writer(Mutex::new(file))
        .with_ansi(false)
        .with_max_level(config.log_level)
        .init();
    // Rust's default hook isn't chained: it reads RUST_BACKTRACE.
    let log_file = config.log_file.clone();
    std::panic::set_hook(Box::new(move |panic| {
        error!("{panic}\n{}", Backtrace::force_capture());
        eprintln!("ClickDown crashed; details are in {}", log_file.display());
    }));
    Ok(())
}

/// Logs an error at ERROR level with its cause chain and a backtrace.
fn log_error(what: &str, err: &dyn Error) {
    let causes: String = std::iter::successors(err.source(), |&e| e.source())
        .map(|e| format!("\n  caused by: {e}"))
        .collect();
    error!("{what}: {err}{causes}\n{}", Backtrace::force_capture());
}

/// Logs a startup failure, tells the user in one line, and exits with 1.
fn fail(what: &str, err: &dyn Error) -> ExitCode {
    log_error(what, err);
    println!("ClickDown {what}: {err}");
    ExitCode::FAILURE
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    use super::*;

    #[test]
    fn markdown_never_makes_the_browser_load_anything() {
        let md = "<b>hi</b>\n\n# Title\n\n- [x] done\n  - [ ] nested\n\n\
                  ![logo](https://x.test/a.png)\n\n| a |\n|:-:|\n| b |\n\n\
                  Loose:\n\n- [ ] one\n\n- [x] two\n";
        let html = markdown_to_html(md);
        let done = r#"<span class="check done" role="img" aria-label="Done"></span>"#;
        let open = r#"<span class="check" role="img" aria-label="Not done"></span>"#;
        assert!(html.contains("&lt;b&gt;hi&lt;/b&gt;"), "{html}");
        assert!(html.contains("<h3>Title</h3>") && !html.contains("<h1"), "{html}");
        assert!(html.contains(&format!("{done}done")), "{html}");
        assert!(html.contains(&format!("{open}nested")), "{html}");
        assert!(html.contains(&format!("<p>{open}one</p>")), "{html}");
        assert!(html.contains(r#"<a href="https://x.test/a.png">logo</a>"#), "{html}");
        assert!(!html.contains("<img") && !html.contains("<input"), "{html}");
        assert!(!html.contains("style="), "{html}");
    }

    /// Runs the real router on a spare local port. Everything asserted here is answered
    /// before any ClickUp call, and in tests api.rs points at a closed local port anyway.
    #[test]
    fn only_lists_is_enforced_by_the_server() {
        let text = "clickup_token = \"pk_test_000000000000\"\nlog_level = \"off\"\n\
                    log_file = \"x.log\"\nanimations = true\nonly_lists = [\"901\"]\n";
        let config = config::parse(text, std::path::Path::new(CONFIG_PATH)).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build();
            runtime.unwrap().block_on(async {
                let clickup = ClickUp::new(&config.token).unwrap();
                let state = AppState { clickup, animations: true, only_lists: config.only_lists };
                let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                axum::serve(listener, app(Arc::new(state))).await.unwrap();
            });
        });
        let get = |path: &str| {
            let mut stream = std::net::TcpStream::connect(addr).unwrap();
            let request =
                format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:4280\r\nConnection: close\r\n\r\n");
            stream.write_all(request.as_bytes()).unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        };
        assert!(get("/api/settings").contains(r#""only_lists":["901"]"#));
        for browsing in [
            "/api/team",
            "/api/team/1/space",
            "/api/team/1/shared",
            "/api/space/1/folder",
            "/api/space/1/list",
            "/api/folder/1/list",
        ] {
            let missing = get(browsing); // the /api JSON fallback, not a ServeDir 404
            assert!(missing.starts_with("HTTP/1.1 404"), "{missing}");
            assert!(missing.contains(r#""error":"not_found""#), "{missing}");
        }
        for other_list in ["/api/list/902", "/api/list/902/task"] {
            let refused = get(other_list);
            assert!(refused.starts_with("HTTP/1.1 403"), "{refused}");
            assert!(refused.contains("not_allowed"), "{refused}");
        }
    }
}
