use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrimRange {
    pub start_seconds: f64,
    pub end_seconds: f64,
}

impl TrimRange {
    pub fn duration(&self) -> f64 {
        (self.end_seconds - self.start_seconds).max(0.0)
    }

    // make sure the sliders arent nonsense relative to the real clip length
    pub fn validate(&self, media_duration: f64) -> Result<(), AppError> {
        if !self.start_seconds.is_finite() || !self.end_seconds.is_finite() {
            return Err(AppError::InvalidTrimRange);
        }
        if self.start_seconds < 0.0 {
            return Err(AppError::InvalidTrimRange);
        }
        if self.end_seconds - self.start_seconds < 0.1 {
            return Err(AppError::InvalidTrimRange);
        }
        // tiny float slack so end==duration still passes
        if self.end_seconds > media_duration + 0.25 {
            return Err(AppError::InvalidTrimRange);
        }
        Ok(())
    }

    pub fn covers_whole(&self, media_duration: f64) -> bool {
        self.start_seconds <= 0.05 && self.end_seconds >= media_duration - 0.05
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_backwards_range() {
        let trim = TrimRange {
            start_seconds: 10.0,
            end_seconds: 9.0,
        };
        assert!(trim.validate(60.0).is_err());
    }

    #[test]
    fn accepts_normal_slice() {
        let trim = TrimRange {
            start_seconds: 2.0,
            end_seconds: 20.0,
        };
        assert!(trim.validate(60.0).is_ok());
        assert!((trim.duration() - 18.0).abs() < f64::EPSILON);
    }
}
