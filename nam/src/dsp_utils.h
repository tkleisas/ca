#pragma once

#include <vector>
#include <array>
#include <cmath>
#include <algorithm>

namespace yawn {
namespace dsp {

// ─── 2x Oversampling ────────────────────────────────
// Half-band FIR filter for 2x up/down sampling
// Filter design: 32-tap half-band (passband ripple < 0.001 dB)

class OverSampler2x {
public:
    OverSampler2x() { reset(); }
    
    void reset() {
        for (auto& s : upState) s = 0.0f;
        for (auto& s : downState) s = 0.0f;
    }
    
    // Upsample: in[0..n-1] → out[0..2n-1] (interleaved zeros + filter)
    void upsample(const float* in, float* out, int n) {
        // Build zero-stuffed buffer in temp storage (out is modified in-place
        // by the filter, so we must read original values from a separate buffer)
        m_stuffed.resize(2 * n);
        for (int i = 0; i < n; ++i) {
            m_stuffed[i * 2] = in[i];
            m_stuffed[i * 2 + 1] = 0.0f;
        }
        // Apply anti-imaging filter — read from stuffed, write to out
        for (int i = 0; i < 2 * n; ++i) {
            float sum = 0.0f;
            for (int j = 0; j < kTaps; ++j) {
                int idx = i - j;
                if (idx >= 0 && idx < 2 * n) {
                    sum += m_stuffed[idx] * kHalfBand[j];
                } else if (idx < 0 && (-idx - 1) < (int)kUpHistory) {
                    sum += upState[(-idx - 1) % kUpHistory] * kHalfBand[j];
                }
            }
            // Store in history for next block
            upState[upPos] = m_stuffed[i];
            upPos = (upPos + 1) % kUpHistory;
            out[i] = sum * 2.0f; // compensate for zero-stuffing gain
        }
    }
    
    // Downsample: in[0..2n-1] → out[0..n-1] (filter + decimate)
    void downsample(const float* in, float* out, int n) {
        int tempLen = 2 * n;
        m_temp.resize(tempLen);
        
        // Apply anti-aliasing filter
        for (int i = 0; i < tempLen; ++i) {
            float sum = 0.0f;
            for (int j = 0; j < kTaps; ++j) {
                int idx = i - j;
                if (idx >= 0 && idx < tempLen) {
                    sum += in[idx] * kHalfBand[j];
                } else if (idx < 0 && (-idx - 1) < (int)kDownHistory) {
                    sum += downState[(-idx - 1) % kDownHistory] * kHalfBand[j];
                }
            }
            m_temp[i] = sum;
        }
        
        // Update history
        for (int i = 0; i < std::min(tempLen, (int)kDownHistory); ++i) {
            downState[(downPos + i) % kDownHistory] = in[tempLen - 1 - i];
        }
        downPos = (downPos + tempLen) % kDownHistory;
        
        // Decimate: take every 2nd sample
        for (int i = 0; i < n; ++i) {
            out[i] = m_temp[i * 2];
        }
    }
    
private:
    static constexpr int kTaps = 32;
    static constexpr int kUpHistory = kTaps;
    static constexpr int kDownHistory = kTaps;
    
    // Half-band filter coefficients (32-tap, 80 dB stopband)
    static constexpr float kHalfBand[kTaps] = {
        0.000442f, 0.000000f, -0.001191f, 0.000000f,
        0.002558f, 0.000000f, -0.004774f, 0.000000f,
        0.008170f, 0.000000f, -0.013377f, 0.000000f,
        0.021855f, 0.000000f, -0.037667f, 0.000000f,
        0.077015f, 0.500000f, 0.077015f, 0.000000f,
        -0.037667f, 0.000000f, 0.021855f, 0.000000f,
        -0.013377f, 0.000000f, 0.008170f, 0.000000f,
        -0.004774f, 0.000000f, 0.002558f, 0.000000f
    };
    
    float upState[kUpHistory] = {};
    float downState[kDownHistory] = {};
    int upPos = 0, downPos = 0;
};

// ─── Noise Gate ──────────────────────────────────────

class NoiseGate {
public:
    NoiseGate() { reset(); }
    
    void reset() {
        m_gain = 0.0f;
        m_rmsAccum = 0.0f;
        m_rmsIdx = 0;
        std::fill(m_rmsBuffer.begin(), m_rmsBuffer.end(), 0.0f);
    }
    
    void setThreshold(float db) { m_threshold = std::pow(10.0f, db / 20.0f); }
    void setAttack(float ms, double sr) { m_attackCoeff = std::exp(-1.0 / (ms * 0.001 * sr)); }
    void setRelease(float ms, double sr) { m_releaseCoeff = std::exp(-1.0 / (ms * 0.001 * sr)); }
    
    float process(float input) {
        // Running RMS
        float sq = input * input;
        m_rmsAccum += sq - m_rmsBuffer[m_rmsIdx];
        m_rmsBuffer[m_rmsIdx] = sq;
        m_rmsIdx = (m_rmsIdx + 1) % kRmsWindow;
        float rms = std::sqrt(std::max(0.0f, m_rmsAccum / kRmsWindow));
        
        float target = (rms > m_threshold) ? 1.0f : 0.0f;
        float coeff = (target > m_gain) ? m_attackCoeff : m_releaseCoeff;
        m_gain += coeff * (target - m_gain);
        
        return input * m_gain;
    }
    
    void processBlock(float* samples, int n) {
        for (int i = 0; i < n; ++i) samples[i] = process(samples[i]);
    }
    
private:
    static constexpr int kRmsWindow = 64;
    std::array<float, kRmsWindow> m_rmsBuffer = {};
    float m_rmsAccum = 0.0f;
    int m_rmsIdx = 0;
    float m_gain = 0.0f;
    float m_threshold = 0.01f;
    float m_attackCoeff = 0.9f;
    float m_releaseCoeff = 0.99f;
};

// ─── Cabinet IR Loader ───────────────────────────────

class CabSim {
public:
    CabSim() { reset(); }
    
    void reset() {
        m_irPos = 0;
        m_irLoaded = false;
    }
    
    // Load a WAV IR file (mono, any sample rate)
    bool loadIR(const std::string& path, double pluginSampleRate);
    
    // Load from raw float array
    void loadFromData(const float* data, int len, double irSampleRate, double pluginSampleRate);
    
    bool isLoaded() const { return m_irLoaded; }
    
    // Process sample through IR via direct convolution
    float process(float input) {
        if (!m_irLoaded) return input;
        
        m_irBuffer[m_irPos] = input;
        m_irPos = (m_irPos + 1) % m_irLen;
        
        float sum = 0.0f;
        for (int i = 0; i < m_irLen; ++i) {
            int idx = (m_irPos + i) % m_irLen;
            sum += m_irBuffer[idx] * m_irData[i];
        }
        return sum;
    }
    
    void processBlock(float* samples, int n) {
        for (int i = 0; i < n; ++i) samples[i] = process(samples[i]);
    }
    
private:
    std::vector<float> m_irData;
    std::vector<float> m_irBuffer;
    int m_irLen = 0;
    int m_irPos = 0;
    bool m_irLoaded = false;
};

} // namespace dsp
} // namespace yawn
