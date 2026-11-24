use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

pub const TICKTICK_API_BASE: &str = "https://api.ticktick.com/open/v1";

fn deserialize_null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    T: Default + Deserialize<'de>,
    D: Deserializer<'de>,
{
    let opt = Option::deserialize(deserializer)?;
    Ok(opt.unwrap_or_default())
}

#[derive(Debug, Error)]
pub enum TickTickError {
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("TickTick API returned HTTP {status}: {body}")]
    Api { status: u16, body: String },
}

impl TickTickError {
    pub fn is_unauthorized(&self) -> bool {
        matches!(self, Self::Api { status: 401, .. })
    }

    pub fn is_not_found(&self) -> bool {
        matches!(self, Self::Api { status: 404, .. })
    }

    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Http(_) => true,
            Self::Api { status, .. } => *status == 429 || *status >= 500,
        }
    }

    pub fn sanitized_message(&self) -> String {
        let raw = match self {
            Self::Http(err) => {
                if err.is_timeout() {
                    "TickTick API 요청 시간이 초과되었습니다.".to_string()
                } else if err.is_connect() {
                    "TickTick 서버에 연결할 수 없습니다 (오프라인 상태 확인).".to_string()
                } else {
                    format!("네트워크 오류: {err}")
                }
            }
            Self::Api { status: 401, .. } => {
                "TickTick 인증이 만료되었거나 유효하지 않습니다 (HTTP 401).".to_string()
            }
            Self::Api { status: 429, .. } => {
                "TickTick API 요청 한도를 초과했습니다 (HTTP 429). 잠시 후 자동 재시도합니다."
                    .to_string()
            }
            Self::Api { status, body } => {
                let snippet: String = body.trim().chars().take(180).collect();
                if snippet.is_empty() {
                    format!("TickTick API 오류 (HTTP {status})")
                } else {
                    format!("TickTick API 오류 (HTTP {status}): {snippet}")
                }
            }
        };
        raw.chars().take(240).collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TickTickProjectDto {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub sort_order: i64,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub closed: bool,
    #[serde(default)]
    pub view_mode: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TickTickTagDto {
    pub name: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub sort_order: i64,
    #[serde(rename = "type", default, deserialize_with = "deserialize_null_default")]
    pub tag_type: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TickTickProjectDataDto {
    #[serde(default)]
    pub project: Option<TickTickProjectDto>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub tasks: Vec<TickTickTaskDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TickTickTaskDto {
    pub id: String,
    pub project_id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub tags: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub status: i64,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub time_zone: Option<String>,
    #[serde(default)]
    pub is_all_day: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskRequest {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_all_day: Option<bool>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFilterRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<Vec<i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_date: Option<String>,
}

/// Formats a Unix millisecond timestamp into TickTick's expected `yyyy-MM-dd'T'HH:mm:ss+0000` string.
pub fn format_ticktick_timestamp(ts_ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ts_ms)
        .unwrap_or_else(Utc::now)
        .format("%Y-%m-%dT%H:%M:%S+0000")
        .to_string()
}

pub fn build_default_http_client() -> Client {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| Client::new())
}

pub struct TickTickClient {
    http: Client,
    base_url: String,
    access_token: String,
}

impl TickTickClient {
    pub fn new(access_token: impl Into<String>) -> Self {
        Self::with_base_url(TICKTICK_API_BASE, access_token)
    }

    pub fn with_base_url(base_url: impl Into<String>, access_token: impl Into<String>) -> Self {
        Self::with_http_client(build_default_http_client(), base_url, access_token)
    }

    pub fn with_http_client(
        http: Client,
        base_url: impl Into<String>,
        access_token: impl Into<String>,
    ) -> Self {
        Self {
            http,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            access_token: access_token.into(),
        }
    }

    pub async fn list_projects(&self) -> Result<Vec<TickTickProjectDto>, TickTickError> {
        let resp = self
            .http
            .get(format!("{}/project", self.base_url))
            .bearer_auth(&self.access_token)
            .send()
            .await?;
        Self::decode_json(resp).await
    }

    pub async fn list_tags(&self) -> Result<Vec<TickTickTagDto>, TickTickError> {
        let resp = self
            .http
            .get(format!("{}/tag", self.base_url))
            .bearer_auth(&self.access_token)
            .send()
            .await?;
        Self::decode_json(resp).await
    }

    pub async fn get_project_data(
        &self,
        project_id: &str,
    ) -> Result<TickTickProjectDataDto, TickTickError> {
        let resp = self
            .http
            .get(format!("{}/project/{project_id}/data", self.base_url))
            .bearer_auth(&self.access_token)
            .send()
            .await?;
        Self::decode_json(resp).await
    }

    pub async fn get_inbox_data(&self) -> Result<TickTickProjectDataDto, TickTickError> {
        self.get_project_data("inbox").await
    }

    pub async fn filter_tasks(
        &self,
        filter: &TaskFilterRequest,
    ) -> Result<Vec<TickTickTaskDto>, TickTickError> {
        let resp = self
            .http
            .post(format!("{}/task/filter", self.base_url))
            .bearer_auth(&self.access_token)
            .json(filter)
            .send()
            .await?;
        Self::decode_json(resp).await
    }

    pub async fn get_task(
        &self,
        project_id: &str,
        task_id: &str,
    ) -> Result<TickTickTaskDto, TickTickError> {
        let resp = self
            .http
            .get(format!(
                "{}/project/{project_id}/task/{task_id}",
                self.base_url
            ))
            .bearer_auth(&self.access_token)
            .send()
            .await?;
        Self::decode_json(resp).await
    }

    pub async fn create_task(
        &self,
        payload: &CreateTaskRequest,
    ) -> Result<TickTickTaskDto, TickTickError> {
        let resp = self
            .http
            .post(format!("{}/task", self.base_url))
            .bearer_auth(&self.access_token)
            .json(payload)
            .send()
            .await?;
        Self::decode_json(resp).await
    }

    pub async fn complete_task(
        &self,
        project_id: &str,
        task_id: &str,
    ) -> Result<(), TickTickError> {
        let resp = self
            .http
            .post(format!(
                "{}/project/{project_id}/task/{task_id}/complete",
                self.base_url
            ))
            .bearer_auth(&self.access_token)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(TickTickError::Api {
                status: status.as_u16(),
                body,
            });
        }
        Ok(())
    }

    pub async fn delete_task(
        &self,
        project_id: &str,
        task_id: &str,
    ) -> Result<(), TickTickError> {
        let resp = self
            .http
            .delete(format!(
                "{}/project/{project_id}/task/{task_id}",
                self.base_url
            ))
            .bearer_auth(&self.access_token)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(TickTickError::Api {
                status: status.as_u16(),
                body,
            });
        }
        Ok(())
    }

    async fn decode_json<T: for<'de> Deserialize<'de>>(
        resp: reqwest::Response,
    ) -> Result<T, TickTickError> {
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(TickTickError::Api {
                status: status.as_u16(),
                body,
            });
        }
        Ok(resp.json::<T>().await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_ticktick_iso_timestamp() {
        assert_eq!(
            format_ticktick_timestamp(1_700_000_000_000),
            "2023-11-14T22:13:20+0000"
        );
    }

    #[test]
    fn serializes_subtask_request_with_camel_case_fields() {
        let req = CreateTaskRequest {
            title: "[Spec] 수행".into(),
            project_id: Some("proj1".into()),
            parent_id: Some("parent1".into()),
            content: None,
            start_date: Some("2026-11-24T09:00:00+0000".into()),
            due_date: Some("2026-11-24T10:00:00+0000".into()),
            time_zone: Some("Asia/Seoul".into()),
            is_all_day: Some(false),
            tags: vec!["tempo".into()],
        };
        let value = serde_json::to_value(&req).unwrap();
        assert_eq!(value["projectId"], "proj1");
        assert_eq!(value["parentId"], "parent1");
        assert_eq!(value["isAllDay"], false);
        assert!(value.get("content").is_none());
    }

    #[test]
    fn deserializes_live_ticktick_shapes_with_omitted_and_null_fields() {
        let project: TickTickProjectDto = serde_json::from_str(
            r#"{"id":"p1","name":"Study","color":null,"sortOrder":null,"closed":null}"#,
        )
        .unwrap();
        assert_eq!(project.id, "p1");
        assert!(!project.closed);
        assert_eq!(project.sort_order, 0);

        let inbox: TickTickProjectDataDto =
            serde_json::from_str(r#"{"tasks":[],"columns":[]}"#).unwrap();
        assert!(inbox.project.is_none());
        assert!(inbox.tasks.is_empty());

        let tag: TickTickTagDto =
            serde_json::from_str(r#"{"name":"dev","label":"Dev","sortOrder":1,"type":0}"#)
                .unwrap();
        assert_eq!(tag.name, "dev");
        assert_eq!(tag.label.as_deref(), Some("Dev"));
    }
}
