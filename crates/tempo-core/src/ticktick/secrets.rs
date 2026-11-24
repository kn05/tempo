use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::models::TickTickAuthMethod;

pub const KEYRING_SERVICE: &str = "app.tempo.ticktick";
pub const ACCOUNT_TICKTICK_CREDENTIALS: &str = "ticktick_credentials";
pub const ACCOUNT_OAUTH_CLIENT_SECRET: &str = "ticktick_oauth_client_secret";

#[derive(Debug, Error)]
pub enum SecretError {
    #[error("OS credential store error: {0}")]
    Storage(String),
    #[error("Failed to serialize or deserialize stored credentials: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("Secret store mutex poisoned")]
    LockPoisoned,
}

/// Persisted TickTick authentication tokens stored exclusively in the OS keyring.
///
/// Custom `Debug` ensures tokens are never accidentally printed to logs or error messages.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TickTickCredentials {
    pub auth_method: TickTickAuthMethod,
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub token_type: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub expires_at_ms: Option<i64>,
}

impl fmt::Debug for TickTickCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TickTickCredentials")
            .field("auth_method", &self.auth_method)
            .field("access_token", &"[REDACTED]")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field("token_type", &self.token_type)
            .field("scope", &self.scope)
            .field("expires_at_ms", &self.expires_at_ms)
            .finish()
    }
}

impl TickTickCredentials {
    pub fn is_expired_or_near_expiry(&self, now_ms: i64, leeway_ms: i64) -> bool {
        self.expires_at_ms
            .is_some_and(|exp| now_ms.saturating_add(leeway_ms) >= exp)
    }
}

/// Platform-abstracted secure secret storage trait (OS Keyring in production, in-memory in tests).
pub trait SecretStore: Send + Sync {
    fn get_secret(&self, account: &str) -> Result<Option<String>, SecretError>;
    fn set_secret(&self, account: &str, secret: &str) -> Result<(), SecretError>;
    fn delete_secret(&self, account: &str) -> Result<(), SecretError>;
}

/// OS Credential Store backed by the `keyring` crate:
/// - Windows: Windows Credential Manager (`windows-native`)
/// - Linux: Kernel keyutils (`linux-native`)
/// - macOS: Keychain (`apple-native`)
///
/// Serializes underlying keystore calls with a `Mutex` because native credential stores
/// may fail under concurrent multi-threaded access to the same entry.
pub struct KeyringSecretStore {
    service: String,
    io_lock: Mutex<()>,
}

impl KeyringSecretStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
            io_lock: Mutex::new(()),
        }
    }

    pub fn default_service() -> Self {
        Self::new(KEYRING_SERVICE)
    }
}

impl Default for KeyringSecretStore {
    fn default() -> Self {
        Self::default_service()
    }
}

impl SecretStore for KeyringSecretStore {
    fn get_secret(&self, account: &str) -> Result<Option<String>, SecretError> {
        let _guard = self.io_lock.lock().map_err(|_| SecretError::LockPoisoned)?;
        let entry = keyring::Entry::new(&self.service, account)
            .map_err(|e| SecretError::Storage(e.to_string()))?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(SecretError::Storage(err.to_string())),
        }
    }

    fn set_secret(&self, account: &str, secret: &str) -> Result<(), SecretError> {
        let _guard = self.io_lock.lock().map_err(|_| SecretError::LockPoisoned)?;
        let entry = keyring::Entry::new(&self.service, account)
            .map_err(|e| SecretError::Storage(e.to_string()))?;
        entry
            .set_password(secret)
            .map_err(|e| SecretError::Storage(e.to_string()))
    }

    fn delete_secret(&self, account: &str) -> Result<(), SecretError> {
        let _guard = self.io_lock.lock().map_err(|_| SecretError::LockPoisoned)?;
        let entry = keyring::Entry::new(&self.service, account)
            .map_err(|e| SecretError::Storage(e.to_string()))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(SecretError::Storage(err.to_string())),
        }
    }
}

/// Deterministic in-memory secret store for unit tests and headless environments.
#[derive(Default)]
pub struct MemorySecretStore {
    entries: Mutex<HashMap<String, String>>,
}

impl MemorySecretStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SecretStore for MemorySecretStore {
    fn get_secret(&self, account: &str) -> Result<Option<String>, SecretError> {
        let guard = self.entries.lock().map_err(|_| SecretError::LockPoisoned)?;
        Ok(guard.get(account).cloned())
    }

    fn set_secret(&self, account: &str, secret: &str) -> Result<(), SecretError> {
        let mut guard = self.entries.lock().map_err(|_| SecretError::LockPoisoned)?;
        guard.insert(account.to_string(), secret.to_string());
        Ok(())
    }

    fn delete_secret(&self, account: &str) -> Result<(), SecretError> {
        let mut guard = self.entries.lock().map_err(|_| SecretError::LockPoisoned)?;
        guard.remove(account);
        Ok(())
    }
}

/// Typed credential helper over a `SecretStore`.
pub struct CredentialManager {
    store: Arc<dyn SecretStore>,
}

impl CredentialManager {
    pub fn new(store: Arc<dyn SecretStore>) -> Self {
        Self { store }
    }

    pub fn system_keyring() -> Self {
        Self::new(Arc::new(KeyringSecretStore::default_service()))
    }

    pub fn load_credentials(&self) -> Result<Option<TickTickCredentials>, SecretError> {
        let Some(raw) = self.store.get_secret(ACCOUNT_TICKTICK_CREDENTIALS)? else {
            return Ok(None);
        };
        let creds: TickTickCredentials = serde_json::from_str(&raw)?;
        if creds.access_token.trim().is_empty() {
            return Ok(None);
        }
        Ok(Some(creds))
    }

    pub fn save_credentials(&self, creds: &TickTickCredentials) -> Result<(), SecretError> {
        let json = serde_json::to_string(creds)?;
        self.store.set_secret(ACCOUNT_TICKTICK_CREDENTIALS, &json)
    }

    pub fn clear_credentials(&self) -> Result<(), SecretError> {
        self.store.delete_secret(ACCOUNT_TICKTICK_CREDENTIALS)
    }

    pub fn load_oauth_client_secret(&self) -> Result<Option<String>, SecretError> {
        let raw = self.store.get_secret(ACCOUNT_OAUTH_CLIENT_SECRET)?;
        Ok(raw
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()))
    }

    pub fn save_oauth_client_secret(&self, secret: &str) -> Result<(), SecretError> {
        let trimmed = secret.trim();
        if trimmed.is_empty() {
            return self.clear_oauth_client_secret();
        }
        self.store.set_secret(ACCOUNT_OAUTH_CLIENT_SECRET, trimmed)
    }

    pub fn clear_oauth_client_secret(&self) -> Result<(), SecretError> {
        self.store.delete_secret(ACCOUNT_OAUTH_CLIENT_SECRET)
    }

    pub fn has_oauth_client_secret(&self) -> bool {
        self.load_oauth_client_secret().ok().flatten().is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_tokens_in_debug_output_and_roundtrips_via_store() {
        let store = Arc::new(MemorySecretStore::new());
        let mgr = CredentialManager::new(store);

        assert!(mgr.load_credentials().unwrap().is_none());
        assert!(!mgr.has_oauth_client_secret());

        let creds = TickTickCredentials {
            auth_method: TickTickAuthMethod::OAuth2,
            access_token: "super-secret-access-token".into(),
            refresh_token: Some("super-secret-refresh-token".into()),
            token_type: Some("bearer".into()),
            scope: Some("tasks:read tasks:write".into()),
            expires_at_ms: Some(1_800_000_000_000),
        };

        let debug_str = format!("{creds:?}");
        assert!(!debug_str.contains("super-secret-access-token"));
        assert!(!debug_str.contains("super-secret-refresh-token"));
        assert!(debug_str.contains("[REDACTED]"));
        assert_eq!(
            serde_json::to_string(&TickTickAuthMethod::OAuth2).unwrap(),
            "\"oauth2\""
        );
        assert_eq!(
            serde_json::to_string(&TickTickAuthMethod::PersonalToken).unwrap(),
            "\"personal_token\""
        );

        mgr.save_credentials(&creds).unwrap();
        assert_eq!(mgr.load_credentials().unwrap(), Some(creds));

        mgr.save_oauth_client_secret("my-client-secret").unwrap();
        assert!(mgr.has_oauth_client_secret());
        assert_eq!(
            mgr.load_oauth_client_secret().unwrap().as_deref(),
            Some("my-client-secret")
        );

        mgr.clear_credentials().unwrap();
        assert!(mgr.load_credentials().unwrap().is_none());

        mgr.save_oauth_client_secret("   ").unwrap();
        assert!(!mgr.has_oauth_client_secret());
    }
}
