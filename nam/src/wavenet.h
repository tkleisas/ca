#pragma once

#include <vector>
#include <string>
#include <memory>
#include <array>
#include <cmath>

// ─── Lightweight WaveNet Inference ────────────────────
// Implements the Neural Amp Modeler architecture directly
// without external ML framework dependencies.
//
// Architecture:
//   input → InputConv(1→ch, k=3) → [DilatedBlock × N] → Head → output
//
// Each DilatedBlock:
//   filter = tanh(Conv1D(x, dilation=d))
//   gate   = sigm(Conv1D(x, dilation=d))
//   x = filter * gate + residual
//
// Reference: https://github.com/sdatkinson/NeuralAmpModeler

namespace yawn {
namespace wavenet {

// ─── Layer Definition ────────────────────────────────

struct Conv1DWeights {
    std::vector<float> weight;  // [outCh][inCh][kernelSize] — flattened
    std::vector<float> bias;    // [outCh]
    int inChannels = 0;
    int outChannels = 0;
    int kernelSize = 3;
    int dilation = 1;
};

struct DilatedBlock {
    Conv1DWeights filterConv;  // channels → channels, dilated
    Conv1DWeights gateConv;    // channels → channels, dilated
    Conv1DWeights mixConv;     // channels → channels, 1×1
};

struct WaveNetModel {
    int inputChannels = 1;
    int channels = 16;         // hidden channels
    int numBlocks = 8;
    
    Conv1DWeights inputConv;   // 1 → channels
    std::vector<DilatedBlock> blocks;
    Conv1DWeights headConv;    // channels → 1
    
    // Metadata
    double sampleRate = 48000.0;
    std::string name;
    float loudness = 1.0f;
    
    // Pre-allocated inference buffers
    std::vector<float> inputBuffer;    // raw audio history (maxRF)
    std::vector<float> convState;      // channels × maxRF (per-channel history)
    std::vector<float> convBuffer;     // channels
    std::vector<float> filterBuffer;   // channels
    std::vector<float> gateBuffer;     // channels
    std::vector<float> skipBuffer;     // channels (skip connections accumulator)
    std::vector<float> headOutput;     // 1
    
    int receptiveField = 0;
    int inputPos = 0;                  // write position in circular buffers
};

// ─── WaveNet Engine ──────────────────────────────────

class WaveNetEngine {
public:
    WaveNetEngine() = default;
    ~WaveNetEngine() = default;
    
    // Load from NAM JSON config + numpy weights
    bool loadModel(const std::string& jsonPath, const std::string& weightsDir);
    
    // Load pre-converted model (simpler binary format)
    bool loadBinary(const std::string& path);
    
    bool isLoaded() const { return m_loaded; }
    double sampleRate() const { return m_model.sampleRate; }
    
    // Process single sample (real-time safe, no allocations)
    float process(float input);
    
    // Process buffer
    void processBlock(float* samples, int numSamples);
    
    // Reset internal state
    void reset();
    
private:
    WaveNetModel m_model;
    bool m_loaded = false;
    
    // Conv1D forward pass
    void conv1D(const Conv1DWeights& w,
                const float* input,
                float* output);
    
    // Apply activation
    static void applyTanh(float* x, int n);
    static void applySigmoid(float* x, int n);
    static void multiply(const float* a, const float* b, float* out, int n);
    static void add(const float* a, const float* b, float* out, int n);
};

} // namespace wavenet
} // namespace yawn
