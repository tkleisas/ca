#pragma once

#include <vector>
#include <string>
#include <memory>
#include <array>

namespace yawn {

// ─── NAM Model Wrapper ───────────────────────────────
// Supports two backends:
//   a) RTNeural (header-only, fast inference)
//   b) Built-in fallback: analog-style preamp + EQ + poweramp chain
//
// NAM .nam files are loaded via:
//   python3 -m nam.util export-rtneural model.nam output.json
// Or converted manually to our simple binary format.

class NamModel {
public:
    NamModel() = default;
    ~NamModel() = default;

    // Load a model file
    bool load(const std::string& path);

    // Unload current model
    void unload();

    bool isLoaded() const { return m_loaded; }

    // Process a single sample
    float process(float input);

    // Process a buffer
    void processBlock(float* samples, int numSamples);

    // Set sample rate (for EQ coefficients)
    void setSampleRate(double sr);

    // Tone controls (0.0 = dark, 0.5 = flat, 1.0 = bright)
    void setTone(float value);
    void setToneFull(float bass, float mid, float treble, float presence);

    double sampleRate() const { return m_sampleRate; }
    const std::string& name() const { return m_name; }

    enum class Backend {
        Fallback,   // Built-in analog-modeled chain
        RTNeural,   // RTNeural inference
        None
    };
    
    Backend backend() const { return m_backend; }

private:
    bool m_loaded = false;
    double m_sampleRate = 48000.0;
    std::string m_name;
    Backend m_backend = Backend::Fallback;

    // ─── Fallback: Analog preamp chain ────────────────
    // Models a typical high-gain amp: boost → preamp → tonestack → poweramp → cab
    
    struct AnalogChain {
        // Preamp stages
        float preampGain1 = 2.0f;   // First gain stage
        float preampGain2 = 1.8f;   // Second gain stage
        float preampGain3 = 1.5f;   // Third gain stage
        
        // Tone stack (FMV-style biquad filters)
        float bass = 0.5f;          // 0..1
        float mid = 0.4f;           // 0..1
        float treble = 0.6f;        // 0..1
        
        // Power amp
        float presence = 0.5f;      // 0..1
        float depth = 0.3f;         // 0..1
        float masterVolume = 1.0f;  // 0..1
        
        // Cabinet (simple IIR filter)
        float cabLowCut = 80.0f;    // Hz
        float cabHighCut = 8000.0f; // Hz
        
        // ─── State ────────────────────────────────────
        // Biquad filter states
        struct BiquadState {
            float z1 = 0.0f, z2 = 0.0f;
        };
        
        BiquadState bassFilter;
        BiquadState midFilter;
        BiquadState trebleFilter;
        BiquadState presenceFilter;
        BiquadState cabLowFilter;
        BiquadState cabHighFilter;
        
        // DC blocker state
        float dcR = 0.0f;
        float dcY = 0.0f;
        
        // Power amp sag simulation
        float sagVoltage = 400.0f;
        float sagCurrent = 0.0f;
    };
    
    AnalogChain m_chain;
    
    // ─── RTNeural model data ──────────────────────────
    // Placeholder for RTNeural model
    std::vector<float> m_rtWeights;
    
    // ─── Analog chain processing ──────────────────────
    
    float processFallback(float input);
    
    // Biquad filter (direct form I)
    static float biquad(float x, AnalogChain::BiquadState& s,
                        float b0, float b1, float b2,
                        float a1, float a2);
    
    // Compute biquad coefficients for EQ bands
    void updateEQCoefficients();
    
    // Pre-computed biquad coefficients
    struct BiquadCoeffs {
        float b0, b1, b2, a1, a2;
    };
    
    BiquadCoeffs m_bassCoeffs = {};
    BiquadCoeffs m_midCoeffs = {};
    BiquadCoeffs m_trebleCoeffs = {};
    BiquadCoeffs m_presenceCoeffs = {};
    BiquadCoeffs m_cabLowCoeffs = {};
    BiquadCoeffs m_cabHighCoeffs = {};
};

// ─── Utility: compute biquad coefficients ─────────────

struct BiquadParams {
    float b0, b1, b2, a1, a2;
};

BiquadParams calcLowShelf(double freq, double gainDb, double Q, double fs);
BiquadParams calcPeakEQ(double freq, double gainDb, double Q, double fs);
BiquadParams calcHighShelf(double freq, double gainDb, double Q, double fs);
BiquadParams calcLowpass(double freq, double Q, double fs);
BiquadParams calcHighpass(double freq, double Q, double fs);

} // namespace yawn
