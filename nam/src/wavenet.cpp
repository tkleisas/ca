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
    // Read config.json
    std::string configPath = jsonPath;
    if (configPath.find("config.json") == std::string::npos) {
        configPath += "/config.json";
    }
    
    std::ifstream configFile(configPath);
    if (!configFile) return false;
    
    std::string json((std::istreambuf_iterator<char>(configFile)),
                     std::istreambuf_iterator<char>());
    
    // Simple JSON parser for NAM config
    auto getInt = [&](const std::string& key, int def) -> int {
        auto pos = json.find("\"" + key + "\"");
        if (pos == std::string::npos) return def;
        pos = json.find(":", pos);
        if (pos == std::string::npos) return def;
        pos++;
        while (pos < (int)json.length() && (json[pos] == ' ' || json[pos] == '\n')) pos++;
        return std::stoi(json.substr(pos));
    };
    
    auto getFloat = [&](const std::string& key, float def) -> float {
        auto pos = json.find("\"" + key + "\"");
        if (pos == std::string::npos) return def;
        pos = json.find(":", pos);
        if (pos == std::string::npos) return def;
        pos++;
        while (pos < (int)json.length() && (json[pos] == ' ' || json[pos] == '\n')) pos++;
        return std::stof(json.substr(pos));
    };
    
    auto getStr = [&](const std::string& key, const std::string& def) -> std::string {
        auto pos = json.find("\"" + key + "\"");
        if (pos == std::string::npos) return def;
        pos = json.find("\"", pos + key.length() + 2);
        if (pos == std::string::npos) return def;
        pos++;
        auto end = json.find("\"", pos);
        if (end == std::string::npos) return def;
        return json.substr(pos, end - pos);
    };
    
    reset();
    
    auto& m = m_model;
    m.channels = getInt("channels", 16);
    m.numBlocks = getInt("num_blocks", 8);
    m.sampleRate = getFloat("sample_rate", 48000.0);
    m.name = getStr("name", "Unknown");
    m.loudness = getFloat("loudness", 1.0f);
    
    // Try different weight name patterns (NAM uses PyTorch naming conventions)
    auto loadW = [&](const std::string& name) -> npy::NpyArray {
        std::vector<std::string> patterns = {
            weightsDir + "/" + name + ".npy",
            weightsDir + "/net._" + name + ".npy",
            weightsDir + "/_net._" + name + ".npy",
        };
        for (const auto& p : patterns) {
            try { return npy::load(p); }
            catch (...) { /* try next */ }
        }
        throw std::runtime_error("Cannot find weights for: " + name);
    };
    
    auto loadConv = [&](const std::string& name, int dilation) -> Conv1DWeights {
        Conv1DWeights c;
        c.dilation = dilation;
        try {
            auto w = loadW(name + ".weight");
            c.outChannels = w.shape[0];
            c.inChannels = w.shape.size() > 1 ? w.shape[1] : 1;
            c.kernelSize = w.shape.size() > 2 ? w.shape[2] : 1;
            c.weight = w.data;
            
            auto b = loadW(name + ".bias");
            c.bias = b.data;
        } catch (...) {
            // Zero-init if missing
            c.weight.assign(c.outChannels * c.inChannels * c.kernelSize, 0.0f);
            c.bias.assign(c.outChannels, 0.0f);
        }
        return c;
    };
    
    try {
        // Input convolution
        m.inputConv = loadConv("input_conv", 1);
        
        // Dilated blocks
        m.blocks.resize(m.numBlocks);
        int dilations[] = {1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048};
        
        for (int i = 0; i < m.numBlocks; ++i) {
            int dil = dilations[std::min(i, (int)(sizeof(dilations)/sizeof(dilations[0])) - 1)];
            auto& block = m.blocks[i];
            
            block.filterConv = loadConv("blocks." + std::to_string(i) + ".filter_conv", dil);
            block.gateConv   = loadConv("blocks." + std::to_string(i) + ".gate_conv", dil);
            block.mixConv    = loadConv("blocks." + std::to_string(i) + ".mix_conv", 1);
        }
        
        // Head convolution
        m.headConv = loadConv("head_conv", 1);
        
    } catch (const std::exception& e) {
        // If any weight loading fails, return false for fallback
        reset();
        return false;
    }
    
    // Allocate inference buffers
    m.receptiveField = 0;
    for (const auto& block : m.blocks) {
        int rf = (block.filterConv.kernelSize - 1) * block.filterConv.dilation + 1;
        if (rf > m.receptiveField) m.receptiveField = rf;
    }
    m.receptiveField += (m.inputConv.kernelSize - 1) + 1;
    m.receptiveField = std::max(m.receptiveField, 1);
    
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
