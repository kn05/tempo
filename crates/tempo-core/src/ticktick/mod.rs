pub mod client;
pub mod oauth;
pub mod secrets;
pub mod sync;

pub use client::{
    build_default_http_client, format_ticktick_timestamp, CreateTaskRequest, TaskFilterRequest,
    TickTickClient, TickTickError, TickTickProjectDataDto, TickTickProjectDto, TickTickTagDto,
    TickTickTaskDto, TICKTICK_API_BASE,
};
pub use oauth::{
    build_authorize_url, compute_s256_challenge, exchange_authorization_code, format_redirect_uri,
    generate_oauth_state, generate_pkce, refresh_access_token, LoopbackCallbackListener,
    OAuthEndpoints, OAuthError, PkceChallenge, TICKTICK_OAUTH_AUTHORIZE_URL, TICKTICK_OAUTH_SCOPE,
    TICKTICK_OAUTH_TOKEN_URL,
};
pub use secrets::{
    CredentialManager, KeyringSecretStore, MemorySecretStore, SecretError, SecretStore,
    TickTickCredentials, ACCOUNT_OAUTH_CLIENT_SECRET, ACCOUNT_TICKTICK_CREDENTIALS,
    KEYRING_SERVICE,
};
pub use sync::{
    detect_local_time_zone, retry_backoff_ms, PendingOAuthSession, SyncServiceError,
    SyncWorkerHandle, TickTickService, DEFAULT_OAUTH_TIMEOUT_SECS,
    DEFAULT_SYNC_WORKER_INTERVAL_SECS, MAX_AUTO_SYNC_RETRIES,
};
