#include "processor.h"
#include "version.h"

#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "base/source/fstreamer.h"

#include <cmath>
#include <algorithm>

namespace yawn {

// ─── YawnProcessor Implementation ────────────────────

YawnProcessor::YawnProcessor()
    : m_model(std::make_unique<NamModel>())
{
    // Register as VST3 audio effect
    setControllerClass(FUID(yawn::CONTROLLER_UID));
    
    // Initialize parameters to defaults
    for (int i = 0; i < kNumParams; ++i) {
        m_params[i] = static_cast<float>(kParamInfos[i].defaultValue);
    }
}

YawnProcessor::~YawnProcessor() = default;

tresult PLUGIN_API YawnProcessor::initialize(FUnknown* context) {
    tresult result = AudioEffect::initialize(context);
    if (result != kResultOk) return result;

    // Mono in, mono out
    addAudioInput(STR16("AudioInput"), Steinberg::Vst::SpeakerArr::kMono);
    addAudioOutput(STR16("AudioOutput"), Steinberg::Vst::SpeakerArr::kMono);

    return kResultOk;
}

tresult PLUGIN_API YawnProcessor::terminate() {
    m_model->unload();
    return AudioEffect::terminate();
}

tresult PLUGIN_API YawnProcessor::setBusArrangements(
    SpeakerArrangement* inputs, int32 numIns,
    SpeakerArrangement* outputs, int32 numOuts)
{
    // Accept mono → mono only
    if (numIns == 1 && numOuts == 1 &&
        inputs[0] == SpeakerArr::kMono &&
        outputs[0] == SpeakerArr::kMono)
    {
        return kResultOk;
    }
    return kResultFalse;
}

tresult PLUGIN_API YawnProcessor::setupProcessing(ProcessSetup& setup) {
    m_sampleRate = setup.sampleRate;
    m_smoothCoeff = std::exp(-1.0 / (kSmoothTime * m_sampleRate));
    return AudioEffect::setupProcessing(setup);
}

tresult PLUGIN_API YawnProcessor::setActive(TBool state) {
    if (state) {
        // Reset smoothing state
        m_currentInputGain = m_params[kParamInputGain];
        m_currentOutputLevel = m_params[kParamOutputLevel];
        m_currentTone = m_params[kParamTone];
    }
    return AudioEffect::setActive(state);
}

tresult PLUGIN_API YawnProcessor::process(ProcessData& data) {
    if (!data.inputs || !data.outputs) return kResultOk;
    if (data.inputs[0].numChannels < 1) return kResultOk;
    if (data.outputs[0].numChannels < 1) return kResultOk;

    // ─── Read parameter changes ───────────────────────
    if (data.inputParameterChanges) {
        int32 numParamsChanged = data.inputParameterChanges->getParameterCount();
        for (int32 i = 0; i < numParamsChanged; ++i) {
            auto* paramQueue = data.inputParameterChanges->getParameterData(i);
            if (!paramQueue) continue;
            
            int32 sampleOffset;
            double value;
            if (paramQueue->getPoint(0, sampleOffset, value) == kResultOk) {
                uint32_t paramId = paramQueue->getParameterId();
                if (paramId < kNumParams) {
                    m_params[paramId] = static_cast<float>(value);
                }
            }
        }
    }

    // ─── Check bypass ─────────────────────────────────
    if (m_params[kParamBypass] > 0.5f) {
        // Pass through
        float* in = data.inputs[0].channelBuffers32[0];
        float* out = data.outputs[0].channelBuffers32[0];
        if (in != out) {
            std::copy(in, in + data.numSamples, out);
        }
        return kResultOk;
    }

    // ─── Process audio ────────────────────────────────
    float* in = data.inputs[0].channelBuffers32[0];
    float* out = data.outputs[0].channelBuffers32[0];
    int32 numSamples = data.numSamples;

    // Smooth parameter transitions
    float targetInputGain = std::pow(10.0f, m_params[kParamInputGain] / 20.0f);
    float targetOutputLevel = std::pow(10.0f, m_params[kParamOutputLevel] / 20.0f);
    float targetBass = m_params[kParamBass];
    float targetMid = m_params[kParamMid];
    float targetTreble = m_params[kParamTreble];
    float targetPresence = m_params[kParamPresence];
    float targetMaster = m_params[kParamMaster];

    for (int32 i = 0; i < numSamples; ++i) {
        // Smooth (one-pole lowpass)
        m_currentInputGain += m_smoothCoeff * (targetInputGain - m_currentInputGain);
        m_currentOutputLevel += m_smoothCoeff * (targetOutputLevel - m_currentOutputLevel);
        m_currentBass += m_smoothCoeff * (targetBass - m_currentBass);
        m_currentMid += m_smoothCoeff * (targetMid - m_currentMid);
        m_currentTreble += m_smoothCoeff * (targetTreble - m_currentTreble);
        m_currentPresence += m_smoothCoeff * (targetPresence - m_currentPresence);
        m_currentMaster += m_smoothCoeff * (targetMaster - m_currentMaster);

        // Update model tone controls when any band changes
        if (m_currentBass != m_lastBass || m_currentMid != m_lastMid ||
            m_currentTreble != m_lastTreble || m_currentPresence != m_lastPresence) {
            m_lastBass = m_currentBass;
            m_lastMid = m_currentMid;
            m_lastTreble = m_currentTreble;
            m_lastPresence = m_currentPresence;
            m_model->setToneFull(m_currentBass, m_currentMid,
                                m_currentTreble, m_currentPresence);
        }
        if (m_currentMaster != m_lastMaster) {
            m_lastMaster = m_currentMaster;
            m_model->setMasterVolume(m_currentMaster);
        }

        float sample = in[i];
        
        // Apply input gain
        sample *= m_currentInputGain;
        
        // Run through NAM model
        sample = m_model->process(sample);
        
        // Apply output level
        sample *= m_currentOutputLevel;
        
        // Soft clip final output
        sample = std::tanh(sample);
        
        out[i] = sample;
    }

    return kResultOk;
}

tresult PLUGIN_API YawnProcessor::canProcessSampleSize(int32 symbolicSampleSize) {
    return symbolicSampleSize == Steinberg::Vst::kSample32
        ? kResultOk : kResultFalse;
}

// ─── State persistence ───────────────────────────────

tresult PLUGIN_API YawnProcessor::setState(IBStream* state) {
    if (!state) return kResultFalse;
    
    // Read parameter values
    for (int i = 0; i < kNumParams; ++i) {
        double val = 0.0;
        if (state->read(&val, sizeof(val)) != sizeof(val)) {
            return kResultFalse;
        }
        m_params[i] = static_cast<float>(val);
    }
    
    return kResultOk;
}

tresult PLUGIN_API YawnProcessor::getState(IBStream* state) {
    if (!state) return kResultFalse;
    
    // Write parameter values
    for (int i = 0; i < kNumParams; ++i) {
        double val = static_cast<double>(m_params[i]);
        if (state->write(&val, sizeof(val)) != sizeof(val)) {
            return kResultFalse;
        }
    }
    
    return kResultOk;
}

} // namespace yawn
