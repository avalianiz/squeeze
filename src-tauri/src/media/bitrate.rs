use crate::error::AppError;
use crate::models::CompressionSettings;

pub struct BitratePlan {
    pub video_bitrate_bps: u32,
    pub audio_bitrate_bps: u32,
}

// figure out how many bits sec we can spend on video
pub fn plan_bitrates(
    duration_seconds: f64,
    settings: &CompressionSettings,
) -> Result<BitratePlan, AppError> {
    if duration_seconds <= 0.0 {
        return Err(AppError::InvalidVideo("duration must be > 0".to_string()));
    }

    let audio_bitrate_bps = settings
        .audio_bitrate_kbps
        .saturating_mul(1000);

    // leave a little room for the mp4 container itself
    let usable_bytes = (settings.target_size_bytes as f64) * 0.97;
    let total_bits = usable_bytes * 8.0;
    let total_bitrate = total_bits / duration_seconds;

    if total_bitrate <= audio_bitrate_bps as f64 {
        return Err(AppError::TargetBitrateTooLow);
    }

    let video_bitrate = (total_bitrate - audio_bitrate_bps as f64).floor() as u32;
    // x264 gets sad / useless below this-ish
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
    fn discord_minute_clip_gets_sane_video_bitrate() {
        let settings = CompressionSettings::discord();
        let plan = plan_bitrates(60.0, &settings).expect("plan");
        // ~19.5mb / 60s minus audio should land in the low Mbps range
        assert!(plan.video_bitrate_bps > 1_000_000);
        assert!(plan.video_bitrate_bps < 3_500_000);
        assert_eq!(plan.audio_bitrate_bps, 128_000);
    }

    #[test]
    fn long_clip_bitrate_too_low() {
        let settings = CompressionSettings::discord();
        // like a whole movie into 19.5mb video bitrate collapses
        assert!(matches!(
            plan_bitrates(60.0 * 60.0 * 3.0, &settings),
            Err(AppError::TargetBitrateTooLow)
        ));
    }
}
