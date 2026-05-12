#include "nam_model.h"

#include <cmath>
#include <cstring>
#include <algorithm>

namespace yawn {

// ─── Model Loading ───────────────────────────────────

bool NamModel::load(const std::string& path) {
    unload();
    
    // Try loading as NAM directory first (config.json + weights/)
    m_wavenet = std::make_unique<wavenet::WaveNetEngine>();
    if (m_wavenet->loadModel(path, path + "/weights")) {
        m_backend = Backend::WaveNet;
        m_loaded = true;
        m_name = path.substr(path.find_last_of("/\\") + 1);
        m_sampleRate = m_wavenet->sampleRate();
        updateEQCoefficients();
        return true;
    }
    
    // Try loading as WaveNet binary model
    if (m_wavenet->loadBinary(path)) {
        m_backend = Backend::WaveNet;
        m_loaded = true;
        m_name = path.substr(path.find_last_of("/\\") + 1);
        m_sampleRate = m_wavenet->sampleRate();
        updateEQCoefficients();
        return true;
    }
    
    // Fallback: use analog-modeled chain
    m_wavenet.reset();
    m_backend = Backend::Fallback;
    m_loaded = true;
    m_name = path.substr(path.find_last_of("/\\") + 1);
    
    updateEQCoefficients();
    
    return true;
}

bool NamModel::loadNamDirectory(const std::string& dirPath) {
    return load(dirPath);
}

void NamModel::unload() {
    m_loaded = false;
    m_backend = Backend::None;
    m_rtWeights.clear();
}

void NamModel::setSampleRate(double sr) {
    m_sampleRate = sr;
    updateEQCoefficients();
}

void NamModel::setTone(float value) {
    // Map single tone knob to bass/mid/treble/presence
    // value < 0.5: cut highs, boost lows
    // value > 0.5: boost highs, cut lows
    float normalized = (value - 0.5f) * 2.0f; // -1..1
    
    m_chain.bass = 0.5f - normalized * 0.3f;
    m_chain.mid = 0.5f;
    m_chain.treble = 0.5f + normalized * 0.4f;
    m_chain.presence = 0.5f + normalized * 0.3f;
    
    updateEQCoefficients();
}

void NamModel::setToneFull(float bass, float mid, float treble, float presence) {
    m_chain.bass = bass;
    m_chain.mid = mid;
    m_chain.treble = treble;
    m_chain.presence = presence;
    updateEQCoefficients();
}

void NamModel::setMasterVolume(float vol) {
    m_chain.masterVolume = vol;
}

// ─── Processing ──────────────────────────────────────

float NamModel::process(float input) {
    if (!m_loaded) return input;
    
    switch (m_backend) {
        case Backend::Fallback:
            return processFallback(input);
        case Backend::WaveNet:
            return m_wavenet ? m_wavenet->process(input) : input;
        default:
            return input;
    }
}

void NamModel::processBlock(float* samples, int numSamples) {
    for (int i = 0; i < numSamples; ++i) {
        samples[i] = process(samples[i]);
    }
}

// ─── Fallback Analog Chain ───────────────────────────

float NamModel::processFallback(float input) {
    auto& c = m_chain;
    
    // ─── DC Blocker ───────────────────────────────────
    float dcX = input;
    float dcY = dcX - c.dcR + 0.995f * c.dcY;
    c.dcR = dcX;
    c.dcY = dcY;
    float sample = dcY;
    
    // ─── Preamp: cascaded gain stages with soft clipping ───
    
    // Stage 1: clean boost into asymmetric clip
    sample *= c.preampGain1;
    sample = std::tanh(sample * 0.8f) * 0.9f + sample * 0.1f; // blend clean/dirty
    
    // Stage 2: driven stage with tube-like asymmetry
    sample *= c.preampGain2;
    // Asymmetric soft clip (tube-like)
    if (sample > 1.0f) sample = 1.0f + 0.2f * std::tanh((sample - 1.0f) * 2.0f);
    else if (sample < -0.8f) sample = -0.8f + 0.3f * std::tanh((sample + 0.8f) * 2.5f);
    else sample = sample; // linear region
    
    // Stage 3: power amp driver
    sample *= c.preampGain3;
    sample = std::tanh(sample);
    
    // ─── Tone Stack ───────────────────────────────────
    
    // Bass shelf (100 Hz)
    sample = biquad(sample, c.bassFilter,
                    m_bassCoeffs.b0, m_bassCoeffs.b1, m_bassCoeffs.b2,
                    m_bassCoeffs.a1, m_bassCoeffs.a2);
    
    // Mid peak (750 Hz)
    sample = biquad(sample, c.midFilter,
                    m_midCoeffs.b0, m_midCoeffs.b1, m_midCoeffs.b2,
                    m_midCoeffs.a1, m_midCoeffs.a2);
    
    // Treble shelf (5 kHz)
    sample = biquad(sample, c.trebleFilter,
                    m_trebleCoeffs.b0, m_trebleCoeffs.b1, m_trebleCoeffs.b2,
                    m_trebleCoeffs.a1, m_trebleCoeffs.a2);
    
    // ─── Power Amp ────────────────────────────────────
    
    // Presence (4 kHz shelf)
    sample = biquad(sample, c.presenceFilter,
                    m_presenceCoeffs.b0, m_presenceCoeffs.b1, m_presenceCoeffs.b2,
                    m_presenceCoeffs.a1, m_presenceCoeffs.a2);
    
    // Master volume with power amp sag simulation
    c.sagVoltage += (400.0f - c.sagVoltage) * 0.001f; // sag recovery
    float sagDrop = std::abs(sample) * 50.0f;
    c.sagVoltage -= sagDrop * 0.01f;
    c.sagVoltage = std::max(200.0f, std::min(400.0f, c.sagVoltage));
    float sagFactor = c.sagVoltage / 400.0f;
    
    sample *= c.masterVolume * sagFactor;
    sample = std::tanh(sample); // power amp saturation
    
    // ─── Cabinet Simulation ───────────────────────────
    
    // Low cut (remove sub-bass rumble)
    sample = biquad(sample, c.cabLowFilter,
                    m_cabLowCoeffs.b0, m_cabLowCoeffs.b1, m_cabLowCoeffs.b2,
                    m_cabLowCoeffs.a1, m_cabLowCoeffs.a2);
    
    // High cut (speaker roll-off)
    sample = biquad(sample, c.cabHighFilter,
                    m_cabHighCoeffs.b0, m_cabHighCoeffs.b1, m_cabHighCoeffs.b2,
                    m_cabHighCoeffs.a1, m_cabHighCoeffs.a2);
    
    return sample;
}

// ─── Biquad Filter ───────────────────────────────────

float NamModel::biquad(float x, AnalogChain::BiquadState& s,
                       float b0, float b1, float b2,
                       float a1, float a2)
{
    float y = b0 * x + s.z1;
    s.z1 = b1 * x - a1 * y + s.z2;
    s.z2 = b2 * x - a2 * y;
    return y;
}

// ─── EQ Coefficient Update ───────────────────────────

void NamModel::updateEQCoefficients() {
    double fs = m_sampleRate;
    
    // Tone controls mapped to the chain parameters
    float bassDb = (m_chain.bass - 0.5f) * 24.0f;    // ±12 dB
    float midDb = (m_chain.mid - 0.5f) * 20.0f;       // ±10 dB
    float trebleDb = (m_chain.treble - 0.5f) * 24.0f; // ±12 dB
    float presenceDb = (m_chain.presence - 0.5f) * 18.0f; // ±9 dB
    
    auto bass = calcLowShelf(120.0, bassDb, 0.7, fs);
    m_bassCoeffs = {bass.b0, bass.b1, bass.b2, bass.a1, bass.a2};
    
    auto mid = calcPeakEQ(750.0, midDb, 1.0, fs);
    m_midCoeffs = {mid.b0, mid.b1, mid.b2, mid.a1, mid.a2};
    
    auto treble = calcHighShelf(5000.0, trebleDb, 0.7, fs);
    m_trebleCoeffs = {treble.b0, treble.b1, treble.b2, treble.a1, treble.a2};
    
    auto presence = calcHighShelf(4000.0, presenceDb, 0.5, fs);
    m_presenceCoeffs = {presence.b0, presence.b1, presence.b2, presence.a1, presence.a2};
    
    auto cabLow = calcHighpass(m_chain.cabLowCut, 0.707, fs);
    m_cabLowCoeffs = {cabLow.b0, cabLow.b1, cabLow.b2, cabLow.a1, cabLow.a2};
    
    auto cabHigh = calcLowpass(m_chain.cabHighCut, 0.707, fs);
    m_cabHighCoeffs = {cabHigh.b0, cabHigh.b1, cabHigh.b2, cabHigh.a1, cabHigh.a2};
}

// ─── Biquad Coefficient Calculators ──────────────────

BiquadParams calcLowShelf(double freq, double gainDb, double Q, double fs) {
    double A = std::pow(10.0, gainDb / 40.0);
    double w0 = 2.0 * M_PI * freq / fs;
    double cosW = std::cos(w0);
    double sinW = std::sin(w0);
    double alpha = sinW / (2.0 * Q);
    double beta = std::sqrt(A) * 2.0 * alpha;
    
    double a0 = (A + 1.0) + (A - 1.0) * cosW + beta;
    double b0 = A * ((A + 1.0) - (A - 1.0) * cosW + beta);
    double b1 = 2.0 * A * ((A - 1.0) - (A + 1.0) * cosW);
    double b2 = A * ((A + 1.0) - (A - 1.0) * cosW - beta);
    double a1 = -2.0 * ((A - 1.0) + (A + 1.0) * cosW);
    double a2 = (A + 1.0) + (A - 1.0) * cosW - beta;
    
    return {static_cast<float>(b0 / a0), static_cast<float>(b1 / a0),
            static_cast<float>(b2 / a0), static_cast<float>(a1 / a0),
            static_cast<float>(a2 / a0)};
}

BiquadParams calcPeakEQ(double freq, double gainDb, double Q, double fs) {
    double A = std::pow(10.0, gainDb / 40.0);
    double w0 = 2.0 * M_PI * freq / fs;
    double cosW = std::cos(w0);
    double sinW = std::sin(w0);
    double alpha = sinW / (2.0 * Q);
    
    double a0 = 1.0 + alpha / A;
    double b0 = 1.0 + alpha * A;
    double b1 = -2.0 * cosW;
    double b2 = 1.0 - alpha * A;
    double a1 = -2.0 * cosW;
    double a2 = 1.0 - alpha / A;
    
    return {static_cast<float>(b0 / a0), static_cast<float>(b1 / a0),
            static_cast<float>(b2 / a0), static_cast<float>(a1 / a0),
            static_cast<float>(a2 / a0)};
}

BiquadParams calcHighShelf(double freq, double gainDb, double Q, double fs) {
    double A = std::pow(10.0, gainDb / 40.0);
    double w0 = 2.0 * M_PI * freq / fs;
    double cosW = std::cos(w0);
    double sinW = std::sin(w0);
    double alpha = sinW / (2.0 * Q);
    double beta = std::sqrt(A) * 2.0 * alpha;
    
    double a0 = (A + 1.0) - (A - 1.0) * cosW + beta;
    double b0 = A * ((A + 1.0) + (A - 1.0) * cosW + beta);
    double b1 = -2.0 * A * ((A - 1.0) + (A + 1.0) * cosW);
    double b2 = A * ((A + 1.0) + (A - 1.0) * cosW - beta);
    double a1 = 2.0 * ((A - 1.0) - (A + 1.0) * cosW);
    double a2 = (A + 1.0) - (A - 1.0) * cosW - beta;
    
    return {static_cast<float>(b0 / a0), static_cast<float>(b1 / a0),
            static_cast<float>(b2 / a0), static_cast<float>(a1 / a0),
            static_cast<float>(a2 / a0)};
}

BiquadParams calcLowpass(double freq, double Q, double fs) {
    double w0 = 2.0 * M_PI * freq / fs;
    double cosW = std::cos(w0);
    double sinW = std::sin(w0);
    double alpha = sinW / (2.0 * Q);
    
    double a0 = 1.0 + alpha;
    double b0 = (1.0 - cosW) / 2.0;
    double b1 = 1.0 - cosW;
    double b2 = (1.0 - cosW) / 2.0;
    double a1 = -2.0 * cosW;
    double a2 = 1.0 - alpha;
    
    return {static_cast<float>(b0 / a0), static_cast<float>(b1 / a0),
            static_cast<float>(b2 / a0), static_cast<float>(a1 / a0),
            static_cast<float>(a2 / a0)};
}

BiquadParams calcHighpass(double freq, double Q, double fs) {
    double w0 = 2.0 * M_PI * freq / fs;
    double cosW = std::cos(w0);
    double sinW = std::sin(w0);
    double alpha = sinW / (2.0 * Q);
    
    double a0 = 1.0 + alpha;
    double b0 = (1.0 + cosW) / 2.0;
    double b1 = -(1.0 + cosW);
    double b2 = (1.0 + cosW) / 2.0;
    double a1 = -2.0 * cosW;
    double a2 = 1.0 - alpha;
    
    return {static_cast<float>(b0 / a0), static_cast<float>(b1 / a0),
            static_cast<float>(b2 / a0), static_cast<float>(a1 / a0),
            static_cast<float>(a2 / a0)};
}

} // namespace yawn
