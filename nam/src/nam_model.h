#pragma once

#include <vector>
#include <string>
#include <memory>

namespace yawn {

// ─── NAM Model Wrapper ───────────────────────────────
// Loads trained Neural Amp Modeler weights and performs
// real-time inference using RTNeural or a simple feed-forward
// implementation.

class NamModel {
public:
    NamModel() = default;
    ~NamModel() = default;

    // Load a NAM model file (.nam)
    bool load(const std::string& path);

    // Unload current model
    void unload();

    // Check if a model is loaded
    bool isLoaded() const { return m_loaded; }

    // Process a single sample through the model
    // input: normalized audio sample (-1.0 to 1.0)
    // returns: normalized output sample
    float process(float input);

    // Process a buffer of samples
    void processBlock(float* samples, int numSamples);

    // Get the expected sample rate for this model
    double sampleRate() const { return m_sampleRate; }

    // Get model name (from metadata)
    const std::string& name() const { return m_name; }

private:
    bool m_loaded = false;
    double m_sampleRate = 48000.0;
    std::string m_name;

    // Simple 1D convolution + activation layers
    // Real NAM models use WaveNet-style dilated convolutions
    // For now: a basic LSTM-style processing chain
    
    float m_inputGain = 1.0f;
    float m_outputGain = 1.0f;
    
    // Pre/post EQ coefficients (simple biquad)
    float m_preBass = 0.0f;
    float m_preMid = 0.0f;
    float m_preTreble = 0.0f;
    
    // Placeholder for model weights
    // TODO: integrate RTNeural or ONNX runtime
    std::vector<float> m_weights;
    std::vector<float> m_biases;
    
    // Input buffer for context (NAM models need previous samples)
    std::vector<float> m_inputBuffer;
    static constexpr int kContextSize = 2048;
};

} // namespace yawn
