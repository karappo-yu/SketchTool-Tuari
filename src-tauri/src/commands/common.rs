use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResponse {
    pub success: bool,
    pub message: Option<String>,
}

pub fn ok() -> CommandResponse {
    CommandResponse {
        success: true,
        message: None,
    }
}

pub fn fail(message: impl Into<String>) -> CommandResponse {
    CommandResponse {
        success: false,
        message: Some(message.into()),
    }
}
