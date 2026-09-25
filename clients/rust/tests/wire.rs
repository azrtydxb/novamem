//! Encoding and decoding edges the scenario suite does not reach.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;

use novamem::types::{MintTokenRequestScope, SearchRequest};
use novamem::{Client, Config};

/// A one-request HTTP server answering 200 with `body`.
fn answering(body: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        let mut r = BufReader::new(s.try_clone().unwrap());
        let mut len = 0usize;
        loop {
            let mut line = String::new();
            r.read_line(&mut line).unwrap();
            if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                len = v.trim().parse().unwrap();
            }
            if line == "\r\n" {
                break;
            }
        }
        let mut b = vec![0; len];
        std::io::Read::read_exact(&mut r, &mut b).unwrap();
        write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    });
    format!("http://{addr}")
}

fn client(base: &str) -> Client {
    Client::new(Config {
        base_url: base.into(),
        token: "nm_x".into(),
        ..Default::default()
    })
    .unwrap()
}

// proved by: removing `#[serde(other)] Unknown` from the enum template makes
// an unknown value fail to decode.
#[test]
fn an_unknown_enum_value_decodes_as_unknown() {
    let v: MintTokenRequestScope = serde_json::from_str("\"brand-new-scope\"").unwrap();
    assert_eq!(v, MintTokenRequestScope::Unknown);
    let known: MintTokenRequestScope = serde_json::from_str("\"read_only\"").unwrap();
    assert_eq!(known, MintTokenRequestScope::ReadOnly);
}

// proved by: dropping `.with_status(r.status)` from decode() reports 0.
#[tokio::test]
async fn a_body_of_the_wrong_shape_keeps_its_status() {
    let base = answering(r#"{"results": "not-a-list"}"#);
    let e = client(&base)
        .search(SearchRequest {
            query: "q".into(),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert!(e.is_unavailable(), "{e}");
    assert_eq!(e.status(), 200);
}
