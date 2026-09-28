use crate::error::AppError;
use crate::models::CompressionSettings;

pub struct BitratePlan {
    pub video_bitrate_bps: u32,
    pub audio_bitrate_bps: u32,
}

pub fn plan_bitrates(
    duration_seconds: f64,
    settings: &CompressionSettings,
) -> Result<BitratePlan, AppError> {
    if duration_seconds <= 0.0 {
        return Err(AppError::InvalidVideo("duration must be > 0".to_string()));
    }

    let audio_bitrate_bps = settings.audio_bitrate_kbps.saturating_mul(1000);
    let usable_bytes = (settings.target_size_bytes as f64) * 0.97;
    let total_bits = usable_bytes * 8.0;
    let total_bitrate = total_bits / duration_seconds;

    if total_bitrate <= audio_bitrate_bps as f64 {
        return Err(AppError::TargetBitrateTooLow);
    }

    let video_bitrate = (total_bitrate - audio_bitrate_bps as f64).floor() as u32;
    if video_bitrate < 50_000 {
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
}
