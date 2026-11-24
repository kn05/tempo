use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::Duration;

use base64::engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use chrono::Utc;
use reqwest::Client;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use url::Url;
use uuid::Uuid;

use crate::models::TickTickAuthMethod;
use crate::ticktick::secrets::TickTickCredentials;

pub const TICKTICK_OAUTH_AUTHORIZE_URL: &str = "https://ticktick.com/oauth/authorize";
pub const TICKTICK_OAUTH_TOKEN_URL: &str = "https://ticktick.com/oauth/token";
pub const TICKTICK_OAUTH_SCOPE: &str = "tasks:read tasks:write";

#[derive(Debug, Clone)]
pub struct OAuthEndpoints {
    pub authorize_url: String,
    pub token_url: String,
}

impl Default for OAuthEndpoints {
    fn default() -> Self {
        Self {
            authorize_url: TICKTICK_OAUTH_AUTHORIZE_URL.to_string(),
            token_url: TICKTICK_OAUTH_TOKEN_URL.to_string(),
        }
    }
}

#[derive(Debug, Error)]
pub enum OAuthError {
    #[error("OAuth2 configuration missing: {0}")]
    InvalidConfig(String),
    #[error("Failed to bind loopback callback server on 127.0.0.1:{port}: {message}")]
    BindFailed { port: u16, message: String },
    #[error("OAuth2 authorization timed out before callback was received")]
    TimedOut,
    #[error("OAuth2 login was cancelled")]
    Cancelled,
    #[error("OAuth2 provider denied authorization: {error}{}", description.as_ref().map(|d| format!(" ({d})")).unwrap_or_default())]
    ProviderDenied {
        error: String,
        description: Option<String>,
    },
    #[error("OAuth2 state mismatch — possible CSRF attempt, aborting login")]
    StateMismatch,
    #[error("OAuth2 callback did not include an authorization code")]
    MissingCode,
    #[error("OAuth2 token request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("OAuth2 token endpoint returned HTTP {status}: {body}")]
    TokenEndpoint { status: u16, body: String },
    #[error("OAuth2 token response missing access_token")]
    MissingAccessToken,
    #[error("Loopback callback I/O error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PkceChallenge {
    pub verifier: String,
    pub challenge: String,
    pub method: &'static str,
}

/// Generates a RFC 7636 PKCE S256 verifier/challenge pair using OS CSPRNG bytes via UUID v4.
pub fn generate_pkce() -> PkceChallenge {
    let mut entropy = [0u8; 48];
    entropy[0..16].copy_from_slice(Uuid::new_v4().as_bytes());
    entropy[16..32].copy_from_slice(Uuid::new_v4().as_bytes());
    entropy[32..48].copy_from_slice(Uuid::new_v4().as_bytes());

    let verifier = URL_SAFE_NO_PAD.encode(entropy);
    let challenge = compute_s256_challenge(&verifier);
    PkceChallenge {
        verifier,
        challenge,
        method: "S256",
    }
}

pub fn compute_s256_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

/// Generates a high-entropy CSRF state token for OAuth2 authorization requests.
pub fn generate_oauth_state() -> String {
    let mut entropy = [0u8; 32];
    entropy[0..16].copy_from_slice(Uuid::new_v4().as_bytes());
    entropy[16..32].copy_from_slice(Uuid::new_v4().as_bytes());
    URL_SAFE_NO_PAD.encode(entropy)
}

pub fn format_redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}/callback")
}

pub fn build_authorize_url(
    endpoints: &OAuthEndpoints,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    pkce: &PkceChallenge,
) -> Result<String, OAuthError> {
    let mut url = Url::parse(&endpoints.authorize_url)
        .map_err(|e| OAuthError::InvalidConfig(format!("invalid authorize_url: {e}")))?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", TICKTICK_OAUTH_SCOPE)
        .append_pair("state", state)
        .append_pair("code_challenge", &pkce.challenge)
        .append_pair("code_challenge_method", pkce.method);
    Ok(url.into())
}

/// Bound local loopback server ready to accept a single TickTick OAuth2 callback.
pub struct LoopbackCallbackListener {
    listener: TcpListener,
    local_addr: SocketAddr,
}

impl LoopbackCallbackListener {
    pub async fn bind(port: u16) -> Result<Self, OAuthError> {
        let listener = TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|e| OAuthError::BindFailed {
                port,
                message: e.to_string(),
            })?;
        let local_addr = listener.local_addr()?;
        Ok(Self {
            listener,
            local_addr,
        })
    }

    pub fn port(&self) -> u16 {
        self.local_addr.port()
    }

    pub fn redirect_uri(&self) -> String {
        format_redirect_uri(self.port())
    }

    /// Waits for a GET `/callback` request on `127.0.0.1`, verifies `state`, responds with an HTML
    /// completion page, and returns the authorization `code`.
    pub async fn wait_for_code(
        self,
        expected_state: &str,
        timeout: Duration,
        mut cancel_rx: oneshot::Receiver<()>,
    ) -> Result<String, OAuthError> {
        let deadline = tokio::time::Instant::now() + timeout;

        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(OAuthError::TimedOut);
            }

            let accepted = tokio::select! {
                _ = &mut cancel_rx => return Err(OAuthError::Cancelled),
                _ = tokio::time::sleep(remaining) => return Err(OAuthError::TimedOut),
                res = self.listener.accept() => res?,
            };

            let (mut stream, _) = accepted;
            let mut buf = vec![0u8; 8192];
            let read_len = match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf))
                .await
            {
                Ok(Ok(n)) if n > 0 => n,
                _ => continue,
            };

            let request_text = String::from_utf8_lossy(&buf[..read_len]);
            let Some(request_line) = request_text.lines().next() else {
                let _ = write_http_response(&mut stream, 400, "Bad Request", "Invalid HTTP request")
                    .await;
                continue;
            };

            let mut parts = request_line.split_whitespace();
            let method = parts.next().unwrap_or("");
            let target = parts.next().unwrap_or("/");

            if method != "GET" {
                let _ = write_http_response(
                    &mut stream,
                    405,
                    "Method Not Allowed",
                    "Only GET callbacks are supported.",
                )
                .await;
                continue;
            }

            let parsed_url = match Url::parse(&format!("http://127.0.0.1{target}")) {
                Ok(u) => u,
                Err(_) => {
                    let _ = write_http_response(&mut stream, 400, "Bad Request", "Malformed URL")
                        .await;
                    continue;
                }
            };

            // Browsers commonly request `/favicon.ico` alongside `/callback`; ignore cleanly.
            if parsed_url.path() != "/callback" {
                let _ = write_http_response(&mut stream, 404, "Not Found", "Not found").await;
                continue;
            }

            let params: HashMap<String, String> = parsed_url
                .query_pairs()
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();

            if let Some(error) = params.get("error").cloned() {
                let description = params.get("error_description").cloned();
                let html = render_callback_html(
                    false,
                    "TickTick 인증이 취소되었거나 거부되었습니다.",
                    "창을 닫고 tempo로 돌아가 다시 시도할 수 있습니다.",
                );
                let _ = write_http_html(&mut stream, 400, "Bad Request", &html).await;
                return Err(OAuthError::ProviderDenied { error, description });
            }

            let received_state = params.get("state").map(String::as_str).unwrap_or("");
            if received_state != expected_state {
                let html = render_callback_html(
                    false,
                    "OAuth2 보안 상태(state) 검증에 실패했습니다.",
                    "보안을 위해 인증을 중단했습니다. tempo에서 로그인을 다시 시작해주세요.",
                );
                let _ = write_http_html(&mut stream, 400, "Bad Request", &html).await;
                return Err(OAuthError::StateMismatch);
            }

            let Some(code) = params
                .get("code")
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
            else {
                let html = render_callback_html(
                    false,
                    "인가 코드(code)가 응답에 포함되지 않았습니다.",
                    "tempo에서 TickTick 로그인을 다시 시도해주세요.",
                );
                let _ = write_http_html(&mut stream, 400, "Bad Request", &html).await;
                return Err(OAuthError::MissingCode);
            };

            let html = render_callback_html(
                true,
                "TickTick 계정이 성공적으로 연결되었습니다!",
                "이 브라우저 탭을 닫고 tempo 앱으로 돌아가세요.",
            );
            let _ = write_http_html(&mut stream, 200, "OK", &html).await;
            return Ok(code);
        }
    }
}

#[derive(Debug, Deserialize)]
struct OAuthTokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    token_type: Option<String>,
    scope: Option<String>,
    expires_in: Option<i64>,
}

pub async fn exchange_authorization_code(
    http: &Client,
    endpoints: &OAuthEndpoints,
    client_id: &str,
    client_secret: &str,
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> Result<TickTickCredentials, OAuthError> {
    let basic = BASE64_STANDARD.encode(format!("{client_id}:{client_secret}"));
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("scope", TICKTICK_OAUTH_SCOPE),
        ("code_verifier", code_verifier),
    ];

    let resp = http
        .post(&endpoints.token_url)
        .header("Authorization", format!("Basic {basic}"))
        .header("Accept", "application/json")
        .form(&form)
        .send()
        .await?;

    decode_token_response(resp, None).await
}

pub async fn refresh_access_token(
    http: &Client,
    endpoints: &OAuthEndpoints,
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<TickTickCredentials, OAuthError> {
    let basic = BASE64_STANDARD.encode(format!("{client_id}:{client_secret}"));
    let form = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("scope", TICKTICK_OAUTH_SCOPE),
    ];

    let resp = http
        .post(&endpoints.token_url)
        .header("Authorization", format!("Basic {basic}"))
        .header("Accept", "application/json")
        .form(&form)
        .send()
        .await?;

    decode_token_response(resp, Some(refresh_token.to_string())).await
}

async fn decode_token_response(
    resp: reqwest::Response,
    fallback_refresh_token: Option<String>,
) -> Result<TickTickCredentials, OAuthError> {
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(240).collect();
        return Err(OAuthError::TokenEndpoint {
            status: status.as_u16(),
            body: snippet,
        });
    }

    let parsed: OAuthTokenResponse = resp.json().await?;
    let Some(access_token) = parsed
        .access_token
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    else {
        return Err(OAuthError::MissingAccessToken);
    };

    let expires_at_ms = parsed
        .expires_in
        .filter(|secs| *secs > 0)
        .map(|secs| Utc::now().timestamp_millis().saturating_add(secs * 1_000));

    let refresh_token = parsed
        .refresh_token
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or(fallback_refresh_token);

    Ok(TickTickCredentials {
        auth_method: TickTickAuthMethod::OAuth2,
        access_token,
        refresh_token,
        token_type: parsed.token_type,
        scope: parsed.scope,
        expires_at_ms,
    })
}

async fn write_http_response(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    reason: &str,
    body: &str,
) -> std::io::Result<()> {
    let payload = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(payload.as_bytes()).await?;
    stream.shutdown().await
}

async fn write_http_html(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    reason: &str,
    html: &str,
) -> std::io::Result<()> {
    let payload = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
    stream.write_all(payload.as_bytes()).await?;
    stream.shutdown().await
}

fn render_callback_html(ok: bool, title: &str, detail: &str) -> String {
    let accent = if ok { "#10b981" } else { "#f43f5e" };
    let badge = if ok { "CONNECTED" } else { "AUTH FAILED" };
    format!(
        r#"<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <title>tempo — TickTick OAuth2</title>
  <style>
    body {{ margin:0; font-family: system-ui, -apple-system, sans-serif; background:#09090b; color:#f4f4f5; display:grid; place-items:center; min-height:100vh; }}
    .card {{ max-width:440px; padding:28px; border-radius:16px; border:1px solid #27272a; background:#18181b; text-align:center; box-shadow:0 20px 50px rgba(0,0,0,0.45); }}
    .badge {{ display:inline-block; padding:4px 10px; border-radius:999px; font-size:11px; font-weight:700; letter-spacing:0.06em; color:{accent}; border:1px solid {accent}; margin-bottom:14px; }}
    h1 {{ margin:0 0 10px; font-size:18px; }}
    p {{ margin:0; font-size:13px; color:#a1a1aa; line-height:1.6; }}
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">{badge}</div>
    <h1>{title}</h1>
    <p>{detail}</p>
  </div>
</body>
</html>"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_rfc7636_pkce_s256_and_authorize_url() {
        let pkce = generate_pkce();
        assert!(pkce.verifier.len() >= 43 && pkce.verifier.len() <= 128);
        assert_eq!(pkce.challenge, compute_s256_challenge(&pkce.verifier));
        assert_eq!(pkce.method, "S256");

        let state = generate_oauth_state();
        assert!(state.len() >= 32);

        let url = build_authorize_url(
            &OAuthEndpoints::default(),
            "client-abc",
            "http://127.0.0.1:18492/callback",
            &state,
            &pkce,
        )
        .unwrap();
        let parsed = Url::parse(&url).unwrap();
        let params: HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(params.get("client_id").map(String::as_str), Some("client-abc"));
        assert_eq!(
            params.get("redirect_uri").map(String::as_str),
            Some("http://127.0.0.1:18492/callback")
        );
        assert_eq!(params.get("response_type").map(String::as_str), Some("code"));
        assert_eq!(
            params.get("scope").map(String::as_str),
            Some("tasks:read tasks:write")
        );
        assert_eq!(params.get("state").map(String::as_str), Some(state.as_str()));
        assert_eq!(
            params.get("code_challenge").map(String::as_str),
            Some(pkce.challenge.as_str())
        );
        assert_eq!(
            params.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
    }

    #[tokio::test]
    async fn loopback_listener_ignores_favicon_and_validates_state() {
        let listener = LoopbackCallbackListener::bind(0).await.unwrap();
        let port = listener.port();
        let (_tx, rx) = oneshot::channel();

        let server = tokio::spawn(async move {
            listener
                .wait_for_code("expected-state-123", Duration::from_secs(5), rx)
                .await
        });

        let client = Client::new();
        // Browser favicon probe should return 404 without terminating listener.
        let fav = client
            .get(format!("http://127.0.0.1:{port}/favicon.ico"))
            .send()
            .await
            .unwrap();
        assert_eq!(fav.status().as_u16(), 404);

        // Valid callback delivers code.
        let cb = client
            .get(format!(
                "http://127.0.0.1:{port}/callback?code=auth-code-xyz&state=expected-state-123"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(cb.status().as_u16(), 200);

        let code = server.await.unwrap().unwrap();
        assert_eq!(code, "auth-code-xyz");
    }

    #[tokio::test]
    async fn loopback_listener_rejects_mismatched_state() {
        let listener = LoopbackCallbackListener::bind(0).await.unwrap();
        let port = listener.port();
        let (_tx, rx) = oneshot::channel();

        let server = tokio::spawn(async move {
            listener
                .wait_for_code("expected-state", Duration::from_secs(5), rx)
                .await
        });

        let client = Client::new();
        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/callback?code=evil&state=wrong-state"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 400);

        let err = server.await.unwrap().unwrap_err();
        assert!(matches!(err, OAuthError::StateMismatch));
    }
}
