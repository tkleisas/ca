#include "nam_model.h"

#include <cmath>
#include <cstring>
#include <algorithm>

namespace yawn {

// ─── NAM Model Implementation ────────────────────────

bool NamModel::load(const std::string& path) {
    unload();
    
    // TODO: Load actual .nam file format
    // For now, initialize with identity pass-through
    m_loaded = true;
    m_name = path.substr(path.find_last_of("/\\") + 1);
    m_sampleRate = 48000.0;
    
    // Initialize context buffer
    m_inputBuffer.assign(kContextSize, 0.0f);
    
    return true;
}

void NamModel::unload() {
    m_loaded = false;
    m_weights.clear();
    m_biases.clear();
    m_inputBuffer.clear();
}

float NamModel::process(float input) {
    if (!m_loaded) return input;
    
    // Shift context buffer and add new sample
    std::memmove(m_inputBuffer.data(), m_inputBuffer.data() + 1,
                 (kContextSize - 1) * sizeof(float));
    m_inputBuffer[kContextSize - 1] = input * m_inputGain;
    
    // ─── Simple processing chain ──────────────────────
    // TODO: Replace with actual NAM model inference
    // using RTNeural or custom WaveNet implementation
    
    float output = input;
    
    // Apply gain
    output *= m_outputGain;
    
    // Soft clip
    output = std::tanh(output * 1.5f) / 1.5f;
    
    return output;
}

void NamModel::processBlock(float* samples, int numSamples) {
    for (int i = 0; i < numSamples; ++i) {
        samples[i] = process(samples[i]);
    }
}

} // namespace yawn
