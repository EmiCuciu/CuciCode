pub const WHISPER_SAMPLE_RATE: u32 = 16_000;

/// Converts interleaved samples at any rate and channel count to the mono 16 kHz
/// signal whisper expects, averaging channels and resampling by linear interpolation.
pub fn to_mono_16k(samples: &[f32], channels: u16, sample_rate: u32) -> Vec<f32> {
    let channels = usize::from(channels.max(1));
    let mono: Vec<f32> = samples
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect();
    if sample_rate == WHISPER_SAMPLE_RATE || mono.is_empty() || sample_rate == 0 {
        return mono;
    }
    let ratio = f64::from(sample_rate) / f64::from(WHISPER_SAMPLE_RATE);
    let output_len = (mono.len() as f64 / ratio).floor() as usize;
    (0..output_len)
        .map(|index| {
            let position = index as f64 * ratio;
            let left = position.floor() as usize;
            let right = (left + 1).min(mono.len() - 1);
            let fraction = (position - left as f64) as f32;
            mono[left] * (1.0 - fraction) + mono[right] * fraction
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn averages_stereo_frames_into_mono() {
        assert_eq!(to_mono_16k(&[1.0, 0.0, 0.5, 0.5, -1.0, 1.0], 2, 16_000), vec![0.5, 0.5, 0.0]);
    }

    #[test]
    fn downsamples_48k_to_a_third_of_the_length() {
        let input: Vec<f32> = (0..4800).map(|index| index as f32).collect();
        let output = to_mono_16k(&input, 1, 48_000);
        assert_eq!(output.len(), 1600);
        assert_eq!(output[0], 0.0);
        assert_eq!(output[1], 3.0);
        assert_eq!(output[1599], 4797.0);
    }

    #[test]
    fn upsamples_8k_by_interpolating_between_samples() {
        let output = to_mono_16k(&[0.0, 1.0, 2.0], 1, 8_000);
        assert_eq!(output, vec![0.0, 0.5, 1.0, 1.5, 2.0, 2.0]);
    }

    #[test]
    fn empty_input_stays_empty_and_incomplete_frames_are_dropped() {
        assert!(to_mono_16k(&[], 2, 44_100).is_empty());
        assert_eq!(to_mono_16k(&[0.2, 0.4, 0.9], 2, 16_000).len(), 1);
    }
}
