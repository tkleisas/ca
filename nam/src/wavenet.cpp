#include "wavenet.h"

#include <cstring>
#include <algorithm>
#include <cmath>
#include <fstream>
#include <iostream>

namespace yawn {
namespace wavenet {

// ─── WaveNet Engine Implementation ────────────────────

bool WaveNetEngine::loadModel(const std::string& jsonPath,
                              const std::string& weightsDir)
{
    // TODO: Parse NAM config.json and load .npy weights
    // For now, initialize with identity pass-through
    reset();
    m_loaded = true;
    return true;
}

bool WaveNetEngine::loadBinary(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) return false;
    
    reset();
    
    // Read header
    auto& m = m_model;
    file.read(reinterpret_cast<char*>(&m.inputChannels), sizeof(int));
    file.read(reinterpret_cast<char*>(&m.channels), sizeof(int));
    file.read(reinterpret_cast<char*>(&m.numBlocks), sizeof(int));
    file.read(reinterpret_cast<char*>(&m.sampleRate), sizeof(double));
    file.read(reinterpret_cast<char*>(&m.loudness), sizeof(float));
    
    int nameLen = 0;
    file.read(reinterpret_cast<char*>(&nameLen), sizeof(int));
    m.name.resize(nameLen);
    file.read(m.name.data(), nameLen);
    
    // Helper: read Conv1D weights
    auto readConv = [&](Conv1DWeights& c) {
        file.read(reinterpret_cast<char*>(&c.inChannels), sizeof(int));
        file.read(reinterpret_cast<char*>(&c.outChannels), sizeof(int));
        file.read(reinterpret_cast<char*>(&c.kernelSize), sizeof(int));
        file.read(reinterpret_cast<char*>(&c.dilation), sizeof(int));
        
        int weightSize = c.outChannels * c.inChannels * c.kernelSize;
        c.weight.resize(weightSize);
        file.read(reinterpret_cast<char*>(c.weight.data()),
                  weightSize * sizeof(float));
        
        c.bias.resize(c.outChannels);
        file.read(reinterpret_cast<char*>(c.bias.data()),
                  c.outChannels * sizeof(float));
    };
    
    // Input conv
    readConv(m.inputConv);
    
    // Blocks
    m.blocks.resize(m.numBlocks);
    for (auto& block : m.blocks) {
        readConv(block.filterConv);
        readConv(block.gateConv);
        readConv(block.mixConv);
    }
    
    // Head conv
    readConv(m.headConv);
    
    if (!file) return false;
    
    // Allocate inference buffers
    m.receptiveField = 0;
    for (const auto& block : m.blocks) {
        int rf = (block.filterConv.kernelSize - 1) * block.filterConv.dilation + 1;
        if (rf > m.receptiveField) m.receptiveField = rf;
    }
    m.receptiveField += (m.inputConv.kernelSize - 1) + 1;
    
    m.inputBuffer.assign(m.receptiveField, 0.0f);
    m.convState.assign(m.channels * m.receptiveField, 0.0f);
    m.convBuffer.assign(m.channels, 0.0f);
    m.filterBuffer.assign(m.channels, 0.0f);
    m.gateBuffer.assign(m.channels, 0.0f);
    m.skipBuffer.assign(m.channels, 0.0f);
    m.headOutput.assign(1, 0.0f);
    m.inputPos = 0;
    
    m_loaded = true;
    return true;
}

void WaveNetEngine::reset() {
    m_loaded = false;
    m_model = WaveNetModel{};
}

// ─── Convolution ─────────────────────────────────────
// Uses circular buffer for per-channel state.
// state: [channels × RF] where state[ch * RF + pos] is the oldest sample
// inputPos: current write position in the circular buffer

void WaveNetEngine::conv1D(const Conv1DWeights& w,
                           const float* state,
                           float* output)
{
    const float* weight = w.weight.data();
    const float* bias = w.bias.data();
    int inCh = w.inChannels;
    int outCh = w.outChannels;
    int kSize = w.kernelSize;
    int dil = w.dilation;
    int RF = m_model.receptiveField;
    int pos = m_inputPos;
    
    for (int oc = 0; oc < outCh; ++oc) {
        float sum = bias[oc];
        for (int ic = 0; ic < inCh; ++ic) {
            for (int k = 0; k < kSize; ++k) {
                int offset = (RF - 1) - k * dil;  // from newest to oldest
                int idx = (ic * RF) + ((pos + offset) % RF);
                int weightIdx = ((oc * inCh) + ic) * kSize + k;
                sum += state[idx] * weight[weightIdx];
            }
        }
        output[oc] = sum;
    }
}

// ─── Single Sample Inference ─────────────────────────

float WaveNetEngine::process(float input) {
    if (!m_loaded) return input;
    
    auto& m = m_model;
    int RF = m.receptiveField;
    
    // ─── Write new input into circular buffers ─────────
    m.inputBuffer[m.inputPos] = input;
    
    // ─── Input convolution ────────────────────────────
    {
        const auto& w = m.inputConv;
        const float* weight = w.weight.data();
        const float* bias = w.bias.data();
        
        for (int oc = 0; oc < m.channels; ++oc) {
            float sum = (oc < w.outChannels) ? bias[oc] : 0.0f;
            for (int k = 0; k < w.kernelSize; ++k) {
                int offset = (RF - 1) - k;  // k=0 = newest
                int idx = (m.inputPos + offset) % RF;
                int weightIdx = oc * w.kernelSize + k;
                if (weightIdx < (int)w.weight.size()) {
                    sum += m.inputBuffer[idx] * weight[weightIdx];
                }
            }
            // Write to conv state for next stage
            m.convState[oc * RF + m.inputPos] = sum;
            m.convBuffer[oc] = sum;
        }
    }
    
    // ─── Dilated blocks ───────────────────────────────
    std::fill(m.skipBuffer.begin(), m.skipBuffer.end(), 0.0f);
    
    for (const auto& block : m.blocks) {
        // Filter path
        conv1D(block.filterConv, m.convState.data(), m.filterBuffer.data());
        applyTanh(m.filterBuffer.data(), m.channels);
        
        // Gate path
        conv1D(block.gateConv, m.convState.data(), m.gateBuffer.data());
        applySigmoid(m.gateBuffer.data(), m.channels);
        
        // Gated activation
        multiply(m.filterBuffer.data(), m.gateBuffer.data(),
                 m.filterBuffer.data(), m.channels);
        
        // Mix (1×1 conv) and add to skip connections
        conv1D(block.mixConv, m.convState.data(), m.filterBuffer.data());
        add(m.skipBuffer.data(), m.filterBuffer.data(),
            m.skipBuffer.data(), m.channels);
        
        // Update conv state with residual
        for (int ch = 0; ch < m.channels; ++ch) {
            m.convState[ch * RF + m.inputPos] = m.convBuffer[ch] + m.filterBuffer[ch];
            m.convBuffer[ch] = m.convState[ch * RF + m.inputPos];
        }
    }
    
    // ─── Head: mix skip connections to output ──────────
    // Head is a 1x1 conv: channels → 1
    {
        const auto& w = m.headConv;
        const float* weight = w.weight.data();
        const float* bias = w.bias.data();
        float sum = bias[0];
        for (int ic = 0; ic < m.channels && ic < w.inChannels; ++ic) {
            sum += m.skipBuffer[ic] * weight[ic];
        }
        m.headOutput[0] = sum;
    }
    
    float output = m.headOutput[0] * m.loudness;
    
    // ─── Advance circular buffer position ─────────────
    m.inputPos = (m.inputPos + 1) % RF;
    
    // Soft clip output
    output = std::tanh(output);
    
    return output;
}

void WaveNetEngine::processBlock(float* samples, int numSamples) {
    for (int i = 0; i < numSamples; ++i) {
        samples[i] = process(samples[i]);
    }
}

// ─── Activation Functions ─────────────────────────────

void WaveNetEngine::applyTanh(float* x, int n) {
    for (int i = 0; i < n; ++i) {
        x[i] = std::tanh(x[i]);
    }
}

void WaveNetEngine::applySigmoid(float* x, int n) {
    for (int i = 0; i < n; ++i) {
        // Fast sigmoid approximation
        float v = x[i];
        if (v >= 0.0f) {
            x[i] = 1.0f / (1.0f + std::exp(-v));
        } else {
            float ev = std::exp(v);
            x[i] = ev / (1.0f + ev);
        }
    }
}

void WaveNetEngine::multiply(const float* a, const float* b,
                              float* out, int n) {
    for (int i = 0; i < n; ++i) {
        out[i] = a[i] * b[i];
    }
}

void WaveNetEngine::add(const float* a, const float* b,
                         float* out, int n) {
    for (int i = 0; i < n; ++i) {
        out[i] = a[i] + b[i];
    }
}

} // namespace wavenet
} // namespace yawn
