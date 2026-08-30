use serde::Serialize;
use tauri::AppHandle;

use crate::domain::error::AppResult;
use crate::ffmpeg::sidecar::ffmpeg_stdout_bytes;

/// Low sample rate is plenty for a waveform + silence envelope, and keeps the
/// decoded PCM small.
const SAMPLE_RATE: u32 = 8000;
const BUCKET_MS: u32 = 25;
/// dBFS floor for silent/empty buckets.
const DB_FLOOR: f32 = -90.0;

/// Per-bucket audio summary the editor draws and derives cuts from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAnalysis {
    pub duration: f64,
    pub bucket_ms: u32,
    /// Max |amplitude| per bucket, 0..1 (waveform).
    pub peaks: Vec<f32>,
    /// RMS loudness per bucket in dBFS (negative; floored at DB_FLOOR).
    pub envelope_db: Vec<f32>,
}

/// Decode the audio to mono f32 PCM and reduce it to per-bucket peaks + loudness.
pub async fn analyze_audio(
    app: &AppHandle,
    input_path: &str,
    duration: f64,
) -> AppResult<AudioAnalysis> {
    let bytes = ffmpeg_stdout_bytes(
        app,
        &[
            "-hide_banner", "-vn", "-i", input_path,
            "-ac", "1",
            "-ar", &SAMPLE_RATE.to_string(),
            "-f", "f32le", "-",
        ],
    )
    .await?;

    let samples = bytes_to_f32(&bytes);
    let (peaks, envelope_db) = bucketize(&samples, SAMPLE_RATE, BUCKET_MS);
    Ok(AudioAnalysis { duration, bucket_ms: BUCKET_MS, peaks, envelope_db })
}

fn bytes_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Reduce raw samples into (peaks, envelope_db) per fixed-duration bucket.
fn bucketize(samples: &[f32], rate: u32, bucket_ms: u32) -> (Vec<f32>, Vec<f32>) {
    let per = ((rate as u64 * bucket_ms as u64) / 1000).max(1) as usize;
    let mut peaks = Vec::with_capacity(samples.len() / per + 1);
    let mut env = Vec::with_capacity(peaks.capacity());

    for chunk in samples.chunks(per) {
        let peak = chunk.iter().fold(0f32, |m, &s| m.max(s.abs())).min(1.0);
        let mean_sq = chunk.iter().map(|&s| (s as f64) * (s as f64)).sum::<f64>()
            / chunk.len().max(1) as f64;
        let rms = mean_sq.sqrt();
        let db = if rms > 0.0 { (20.0 * rms.log10()) as f32 } else { DB_FLOOR };
        peaks.push(peak);
        env.push(db.max(DB_FLOOR));
    }
    (peaks, env)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_to_f32_roundtrip() {
        let mut bytes = Vec::new();
        for v in [0.0f32, 0.5, -1.0] {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        assert_eq!(bytes_to_f32(&bytes), vec![0.0, 0.5, -1.0]);
    }

    #[test]
    fn bucketize_peak_and_db() {
        // 8000 Hz, 25 ms → 200 samples/bucket. One bucket of full-scale 1.0.
        let samples = vec![1.0f32; 200];
        let (peaks, env) = bucketize(&samples, 8000, 25);
        assert_eq!(peaks.len(), 1);
        assert_eq!(peaks[0], 1.0);
        assert!((env[0] - 0.0).abs() < 0.01, "full-scale RMS ≈ 0 dBFS, got {}", env[0]);
    }

    #[test]
    fn bucketize_silence_floors_db() {
        let samples = vec![0.0f32; 200];
        let (peaks, env) = bucketize(&samples, 8000, 25);
        assert_eq!(peaks[0], 0.0);
        assert_eq!(env[0], DB_FLOOR);
    }

    #[test]
    fn bucketize_half_scale_is_about_minus_6db() {
        let samples = vec![0.5f32; 200];
        let (_, env) = bucketize(&samples, 8000, 25);
        assert!((env[0] - (-6.02)).abs() < 0.1, "got {}", env[0]);
    }
}
