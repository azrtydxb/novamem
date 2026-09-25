//! Live round trip against a real server, for the sdk-smoke CI job.
//!
//!     NOVAMEM_SMOKE_URL=… NOVAMEM_SMOKE_TOKEN=… cargo run --example smoke -- up|down
//!
//! up:   capture → search finds it → forget deletes it → search no longer finds it.
//! down: the server has been stopped; search must report unavailable, not an
//!       empty result. Every failure prints "rust <step>: <detail>" and exits 1.

use novamem::types::{CaptureRequest, ForgetRequest, SearchRequest};
use novamem::{Client, Config};
use std::time::{SystemTime, UNIX_EPOCH};

fn fail(step: &str, detail: impl std::fmt::Display) -> ! {
    println!("rust {step}: {detail}");
    std::process::exit(1)
}

fn step<T>(name: &str, r: Result<T, novamem::Error>) -> T {
    r.unwrap_or_else(|e| fail(name, e))
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let c = step(
        "connect",
        Client::new(Config {
            base_url: std::env::var("NOVAMEM_SMOKE_URL").unwrap_or_default(),
            token: std::env::var("NOVAMEM_SMOKE_TOKEN").unwrap_or_default(),
            ..Config::default()
        }),
    );
    if std::env::args().nth(1).as_deref() == Some("down") {
        match c
            .search(SearchRequest {
                query: "anything".into(),
                ..Default::default()
            })
            .await
        {
            Err(e) if e.is_unavailable() => println!("PASS rust down"),
            Err(e) => fail("down", format!("want unavailable, got {e}")),
            Ok(_) => fail("down", "search succeeded against a stopped server"),
        }
        return;
    }
    let marker = format!(
        "{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let query = || SearchRequest {
        query: marker.clone(),
        namespace: Some("sdk-smoke".into()),
        ..Default::default()
    };
    let content = format!("sdk-smoke rust {marker}");
    let cap = step(
        "capture",
        c.capture(CaptureRequest {
            content,
            namespace: Some("sdk-smoke".into()),
            force: Some(true),
            ..Default::default()
        })
        .await,
    );
    let Some(id) = cap.id.filter(|s| !s.is_empty()) else {
        fail("capture", "not saved")
    };
    let hits = step("search", c.search(query()).await);
    if !hits.results.iter().any(|r| r.id == id) {
        fail("search", format!("captured {id} not found"));
    }
    let gone = step(
        "forget",
        c.forget(ForgetRequest {
            id: id.clone(),
            ..Default::default()
        })
        .await,
    );
    if !gone.deleted {
        fail("forget", format!("{gone:?}"));
    }
    let after = step("search-after-forget", c.search(query()).await);
    if after.results.iter().any(|r| r.id == id) {
        fail("search-after-forget", format!("{id} still returned"));
    }
    println!("PASS rust up");
}
