//! A redirect must never carry the bearer to another origin.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;

/// A one-request HTTP server: answers with `response`, reports the request's
/// Authorization header (or "none") on the channel, returns its address.
fn once(response: String) -> (String, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut auth = "none".to_string();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" || line.is_empty() {
                break;
            }
            if line.to_ascii_lowercase().starts_with("authorization:") {
                auth = line["authorization:".len()..].trim().to_string();
            }
        }
        tx.send(auth).unwrap();
        stream.write_all(response.as_bytes()).unwrap();
    });
    (format!("http://{addr}"), rx)
}

fn ok() -> String {
    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}"
        .to_string()
}

fn redirect_to(location: &str) -> String {
    format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
}

fn client(base: &str) -> novamem::Client {
    novamem::Client::new(novamem::Config {
        base_url: base.into(),
        token: "nm_secret".into(),
        ..Default::default()
    })
    .unwrap()
}

// Pins reqwest's behaviour, which this crate relies on rather than
// re-implementing: a reqwest upgrade that stopped stripping Authorization on
// a cross-host redirect would fail here.
#[tokio::test]
async fn a_cross_origin_redirect_drops_the_bearer() {
    let (target, seen_target) = once(ok());
    // 127.0.0.1 vs localhost: a different origin for the same host.
    let (origin, seen_origin) = once(redirect_to(&format!(
        "{}/health",
        target.replace("127.0.0.1", "localhost")
    )));
    assert!(client(&origin).health().await.unwrap());
    assert_eq!(seen_origin.recv().unwrap(), "Bearer nm_secret");
    assert_eq!(
        seen_target.recv().unwrap(),
        "none",
        "the bearer followed a redirect to another origin"
    );
}
