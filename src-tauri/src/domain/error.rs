use serde::Serialize;

/// Internal error type. Rich variants for the backend; converted to a stable
/// `AppErrorDto` before crossing to the frontend so UI code never matches on
/// wording. New variants are additive — never renumber `code`.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("invalid input: {0}")]
    InputValidation(String),

    #[error("probe failed: {0}")]
    Probe(String),

    #[error("unsupported media: {0}")]
    UnsupportedMedia(String),

    #[error("ffmpeg failed to spawn: {0}")]
    SidecarSpawn(String),

    #[error("ffmpeg exited with code {code:?}: {stderr_tail}")]
    FfmpegExit { code: Option<i32>, stderr_tail: String },

    #[allow(dead_code)] // used once filtergraph validation lands
    #[error("filter graph error: {0}")]
    FilterGraph(String),

    #[error("output verification failed: {0}")]
    OutputVerify(String),

    #[error("cancelled")]
    Cancelled,

    #[error("io error: {0}")]
    Io(String),
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

/// Stable wire shape handed to the frontend. `kind` is a machine-stable slug;
/// `message` is human text (may change freely).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppErrorDto {
    pub kind: String,
    pub message: String,
}

impl AppError {
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::InputValidation(_) => "inputValidation",
            AppError::Probe(_) => "probe",
            AppError::UnsupportedMedia(_) => "unsupportedMedia",
            AppError::SidecarSpawn(_) => "sidecarSpawn",
            AppError::FfmpegExit { .. } => "ffmpegExit",
            AppError::FilterGraph(_) => "filterGraph",
            AppError::OutputVerify(_) => "outputVerify",
            AppError::Cancelled => "cancelled",
            AppError::Io(_) => "io",
        }
    }

    pub fn to_dto(&self) -> AppErrorDto {
        AppErrorDto {
            kind: self.kind().to_string(),
            message: self.to_string(),
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;
