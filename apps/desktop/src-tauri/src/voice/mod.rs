mod audio;

use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::error::{AppError, AppResult};
use audio::{to_mono_16k, WHISPER_SAMPLE_RATE};

pub const DOWNLOAD_EVENT: &str = "voice://download";
const MODEL_FILE: &str = "ggml-base.bin";
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
const MODEL_MAX_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_RECORDING_SECONDS: usize = 300;
const MIN_RECORDING_SAMPLES: usize = WHISPER_SAMPLE_RATE as usize / 3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub model_ready: bool,
    pub recording: bool,
    pub model_path: String,
}

#[derive(Debug, Clone, Serialize)]
struct DownloadProgress {
    received: u64,
    total: Option<u64>,
}

struct Captured {
    samples: Vec<f32>,
    channels: u16,
    sample_rate: u32,
}

struct Recording {
    stop: mpsc::Sender<()>,
    thread: JoinHandle<Captured>,
}

/// Push-to-talk speech-to-text that runs entirely on this machine.
pub struct Voice {
    model_dir: PathBuf,
    recording: Mutex<Option<Recording>>,
    context: Mutex<Option<Arc<WhisperContext>>>,
}

fn voice_error(message: impl std::fmt::Display) -> AppError {
    AppError::Invalid(format!("voice: {message}"))
}

fn append<T>(data: &[T], buffer: &Mutex<Vec<f32>>, limit: usize)
where
    T: Sample,
    f32: FromSample<T>,
{
    if let Ok(mut samples) = buffer.lock() {
        if samples.len() < limit {
            samples.extend(data.iter().map(|sample| f32::from_sample(*sample)));
        }
    }
}

struct Microphone {
    stream: cpal::Stream,
    buffer: Arc<Mutex<Vec<f32>>>,
    channels: u16,
    sample_rate: u32,
}

fn open_microphone() -> Result<Microphone, String> {
    let device = cpal::default_host().default_input_device().ok_or("no microphone found")?;
    let config = device.default_input_config().map_err(|error| format!("cannot read the microphone format: {error}"))?;
    let channels = config.channels();
    let sample_rate = config.sample_rate();
    let limit = sample_rate as usize * usize::from(channels) * MAX_RECORDING_SECONDS;
    let buffer = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&buffer);
    let on_error = |error: cpal::Error| eprintln!("[voice] stream error: {error}");
    let stream = match config.sample_format() {
        SampleFormat::I8 => device.build_input_stream(config.into(), move |data: &[i8], _: &_| append(data, &sink, limit), on_error, None),
        SampleFormat::I16 => device.build_input_stream(config.into(), move |data: &[i16], _: &_| append(data, &sink, limit), on_error, None),
        SampleFormat::I32 => device.build_input_stream(config.into(), move |data: &[i32], _: &_| append(data, &sink, limit), on_error, None),
        SampleFormat::F32 => device.build_input_stream(config.into(), move |data: &[f32], _: &_| append(data, &sink, limit), on_error, None),
        other => return Err(format!("unsupported microphone sample format {other}")),
    }
    .map_err(|error| format!("cannot open the microphone: {error}"))?;
    stream.play().map_err(|error| format!("cannot start recording: {error}"))?;
    Ok(Microphone { stream, buffer, channels, sample_rate })
}

fn capture(stop: mpsc::Receiver<()>, started: mpsc::Sender<Result<(), String>>) -> Captured {
    match open_microphone() {
        Ok(microphone) => {
            let _ = started.send(Ok(()));
            let _ = stop.recv();
            drop(microphone.stream);
            let samples = microphone.buffer.lock().map(|mut samples| std::mem::take(&mut *samples)).unwrap_or_default();
            Captured { samples, channels: microphone.channels, sample_rate: microphone.sample_rate }
        }
        Err(message) => {
            let _ = started.send(Err(message));
            Captured { samples: Vec::new(), channels: 1, sample_rate: WHISPER_SAMPLE_RATE }
        }
    }
}

impl Voice {
    pub fn new(model_dir: PathBuf) -> Self {
        Self { model_dir, recording: Mutex::new(None), context: Mutex::new(None) }
    }

    fn model_path(&self) -> PathBuf {
        self.model_dir.join(MODEL_FILE)
    }

    pub fn status(&self) -> VoiceStatus {
        VoiceStatus {
            model_ready: self.model_path().is_file(),
            recording: self.recording.lock().map(|recording| recording.is_some()).unwrap_or(false),
            model_path: self.model_path().display().to_string(),
        }
    }

    pub fn download_model(&self, app: &AppHandle) -> AppResult<()> {
        let target = self.model_path();
        if target.is_file() {
            return Ok(());
        }
        fs::create_dir_all(&self.model_dir)?;
        let partial = target.with_extension("bin.part");
        let mut response = ureq::get(MODEL_URL).call().map_err(|error| voice_error(format!("model download failed: {error}")))?;
        let total = response.body().content_length();
        let mut reader = response.body_mut().with_config().limit(MODEL_MAX_BYTES).reader();
        let mut file = fs::File::create(&partial)?;
        let mut chunk = vec![0u8; 256 * 1024];
        let mut received = 0u64;
        let mut reported = 0u64;
        loop {
            let read = reader.read(&mut chunk)?;
            if read == 0 {
                break;
            }
            file.write_all(&chunk[..read])?;
            received += read as u64;
            if received - reported >= 2 * 1024 * 1024 {
                reported = received;
                let _ = app.emit(DOWNLOAD_EVENT, DownloadProgress { received, total });
            }
        }
        file.flush()?;
        drop(file);
        if total.is_some_and(|expected| expected != received) {
            let _ = fs::remove_file(&partial);
            return Err(voice_error("model download was incomplete; try again"));
        }
        fs::rename(&partial, &target)?;
        let _ = app.emit(DOWNLOAD_EVENT, DownloadProgress { received, total });
        Ok(())
    }

    pub fn start(&self) -> AppResult<()> {
        if !self.model_path().is_file() {
            return Err(voice_error("the speech model is not downloaded yet"));
        }
        let mut recording = self.recording.lock().map_err(|_| voice_error("recorder state is poisoned"))?;
        if recording.is_some() {
            return Ok(());
        }
        let (stop, stop_receiver) = mpsc::channel();
        let (started, started_receiver) = mpsc::channel();
        let thread = std::thread::spawn(move || capture(stop_receiver, started));
        match started_receiver.recv() {
            Ok(Ok(())) => {
                *recording = Some(Recording { stop, thread });
                Ok(())
            }
            Ok(Err(message)) => Err(voice_error(message)),
            Err(_) => Err(voice_error("the recording thread ended unexpectedly")),
        }
    }

    pub fn stop_and_transcribe(&self) -> AppResult<String> {
        let recording = self.recording.lock().map_err(|_| voice_error("recorder state is poisoned"))?.take();
        let Some(recording) = recording else {
            return Ok(String::new());
        };
        let _ = recording.stop.send(());
        let captured = recording.thread.join().map_err(|_| voice_error("the recording thread panicked"))?;
        let audio = to_mono_16k(&captured.samples, captured.channels, captured.sample_rate);
        if audio.len() < MIN_RECORDING_SAMPLES {
            return Ok(String::new());
        }
        self.transcribe(&audio)
    }

    fn context(&self) -> AppResult<Arc<WhisperContext>> {
        let mut cached = self.context.lock().map_err(|_| voice_error("model state is poisoned"))?;
        if let Some(context) = cached.as_ref() {
            return Ok(Arc::clone(context));
        }
        let path = self.model_path();
        let context = WhisperContext::new_with_params(&path, WhisperContextParameters::default())
            .map_err(|error| voice_error(format!("cannot load the speech model: {error}")))?;
        let context = Arc::new(context);
        *cached = Some(Arc::clone(&context));
        Ok(context)
    }

    fn transcribe(&self, audio: &[f32]) -> AppResult<String> {
        let context = self.context()?;
        let mut state = context.create_state().map_err(voice_error)?;
        let threads = std::thread::available_parallelism().map_or(4, |count| count.get().min(8));
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("auto"));
        params.set_n_threads(threads as i32);
        params.set_no_context(true);
        params.set_suppress_blank(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        state.full(params, audio).map_err(voice_error)?;
        let text: Vec<String> = state.as_iter().map(|segment| segment.to_string().trim().to_owned()).collect();
        Ok(text.join(" ").trim().to_owned())
    }
}
