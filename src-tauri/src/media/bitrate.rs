use crate::error::AppError;
use crate::models::{CompressionSettings, PlanPreview};

pub struct BitratePlan {
    pub video_bitrate_bps: u32,
    pub audio_bitrate_bps: u32,
}

const ABSOLUTE_MIN_VIDEO_BPS: u32 = 50_000;

pub fn plan_bitrates(
    duration_seconds: f64,
    settings: &CompressionSettings,
) -> Result<BitratePlan, AppError> {
    if duration_seconds <= 0.0 {
        return Err(AppError::InvalidVideo("duration must be > 0".to_string()));
    }

    let audio_bitrate_bps = settings.effective_audio_bitrate_kbps().saturating_mul(1000);
    let usable_bytes = (settings.target_size_bytes as f64) * 0.97;
    let total_bits = usable_bytes * 8.0;
    let total_bitrate = total_bits / duration_seconds;

    if total_bitrate <= audio_bitrate_bps as f64 {
        return Err(AppError::TargetBitrateTooLow);
    }

    let video_bitrate = (total_bitrate - audio_bitrate_bps as f64).floor() as u32;
    if video_bitrate < ABSOLUTE_MIN_VIDEO_BPS {
        return Err(AppError::TargetBitrateTooLow);
    }

    Ok(BitratePlan {
        video_bitrate_bps: video_bitrate,
        audio_bitrate_bps,
    })
}

pub fn scale_video_bitrate(plan: &BitratePlan, factor: f64) -> BitratePlan {
    BitratePlan {
        video_bitrate_bps: ((plan.video_bitrate_bps as f64) * factor).floor() as u32,
        audio_bitrate_bps: plan.audio_bitrate_bps,
    }
}

fn quality_floor_bps(max_height: Option<u32>) -> u32 {
    match max_height {
        Some(h) if h <= 720 => 400_000,
        Some(h) if h <= 1080 => 800_000,
        _ => 1_200_000,
    }
}

fn format_mbps(bps: u32) -> String {
    let mbps = bps as f64 / 1_000_000.0;
    if mbps >= 10.0 {
        format!("{:.0} Mbps", mbps)
    } else if mbps >= 1.0 {
        format!("{:.1} Mbps", mbps)
    } else {
        format!("{:.0} kbps", bps as f64 / 1000.0)
    }
}

fn format_duration_short(seconds: f64) -> String {
    let total = seconds.max(0.0).round() as u64;
    if total >= 3600 {
        let h = total / 3600;
        let m = (total % 3600) / 60;
        let s = total % 60;
        format!("{h}h {m}m {s}s")
    } else if total >= 60 {
        let m = total / 60;
        let s = total % 60;
        if s == 0 {
            format!("{m}m")
        } else {
            format!("{m}m {s}s")
        }
    } else {
        format!("{total}s")
    }
}

fn format_target_mb(bytes: u64) -> String {
    let mb = bytes as f64 / (1024.0 * 1024.0);
    if (mb - mb.round()).abs() < 0.05 {
        format!("{:.0} MB", mb.round())
    } else {
        format!("{mb:.1} MB")
    }
}

fn min_target_bytes_for(duration_seconds: f64, audio_kbps: u32) -> u64 {
    let audio_bps = audio_kbps.saturating_mul(1000) as f64;
    let needed_bps = ABSOLUTE_MIN_VIDEO_BPS as f64 + audio_bps + 1.0;
    let bytes = (needed_bps * duration_seconds / 8.0) / 0.97;
    bytes.ceil() as u64
}

struct FitCandidate {
    label: &'static str,
    max_width: Option<u32>,
    max_height: Option<u32>,
    max_fps: Option<u32>,
}

const FIT_LADDER: &[FitCandidate] = &[
    FitCandidate {
        label: "1080p",
        max_width: Some(1920),
        max_height: Some(1080),
        max_fps: None,
    },
    FitCandidate {
        label: "1080p · 60 fps",
        max_width: Some(1920),
        max_height: Some(1080),
        max_fps: Some(60),
    },
    FitCandidate {
        label: "1080p · 30 fps",
        max_width: Some(1920),
        max_height: Some(1080),
        max_fps: Some(30),
    },
    FitCandidate {
        label: "720p",
        max_width: Some(1280),
        max_height: Some(720),
        max_fps: None,
    },
    FitCandidate {
        label: "720p · 60 fps",
        max_width: Some(1280),
        max_height: Some(720),
        max_fps: Some(60),
    },
    FitCandidate {
        label: "720p · 30 fps",
        max_width: Some(1280),
        max_height: Some(720),
        max_fps: Some(30),
    },
];

fn suggest_fit_for_bitrate(video_bps: u32, settings: &CompressionSettings) -> Option<&'static FitCandidate> {
    let current_floor = quality_floor_bps(settings.max_height);
    if video_bps >= current_floor {
        return None;
    }

    FIT_LADDER.iter().find(|fit| {
        let tighter = match (settings.max_height, fit.max_height) {
            (None, Some(_)) => true,
            (Some(cur), Some(next)) if next < cur => true,
            (Some(cur), Some(next)) if next == cur => match (settings.max_fps, fit.max_fps) {
                (None, Some(_)) => true,
                (Some(a), Some(b)) => b < a,
                _ => false,
            },
            _ => false,
        };
        tighter && video_bps >= quality_floor_bps(fit.max_height)
    })
}

pub fn preview_plan(duration_seconds: f64, settings: &CompressionSettings) -> PlanPreview {
    let audio_bitrate_bps = settings.effective_audio_bitrate_kbps().saturating_mul(1000);
    let duration_label = format_duration_short(duration_seconds);
    let target_label = format_target_mb(settings.target_size_bytes);

    match plan_bitrates(duration_seconds, settings) {
        Ok(plan) => {
            let mut suggested_fit_label = None;
            let mut suggested_max_width = None;
            let mut suggested_max_height = None;
            let mut suggested_max_fps = None;

            if let Some(fit) = suggest_fit_for_bitrate(plan.video_bitrate_bps, settings) {
                suggested_fit_label = Some(fit.label.to_string());
                suggested_max_width = fit.max_width;
                suggested_max_height = fit.max_height;
                suggested_max_fps = fit.max_fps;
            }

            let message = if let Some(ref label) = suggested_fit_label {
                format!(
                    "{duration_label} · about {} video · about {target_label}. Low for this resolution; try {label}.",
                    format_mbps(plan.video_bitrate_bps)
                )
            } else {
                format!(
                    "{duration_label} · about {} video · about {target_label}",
                    format_mbps(plan.video_bitrate_bps)
                )
            };

            PlanPreview {
                ok: true,
                duration_seconds,
                target_size_bytes: settings.target_size_bytes,
                video_bitrate_bps: Some(plan.video_bitrate_bps),
                audio_bitrate_bps: plan.audio_bitrate_bps,
                message,
                squeeze_blocked: false,
                suggested_fit_label,
                suggested_max_width,
                suggested_max_height,
                suggested_max_fps,
                suggested_mute: false,
                suggested_target_mb: None,
            }
        }
        Err(_) => {
            let mut suggested_mute = false;
            let mut suggested_target_mb = None;
            let message;

            if !settings.mute_audio {
                let mut muted = settings.clone();
                muted.mute_audio = true;
                muted.audio_bitrate_kbps = 0;
                if plan_bitrates(duration_seconds, &muted).is_ok() {
                    suggested_mute = true;
                    message = format!(
                        "{duration_label} is too long for {target_label} with audio. Mute audio or raise the target."
                    );
                } else {
                    let min_bytes =
                        min_target_bytes_for(duration_seconds, 0);
                    let min_mb = ((min_bytes as f64) / (1024.0 * 1024.0)).ceil() as u32;
                    suggested_target_mb = Some(min_mb.max(1));
                    message = format!(
                        "{duration_label} is too long for {target_label}. Try about {min_mb} MB, a shorter trim, or mute audio."
                    );
                }
            } else {
                let min_bytes = min_target_bytes_for(duration_seconds, 0);
                let min_mb = ((min_bytes as f64) / (1024.0 * 1024.0)).ceil() as u32;
                suggested_target_mb = Some(min_mb.max(1));
                message = format!(
                    "{duration_label} is too long for {target_label}. Try about {min_mb} MB or a shorter trim."
                );
            }

            // Even when blocked, suggest a tighter fit so the levers below are obvious.
            let mut suggested_fit_label = None;
            let mut suggested_max_width = None;
            let mut suggested_max_height = None;
            let mut suggested_max_fps = None;
            if let Some(fit) = FIT_LADDER.last() {
                if settings.max_height != fit.max_height || settings.max_fps != fit.max_fps {
                    suggested_fit_label = Some(fit.label.to_string());
                    suggested_max_width = fit.max_width;
                    suggested_max_height = fit.max_height;
                    suggested_max_fps = fit.max_fps;
                }
            }

            PlanPreview {
                ok: false,
                duration_seconds,
                target_size_bytes: settings.target_size_bytes,
                video_bitrate_bps: None,
                audio_bitrate_bps,
                message,
                squeeze_blocked: true,
                suggested_fit_label,
                suggested_max_width,
                suggested_max_height,
                suggested_max_fps,
                suggested_mute,
                suggested_target_mb,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minute_clip_gets_usable_video_bitrate() {
        let settings = CompressionSettings::default_target();
        let plan = plan_bitrates(60.0, &settings).expect("plan");
        assert!(plan.video_bitrate_bps > 1_000_000);
        assert!(plan.video_bitrate_bps < 3_500_000);
        assert_eq!(plan.audio_bitrate_bps, 128_000);
    }

    #[test]
    fn long_clip_bitrate_too_low() {
        let settings = CompressionSettings::default_target();
        assert!(matches!(
            plan_bitrates(60.0 * 60.0 * 3.0, &settings),
            Err(AppError::TargetBitrateTooLow)
        ));
    }

    #[test]
    fn mute_frees_audio_budget() {
        let mut settings = CompressionSettings::default_target();
        settings.mute_audio = true;
        settings.audio_bitrate_kbps = 0;
        let plan = plan_bitrates(60.0, &settings).expect("plan");
        assert_eq!(plan.audio_bitrate_bps, 0);
        assert!(plan.video_bitrate_bps > 2_500_000);
    }

    #[test]
    fn preview_blocks_long_clip() {
        let settings = CompressionSettings::default_target();
        let preview = preview_plan(60.0 * 60.0 * 3.0, &settings);
        assert!(!preview.ok);
        assert!(preview.squeeze_blocked);
        assert!(preview.suggested_mute || preview.suggested_target_mb.is_some());
    }

    #[test]
    fn preview_ok_for_short_clip() {
        let settings = CompressionSettings::default_target();
        let preview = preview_plan(14.0, &settings);
        assert!(preview.ok);
        assert!(!preview.squeeze_blocked);
        assert!(preview.message.contains("14s"));
        assert!(preview.message.contains("MB"));
        assert!(!preview.message.contains('\u{2014}'));
        assert!(!preview.message.contains('\u{2192}'));
    }
}
