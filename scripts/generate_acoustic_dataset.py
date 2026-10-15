"""
Acoustic Sonar Dataset Generator (SA-SLAM)
Generates physical room-impulse FMCW acoustic echo responses for smartphone echolocation.

Classes:
  0: SPECULAR_HARD (Wall, drywall, concrete, metal, glass)
  1: DIFFUSE_SCATTER (Desk, table, chair, pole, obstacle)
  2: ABSORPTIVE_SOFT (Bed, mattress, sofa, fabric, human)
  3: APERTURE_OPENING (Open doorway, hallway corridor, clear exit)
"""

import numpy as np
import os

FS = 48000           # 48 kHz sampling rate
C = 343.0            # Speed of sound (m/s)
CHIRP_DURATION = 0.02 # 20 ms
F_START = 18000.0    # 18 kHz
F_END = 22000.0      # 22 kHz
CHIRP_SAMPLES = int(FS * CHIRP_DURATION) # 960 samples
TOTAL_SAMPLES = 4800 # 100 ms recording window

def generate_reference_chirp():
    t = np.linspace(0, CHIRP_DURATION, CHIRP_SAMPLES, endpoint=False)
    k = (F_END - F_START) / CHIRP_DURATION
    chirp = np.sin(2.0 * np.pi * (F_START * t + 0.5 * k * t**2))
    # Apply 5% Tukey / Hann window to prevent edge clicks
    hann_len = int(CHIRP_SAMPLES * 0.1)
    window = np.ones(CHIRP_SAMPLES)
    window[:hann_len] = 0.5 * (1 - np.cos(np.pi * np.arange(hann_len) / hann_len))
    window[-hann_len:] = 0.5 * (1 - np.cos(np.pi * np.arange(hann_len)[::-1] / hann_len))
    return chirp * window

REF_CHIRP = generate_reference_chirp()

def compute_spectrogram_64x64(pcm_signal):
    """Computes exact 64x64 STFT spectrogram in 18kHz-22kHz ultrasound band."""
    n_fft = 256
    hop_length = (len(pcm_signal) - n_fft) // 63
    spec = np.zeros((64, 64), dtype=np.float32)

    # Frequency bin range corresponding to 17.5kHz - 22.5kHz
    min_bin = int(17500 / (FS / n_fft))
    max_bin = int(22500 / (FS / n_fft))
    freq_indices = np.linspace(min_bin, max_bin, 64).astype(int)

    for col in range(64):
        start = col * hop_length
        segment = pcm_signal[start:start + n_fft]
        if len(segment) < n_fft:
            padded = np.zeros(n_fft)
            padded[:len(segment)] = segment
            segment = padded
        # Apply Hanning window
        windowed = segment * np.hanning(n_fft)
        fft_mag = np.abs(np.fft.rfft(windowed))
        for r_idx, f_bin in enumerate(freq_indices):
            if f_bin < len(fft_mag):
                spec[r_idx, col] = fft_mag[f_bin]

    # Normalize to [0, 1]
    max_val = np.max(spec)
    if max_val > 1e-6:
        spec = spec / max_val
    return spec

def compute_envelope_2000(pcm_signal):
    """Computes 1D normalized cross-correlation envelope downsampled to 2000 samples."""
    corr = np.correlate(pcm_signal, REF_CHIRP, mode='full')
    analytic = np.abs(corr) # Hilbert approximation via magnitude
    # Downsample / resample to exactly 2000 points
    idx = np.linspace(0, len(analytic) - 1, 2000).astype(int)
    env = analytic[idx].astype(np.float32)
    max_val = np.max(env)
    if max_val > 1e-6:
        env = env / max_val
    return env

def simulate_echo_response(distance_m, material_class, noise_snr_db=20.0):
    """
    Simulates a 48 kHz acoustic reflection signal.
    """
    signal = np.zeros(TOTAL_SAMPLES, dtype=np.float32)

    # 1. Direct-path speaker-to-mic bleed (approx 10cm on phone body = ~0.29ms)
    direct_delay_samples = int((0.10 / C) * FS)
    direct_amp = np.random.uniform(0.7, 0.95)
    signal[direct_delay_samples:direct_delay_samples + CHIRP_SAMPLES] += REF_CHIRP * direct_amp

    # 2. Main reflection delay
    tof_seconds = (2.0 * distance_m) / C
    tof_samples = int(tof_seconds * FS)

    if material_class == 0:  # SPECULAR_HARD (Wall/Drywall/Glass/Metal)
        # Sharp specular reflection across full 18-22 kHz band
        refl_coeff = np.random.uniform(0.65, 0.90) / (distance_m ** 1.2)
        end = min(TOTAL_SAMPLES, tof_samples + CHIRP_SAMPLES)
        chirp_len = end - tof_samples
        if chirp_len > 0:
            signal[tof_samples:end] += REF_CHIRP[:chirp_len] * refl_coeff

    elif material_class == 1:  # DIFFUSE_SCATTER (Desk, Chair, Table, Pole)
        # Multi-point scattering with small delta delays
        num_scatters = np.random.randint(2, 5)
        for _ in range(num_scatters):
            delta_d = np.random.uniform(-0.15, 0.15)
            s_samples = int(((2.0 * (distance_m + delta_d)) / C) * FS)
            refl_coeff = np.random.uniform(0.35, 0.60) / (distance_m ** 1.3)
            end = min(TOTAL_SAMPLES, s_samples + CHIRP_SAMPLES)
            chirp_len = end - s_samples
            if chirp_len > 0 and s_samples >= 0:
                signal[s_samples:end] += REF_CHIRP[:chirp_len] * refl_coeff

    elif material_class == 2:  # ABSORPTIVE_SOFT (Bed, Sofa, Cloth, Human)
        # Ultrasonic absorption - heavily damps upper frequencies (> 20 kHz)
        refl_coeff = np.random.uniform(0.20, 0.45) / (distance_m ** 1.5)
        # Lowpass damped chirp
        damped_chirp = np.copy(REF_CHIRP)
        decay = np.linspace(1.0, 0.25, CHIRP_SAMPLES)
        damped_chirp = damped_chirp * decay
        end = min(TOTAL_SAMPLES, tof_samples + CHIRP_SAMPLES)
        chirp_len = end - tof_samples
        if chirp_len > 0:
            signal[tof_samples:end] += damped_chirp[:chirp_len] * refl_coeff

    elif material_class == 3:  # APERTURE_OPENING (Doorway / Open Corridor)
        # Frame echo (near edge) + deep secondary room reflection (> 1m behind)
        frame_coeff = np.random.uniform(0.35, 0.55) / (distance_m ** 1.2)
        end = min(TOTAL_SAMPLES, tof_samples + CHIRP_SAMPLES)
        chirp_len = end - tof_samples
        if chirp_len > 0:
            signal[tof_samples:end] += REF_CHIRP[:chirp_len] * frame_coeff

        # Secondary deep echo (1.0m to 2.2m beyond doorway)
        deep_dist = distance_m + np.random.uniform(1.0, 2.2)
        deep_samples = int(((2.0 * deep_dist) / C) * FS)
        deep_coeff = np.random.uniform(0.18, 0.35) / (deep_dist ** 1.3)
        end_deep = min(TOTAL_SAMPLES, deep_samples + CHIRP_SAMPLES)
        deep_len = end_deep - deep_samples
        if deep_len > 0 and deep_samples < TOTAL_SAMPLES:
            signal[deep_samples:end_deep] += REF_CHIRP[:deep_len] * deep_coeff

    # Add realistic room ambient noise
    noise_power = 10.0 ** (-noise_snr_db / 20.0)
    noise = np.random.normal(0, noise_power, TOTAL_SAMPLES).astype(np.float32)
    signal = signal + noise

    # Compute features
    spectrogram = compute_spectrogram_64x64(signal)
    envelope = compute_envelope_2000(signal)

    return spectrogram, envelope

def generate_dataset(num_samples_per_class=1250, save_path="data/sonar_dataset.npz"):
    """
    Generates balanced training dataset of 5,000 samples across 4 material classes.
    """
    os.makedirs(os.path.dirname(save_path), exist_ok=True)
    total = num_samples_per_class * 4
    spectrograms = np.zeros((total, 1, 64, 64), dtype=np.float32)
    envelopes = np.zeros((total, 1, 2000), dtype=np.float32)
    distances = np.zeros((total,), dtype=np.float32)
    labels = np.zeros((total,), dtype=np.int64)

    idx = 0
    print(f"Generating {total} synthetic Room Impulse Response acoustic samples...")

    for c in range(4):
        for _ in range(num_samples_per_class):
            dist = np.random.uniform(0.35, 3.80)
            snr = np.random.uniform(14.0, 32.0)
            spec, env = simulate_echo_response(dist, c, snr)

            spectrograms[idx, 0] = spec
            envelopes[idx, 0] = env
            distances[idx] = dist
            labels[idx] = c
            idx += 1

            if idx % 1000 == 0:
                print(f"  Generated {idx}/{total} samples...")

    np.savez_compressed(
        save_path,
        spectrograms=spectrograms,
        envelopes=envelopes,
        distances=distances,
        labels=labels
    )
    print(f"Dataset successfully saved to {save_path} ({total} samples).")

if __name__ == "__main__":
    generate_dataset()
